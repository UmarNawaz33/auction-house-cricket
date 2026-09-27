/* ============================================================
   tests/auth.test.js — the login/sign-out fix: ensureAnonymousAuth() must
   never reuse a real (non-anonymous) session left over from another portal
   on this browser, and signOutAll()/doSignOut() must genuinely finish
   Firebase's sign-out before the page treats the user as logged out and
   allows a new sign-in attempt. Both were previously unchecked — neither
   had a stub capable of exercising them at all.

   Run this after touching: js/shared.js's ensureAnonymousAuth()/signOutAll(),
   or any page's doSignOut().
   ============================================================ */
const { ctxFor, evalIn } = require('./lib/dom-stub');
const { makeSuite, printSummary } = require('./lib/suite');

async function run(){
  const suite = makeSuite('auth');

  suite.section('ensureAnonymousAuth: reuses an existing anonymous user');
  {
    const ctx = ctxFor(['js/shared.js']);
    ctx.__auth.setCurrentUser({ uid: 'anon-existing', isAnonymous: true });
    const user = await evalIn(ctx, 'ensureAnonymousAuth()');
    suite.check('resolves with that same user', user.uid === 'anon-existing', 'got ' + JSON.stringify(user));
    suite.check('never called setPersistence', ctx.__auth.persistenceCalls.length === 0);
  }

  suite.section('ensureAnonymousAuth: does NOT reuse a real (non-anonymous) session');
  {
    const ctx = ctxFor(['js/shared.js']);
    // e.g. an admin still signed in from another tab, via Firebase's shared
    // LOCAL persistence — this is the exact scenario that used to corrupt a
    // moderator/team session with the admin's own uid.
    ctx.__auth.setCurrentUser({ uid: 'real-admin-uid', isAnonymous: false });
    const user = await evalIn(ctx, 'ensureAnonymousAuth()');
    suite.check('does not resolve with the admin uid', user.uid !== 'real-admin-uid', 'got ' + JSON.stringify(user));
    suite.check('resolves with a genuinely anonymous user', user.isAnonymous === true);
    suite.check('scoped the new identity to this tab (SESSION persistence)',
      ctx.__auth.persistenceCalls.includes('SESSION'), JSON.stringify(ctx.__auth.persistenceCalls));
  }

  suite.section('ensureAnonymousAuth: Anonymous sign-in disabled in the Firebase console');
  {
    const ctx = ctxFor(['js/shared.js']);
    ctx.__auth.failNextAnonymousSignIn({ code: 'auth/admin-restricted-operation', message: 'This operation is restricted to administrators only.' });
    let error = null;
    try{ await evalIn(ctx, 'ensureAnonymousAuth()'); }
    catch(e){ error = e; }
    suite.check('rejects (does not silently succeed)', error !== null);
    suite.check('does not surface Firebase\'s cryptic text verbatim',
      error && !/administrators only/i.test(error.message), error && error.message);
    suite.check('names the actual fix: the Firebase console setting',
      error && /anonymous/i.test(error.message) && /console/i.test(error.message), error && error.message);
  }

  suite.section('the friendly message actually reaches the login screen');
  {
    const ctx = ctxFor(['js/shared.js', 'js/moderator.js']);
    ctx.__auth.failNextAnonymousSignIn({ code: 'auth/admin-restricted-operation', message: 'This operation is restricted to administrators only.' });
    evalIn(ctx, "document.getElementById('modKeyInput').value = 'MOD-TEST01';");
    await evalIn(ctx, 'enterModKey()');
    const shown = evalIn(ctx, "document.getElementById('gateErr').textContent");
    suite.check('gate shows the friendly text, not Firebase\'s raw error', /anonymous/i.test(shown) && /console/i.test(shown), shown);
  }

  suite.section('ensureAnonymousAuth: no existing user at all signs in fresh');
  {
    const ctx = ctxFor(['js/shared.js']);
    const user = await evalIn(ctx, 'ensureAnonymousAuth()');
    suite.check('resolves with a fresh anonymous user', user && user.isAnonymous === true);
  }

  suite.section('signOutAll: genuinely awaits auth.signOut()');
  {
    const ctx = ctxFor(['js/shared.js']);
    ctx.__auth.setCurrentUser({ uid: 'anon-1', isAnonymous: true });
    const release = ctx.__auth.holdSignOut();
    let resolved = false;
    const p = evalIn(ctx, 'signOutAll()').then(() => { resolved = true; });
    await Promise.resolve(); await Promise.resolve(); // let pending microtasks drain
    suite.check('does not resolve while signOut is still pending', resolved === false);
    release();
    await p;
    suite.check('resolves once signOut actually completes', resolved === true);
  }

  /** Shared shape for the three doSignOut() scenarios below. */
  async function checkDoSignOutAwaits(suite, label, files, seed, sessionVarExpr){
    suite.section(label);
    const ctx = ctxFor(files);
    evalIn(ctx, seed);
    ctx.__auth.setCurrentUser({ uid: 'anon-1', isAnonymous: true });
    const release = ctx.__auth.holdSignOut();
    const p = evalIn(ctx, 'doSignOut()');
    await Promise.resolve(); await Promise.resolve();
    suite.check('session is NOT cleared while sign-out is still pending',
      evalIn(ctx, sessionVarExpr) !== null, 'expected still-truthy session mid sign-out');
    release();
    await p;
    suite.check('session IS cleared once sign-out actually completes',
      evalIn(ctx, sessionVarExpr) === null);
  }

  await checkDoSignOutAwaits(
    suite, 'admin.js doSignOut() awaits sign-out before clearing its session',
    ['js/shared.js', 'js/admin.js'],
    `adminState.session = {role:'admin', label:'me@x.com'};`,
    'adminState.session'
  );

  await checkDoSignOutAwaits(
    suite, 'team.js doSignOut() awaits sign-out before clearing its session',
    ['js/shared.js', 'js/team.js'],
    `tSession = {role:'team', teamId:'t1', label:'Lions'};`,
    'tSession'
  );

  await checkDoSignOutAwaits(
    suite, 'moderator.js doSignOut() awaits sign-out before clearing its session',
    ['js/shared.js', 'js/moderator.js'],
    `session = {role:'moderator', label:'Mod'};`,
    'session'
  );

  return suite.summarize();
}

module.exports = { name: 'auth', run };

if (require.main === module){
  run().then(summary => process.exit(printSummary(summary)));
}
