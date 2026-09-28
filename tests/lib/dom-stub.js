/* ============================================================
   tests/lib/dom-stub.js — the one Firebase+DOM stub every test in this
   folder builds its VM context from. Consolidated from six near-duplicate
   copies that had drifted slightly from each other across the redesign
   sessions; keep it that way; the actual thing being tested is our own
   render code, running unmodified.

   ctxFor(files) loads the given js/*.js files (relative to the repo root)
   into a fresh vm context and returns it, plus:
     ctx.__writes    — every db.ref(path).set()/update() call, as {op,path,value}
     ctx.__toasts    — every toast(msg,type) call, as [type, msg]
     ctx.__signOuts  — one entry per real auth.signOut() *call* (pushed
                       synchronously at call time, before the promise settles)
     ctx.__audio     — one entry per Audio.play() call, as the src string
     ctx.__auth      — control surface for the Firebase Auth stub; see below
   All reset per call to ctxFor(); nothing persists between tests.

   The auth stub is a real (if tiny) state machine, not a no-op, because
   ensureAnonymousAuth()/signOutAll() in shared.js have real async ordering
   and isAnonymous-checking behavior worth testing (see tests/auth.test.js).
   `ctx.__auth`:
     .setCurrentUser({uid, isAnonymous}) — seed a "signed in" user as if a
        previous page load (or another tab, via shared localStorage
        persistence) had already authenticated, before any code under test
        calls onAuthStateChanged/ensureAnonymousAuth.
     .holdSignOut() — makes the NEXT auth.signOut() call return a promise
        that won't resolve until you call the function this returns. Lets a
        test prove code genuinely awaits sign-out rather than racing ahead.
     .persistenceCalls — array of every auth.setPersistence(mode) argument.
   ============================================================ */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..') + path.sep;

function makeEl(){
  return {
    _html: '',
    set innerHTML(v){ this._html = String(v); },
    get innerHTML(){ return this._html; },
    value: '', textContent: '', src: '', disabled: false, files: [], style: {},
    classList: { add(){}, remove(){}, toggle(){ return true; } },
    setAttribute(){}, appendChild(){}, remove(){}, querySelector(){ return makeEl(); },
  };
}

/**
 * Build a fresh VM context with the given files (paths relative to the repo
 * root, e.g. 'js/shared.js') evaluated into it in order.
 */
function ctxFor(files){
  const writes = [];
  const toasts = [];
  const signOuts = []; // one entry per real auth.signOut() call
  const audio = [];    // one src per play() call
  const elCache = {};

  const sandbox = {
    console, setTimeout: (fn) => { if (fn) fn(); return 0; }, clearTimeout,
    Math, Date, JSON, Object, Array, String, Number, Boolean,
    isNaN, parseInt, parseFloat, Set, Promise, Error,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL(){} },
    Blob: function(){},
    // Enough of HTMLAudioElement for the sold-hammer sound in moderator.js:
    // records what was played so a test can assert it fired (and, just as
    // importantly, that it did NOT fire on unsold/assign).
    Audio: function(src){
      this.src = src;
      this.currentTime = 0;
      this.play = () => { audio.push(src); return Promise.resolve(); };
    },
  };
  sandbox.window = sandbox;
  sandbox.document = {
    getElementById: (id) => (elCache[id] = elCache[id] || makeEl()),
    createElement: () => makeEl(),
    querySelector: () => makeEl(),
    body: { appendChild(){} },
    head: { appendChild(){} },
    documentElement: { setAttribute(){}, classList: { add(){} } },
  };

  function ref(refPath){
    return {
      on(){}, once(){ return Promise.resolve({ val: () => null }); },
      set(value){ writes.push({ op: 'set', path: refPath, value }); return Promise.resolve(); },
      update(value){ writes.push({ op: 'update', path: refPath, value }); return Promise.resolve(); },
      remove(){ writes.push({ op: 'remove', path: refPath }); return Promise.resolve(); },
      push(){ return { key: 'test-push-key' }; },
      limitToLast(){ return ref(refPath); },
      onDisconnect(){
        return { update(value){ writes.push({ op: 'onDisconnect', path: refPath, value }); return Promise.resolve(); } };
      },
    };
  }
  // ---- Auth stub: real enough to test ordering and isAnonymous handling ----
  let currentUser = null;
  let anonCounter = 0;
  const authListeners = [];
  const persistenceCalls = [];
  let heldSignOut = null; // {promise, release} while a test is holding one open
  let anonymousSignInError = null; // set to a {code,message}-shaped error to simulate a rejected signInAnonymously()

  function notifyAuthListeners(){
    for (const cb of authListeners.slice()) cb(currentUser);
  }
  const authObj = {
    onAuthStateChanged(cb){
      authListeners.push(cb);
      // Real Firebase invokes the callback asynchronously with the current
      // state as soon as it's known — never synchronously within the same
      // call. A synchronous invocation here would hide ordering bugs a real
      // browser would never let through.
      Promise.resolve().then(() => cb(currentUser));
      return () => {
        const i = authListeners.indexOf(cb);
        if (i !== -1) authListeners.splice(i, 1);
      };
    },
    signInAnonymously(){
      if (anonymousSignInError){
        const err = anonymousSignInError;
        anonymousSignInError = null;
        return Promise.reject(err);
      }
      currentUser = { uid: 'anon-' + (++anonCounter), isAnonymous: true };
      notifyAuthListeners();
      return Promise.resolve({ user: currentUser });
    },
    signInWithEmailAndPassword(email){
      currentUser = { uid: 'admin-uid-for-' + email, isAnonymous: false, email };
      notifyAuthListeners();
      return Promise.resolve({ user: currentUser });
    },
    setPersistence(mode){
      persistenceCalls.push(mode);
      return Promise.resolve();
    },
    signOut(){
      signOuts.push(true); // logged at CALL time, matching real fire-and-forget usage
      if (heldSignOut){
        const { promise } = heldSignOut;
        heldSignOut = null;
        return promise.then(() => { currentUser = null; notifyAuthListeners(); });
      }
      currentUser = null;
      notifyAuthListeners();
      return Promise.resolve();
    },
  };

  sandbox.firebase = {
    initializeApp(){},
    auth: Object.assign(() => authObj, {
      Auth: { Persistence: { SESSION: 'SESSION', LOCAL: 'LOCAL', NONE: 'NONE' } },
    }),
    database: () => ({ ref: (p) => ref(p === undefined ? '/' : p) }),
  };
  sandbox.sessionStorage = { getItem: () => null, setItem(){}, removeItem(){} };
  sandbox.FIREBASE_CONFIG = {};

  const ctx = vm.createContext(sandbox);
  for (const f of files){
    vm.runInContext(fs.readFileSync(ROOT + f, 'utf8'), ctx, { filename: f });
  }
  // toast() is defined in shared.js; override it after load so callers can
  // inspect what the app tried to tell the user, without changing behavior.
  vm.runInContext('if (typeof toast === "function") { var __realToast = toast; }', ctx);
  ctx.__toasts = toasts;
  ctx.__writes = writes;
  ctx.__signOuts = signOuts;
  ctx.__audio = audio;
  ctx.__auth = {
    setCurrentUser(user){ currentUser = user; },
    get persistenceCalls(){ return persistenceCalls; },
    holdSignOut(){
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      heldSignOut = { promise };
      return release;
    },
    /** Makes the NEXT signInAnonymously() call reject with this error, e.g.
     *  {code:'auth/admin-restricted-operation', message:'...'} — simulating
     *  Anonymous sign-in being disabled in the Firebase console. */
    failNextAnonymousSignIn(err){ anonymousSignInError = err; },
  };
  vm.runInContext('toast = function(m, t){ __toasts.push([t || "info", m]); };', ctx);

  return ctx;
}

/** Run `code` inside ctx and return its value — a thin wrapper for readability. */
function evalIn(ctx, code){
  return vm.runInContext(code, ctx, { filename: 'eval' });
}

/** Balance-check the tag structure of a rendered HTML fragment; returns an error string or null. */
const VOID_TAGS = new Set(['img','input','br','hr','meta','link','source']);
function tagBalanceError(html){
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(html))){
    const [, closing, tag, selfClose] = m;
    const lower = tag.toLowerCase();
    if (VOID_TAGS.has(lower) || selfClose) continue;
    if (closing){
      if (!stack.length) return `stray </${tag}>`;
      const top = stack.pop();
      if (top !== tag) return `</${tag}> closes <${top}>`;
    } else {
      stack.push(tag);
    }
  }
  return stack.length ? `unclosed <${stack.join('>, <')}>` : null;
}

module.exports = { ctxFor, evalIn, tagBalanceError, ROOT };
