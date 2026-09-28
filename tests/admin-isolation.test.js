/* ============================================================
   tests/admin-isolation.test.js — guard: the moderator's pause/complete
   machinery must not touch the admin page. Admin sign-out must write
   nothing to the DB, admin must never arm the disconnect-pause, and admin's
   UI must keep working no matter what state the auction is in.

   Run this after any change to js/admin.js's sign-out/session handling, or
   to the pause/complete functions in js/moderator.js (to confirm they're
   still absent from admin.js — if this ever fails because a shared helper
   moved into shared.js, that's fine; update the "has no X()" list here).
   ============================================================ */
const { ctxFor, evalIn } = require('./lib/dom-stub');
const { makeSuite, printSummary } = require('./lib/suite');

async function run(){
  const suite = makeSuite('admin-isolation');
  const DONE = { currentPlayerId: null, biddingOpen: false, paused: true, pauseReason: 'signout', completed: true, completedAt: 1 };

  const ctx = ctxFor(['js/shared.js', 'js/admin.js']);
  evalIn(ctx, `adminState={session:{role:'admin',label:'me@x.com'},settings:{currencyUnit:'Cr',minPlayersPerTeam:0,maxPlayersPerTeam:5,defaultBasePrice:1,bidIncrement:1},
    teams:{t1:{name:'Lions',budget:100,squad:{}}},players:{},auction:${JSON.stringify(DONE)},sales:[],keys:{}};`);

  suite.section('disconnect handling');
  ctx.__writes.length = 0;
  evalIn(ctx, 'attachAdminListeners();');
  const disconnectWrites = ctx.__writes.filter(w => w.op === 'onDisconnect');
  suite.check('admin never arms disconnect-pause', disconnectWrites.length === 0, 'found: ' + JSON.stringify(disconnectWrites));

  suite.section('sign-out');
  ctx.__writes.length = 0;
  ctx.__signOuts.length = 0;
  ctx.__auth.setCurrentUser({ uid: 'admin-uid', isAnonymous: false });
  // doSignOut() is genuinely async now (it awaits Firebase's sign-out before
  // clearing local state — see tests/auth.test.js) so this must be awaited
  // too, or every assertion below would run before it's actually finished.
  await evalIn(ctx, 'doSignOut()');
  suite.check('admin sign-out writes nothing to the DB', ctx.__writes.length === 0, 'wrote: ' + JSON.stringify(ctx.__writes));
  suite.check('admin sign-out does sign out', ctx.__signOuts.length === 1);
  suite.check('admin sign-out clears its session', evalIn(ctx, 'adminState.session===null'));
  suite.check('admin sign-out renders the login screen', /Organizer Sign In/.test(ctx.document.getElementById('tabContent').innerHTML));

  suite.section('admin UI keeps working while paused + completed');
  evalIn(ctx, `adminState.session={role:'admin',label:'me@x.com'};`);
  const tabs = [['keys', 'renderKeys'], ['teams', 'renderTeamsTab'], ['players', 'renderPlayersTab'], ['live', 'renderLiveTab'], ['data', 'renderDataTab']];
  for (const [tab, fn] of tabs){
    const out = evalIn(ctx, fn + '()');
    suite.check('admin ' + tab + ' tab renders while paused+completed', typeof out === 'string' && out.trim().length > 0);
  }

  /* The organizer kept having to sign out and back in before keys would
     generate. Cause: adminState.session is page state, so when Firebase
     dropped or swapped the credential underneath an open tab (typically a
     moderator/team login in another tab switching the shared Auth instance
     to an anonymous user), the console still rendered as signed in while
     every accessKeys write was rejected by the Database Rules — silently,
     because the writes had no catch. Both halves are covered here. */
  suite.section('a credential lost underneath an open admin tab');
  const SIGNED_IN = `adminState={session:{role:'admin',uid:'admin-1',label:'me@x.com'},
    settings:{currencyUnit:'Cr',minPlayersPerTeam:0,maxPlayersPerTeam:5,defaultBasePrice:1,bidIncrement:1},
    teams:{},players:{},auction:{},sales:[],keys:{}};`;
  {
    const c = ctxFor(['js/shared.js', 'js/admin.js']);
    evalIn(c, SIGNED_IN);

    evalIn(c, `__auth.emitUser({uid:'anon-9', isAnonymous:true});`);
    await new Promise(r => setImmediate(r)); // the handler is async
    suite.check('anonymous takeover clears the stale admin session',
      evalIn(c, 'adminState.session === null'));
    suite.check('  and says so rather than failing silently',
      c.__toasts.some(([type, msg]) => type === 'error' && /sign in again/i.test(msg)));
    suite.check('  and falls back to the login screen',
      /Organizer Sign In/.test(c.document.getElementById('tabContent').innerHTML));
  }
  {
    const c = ctxFor(['js/shared.js', 'js/admin.js']);
    evalIn(c, SIGNED_IN);
    evalIn(c, `__auth.emitUser(null);`);
    await new Promise(r => setImmediate(r));
    suite.check('a dropped credential clears it too',
      evalIn(c, 'adminState.session === null'));
  }

  suite.section('a rejected key write reports instead of doing nothing');
  {
    const c = ctxFor(['js/shared.js', 'js/admin.js']);
    evalIn(c, SIGNED_IN);
    await new Promise(r => setImmediate(r)); // let the load-time auth listener settle
    evalIn(c, SIGNED_IN + `
      document.getElementById('modLabel').value = 'Main desk';
      // what the Rules return once auth.uid is no longer an admin
      db.ref = function(){ return { set(){ return Promise.reject(new Error('PERMISSION_DENIED: Permission denied')); } }; };
    `);
    c.__toasts.length = 0; // only interested in what the write itself reports
    await evalIn(c, 'createModeratorKey()');
    const errs = c.__toasts.filter(([type]) => type === 'error');
    suite.check('createModeratorKey surfaces the refusal', errs.length === 1);
    suite.check('  message names the remedy, not the error code',
      errs.length === 1 && /sign in again/i.test(errs[0][1]) && !/PERMISSION_DENIED/.test(errs[0][1]));
    suite.check('  and does NOT claim the key was created',
      !c.__toasts.some(([type, msg]) => type === 'success' && /key created/i.test(msg)));
  }

  suite.section('moderator-only functions absent from admin.js');
  for (const fn of ['pauseSession', 'pauseBidding', 'resumeSession', 'completeBidding', 'reopenAuction', 'armDisconnectPause']){
    suite.check('admin page has no ' + fn + '()', evalIn(ctx, 'typeof ' + fn) === 'undefined');
  }

  return suite.summarize();
}

module.exports = { name: 'admin-isolation', run };

if (require.main === module){
  run().then(summary => process.exit(printSummary(summary)));
}
