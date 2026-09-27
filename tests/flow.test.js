/* ============================================================
   tests/flow.test.js — records every Firebase write js/moderator.js makes
   and asserts the resulting state for sold/unsold/skip/next/pause/resume/
   complete/reopen. This is the test that actually verifies auction-node
   *behavior*, as opposed to render.test.js which only checks that a state
   renders without crashing.

   Run this after any change to js/moderator.js's action functions
   (markSold, markUnsold, skipPlayer, nextPlayer, pauseSession, pauseBidding,
   resumeSession, resetBid, completeBidding, reopenAuction, attachListeners).
   ============================================================ */
const { ctxFor, evalIn } = require('./lib/dom-stub');
const { makeSuite, printSummary } = require('./lib/suite');

const SEED = `
const SETTINGS = {numTeams:2, defaultBudget:100, defaultBasePrice:5, bidIncrement:1,
                  maxPlayersPerTeam:18, minPlayersPerTeam:0, currencyUnit:'Cr'};
session = {role:'moderator', label:'Mod'};
mstate = {settings:SETTINGS,
  teams:{t1:{name:'Lions', budget:100, squad:{}}, t2:{name:'Tigers', budget:100, squad:{}}},
  players:{
    p1:{name:'Kohli', category:'Batsman', basePrice:15, image:'images/k.jpg', status:'pending'},
    p2:{name:'Bumrah', category:'Bowler', basePrice:12, image:'', status:'pending'},
    p3:{name:'Jadeja', category:'All-Rounder', basePrice:8, image:'', status:'pending'}},
  auction:{currentPlayerId:'p1', currentPrice:18, leaderTeamId:'t1', biddingOpen:true, paused:false, awaitingNext:false},
  recentSales:{}};
window.__settingsCache = SETTINGS;
`;

const find = (writes, op, path) => writes.find(w => w.op === op && w.path === path);
const rootUpdate = (writes) => (find(writes, 'update', '/') || {}).value || {};

async function scenario(suite, name, code, assert){
  const ctx = ctxFor(['js/shared.js', 'js/moderator.js']);
  evalIn(ctx, SEED);
  ctx.__writes.length = 0; // the initial render triggered by loading moderator.js may itself write nothing, but keep this explicit
  await evalIn(ctx, '(async function(){ ' + code + ' })()');
  suite.section(name);
  assert(ctx.__writes, ctx, (label, cond, detail) => suite.check(label, cond, detail));
}

async function run(){
  const suite = makeSuite('flow');

  await scenario(suite, 'SOLD', 'await markSold();', (w, ctx, check) => {
    const root = rootUpdate(w);
    check('player marked sold', root['players/p1/status'] === 'sold');
    check('sold to the leader', root['players/p1/soldTo'] === 't1');
    check('price recorded', root['players/p1/soldPrice'] === 18);
    check('added to squad', root['squads/t1/p1'] && root['squads/t1/p1'].price === 18);
    const sale = root['recentSales/p1'];
    check('sales log row written', !!sale);
    check('  row has name/team/price', sale && sale.name === 'Kohli' && sale.team === 'Lions' && sale.price === 18);
    check('  row has photo + category', sale && sale.image === 'images/k.jpg' && sale.category === 'Batsman');
    check('  row result = sold', sale && sale.result === 'sold');
    const auc = (find(w, 'update', 'auction') || {}).value || {};
    check('holds for Next Player', auc.awaitingNext === true);
    check('bidding closed in between', auc.biddingOpen === false);
    check('no player on the block', auc.currentPlayerId === null);
    check('last result shown', auc.lastResult && auc.lastResult.result === 'sold' && auc.lastResult.team === 'Lions');
  });

  await scenario(suite, 'UNSOLD', 'await markUnsold();', (w, ctx, check) => {
    const root = rootUpdate(w);
    check('player marked unsold', root['players/p1/status'] === 'unsold');
    check('not added to any squad', !Object.keys(root).some(k => k.startsWith('squads/')));
    check('logged as unsold', root['recentSales/p1'] && root['recentSales/p1'].result === 'unsold');
    check('no team / price on row', root['recentSales/p1'].team === null && root['recentSales/p1'].price === null);
    const auc = (find(w, 'update', 'auction') || {}).value || {};
    check('holds for Next Player', auc.awaitingNext === true);
  });

  await scenario(suite, 'SKIP', 'await skipPlayer();', (w, ctx, check) => {
    const auc = (find(w, 'update', 'auction') || {}).value || {};
    check('holds for Next Player', auc.awaitingNext === true);
    check('remembers who to skip', auc.excludeId === 'p1');
    check('no sales row logged', !find(w, 'update', '/'));
  });

  await scenario(suite, 'NEXT after skip', `
    mstate.auction = {currentPlayerId:null, awaitingNext:true, excludeId:'p1', biddingOpen:false, paused:false};
    await nextPlayer();`, (w, ctx, check) => {
    const auc = (find(w, 'set', 'auction') || {}).value || {};
    check('a player is put up', !!auc.currentPlayerId);
    check('skipped one not re-offered', auc.currentPlayerId !== 'p1', 'got ' + auc.currentPlayerId);
    check('bidding reopened', auc.biddingOpen === true);
    check('price + leader reset', auc.currentPrice === 0 && auc.leaderTeamId === null);
    check('not paused', auc.paused === false);
    check('skip memory cleared', auc.excludeId === null);
    check('awaitingNext cleared', auc.awaitingNext === false);
  });

  await scenario(suite, 'NEXT when only the skipped player is left', `
    mstate.players = {p1:{name:'Kohli', category:'Batsman', basePrice:15, status:'pending'}};
    mstate.auction = {currentPlayerId:null, awaitingNext:true, excludeId:'p1'};
    await nextPlayer();`, (w, ctx, check) => {
    const auc = (find(w, 'set', 'auction') || {}).value || {};
    check('re-offers them rather than stalling', auc.currentPlayerId === 'p1');
  });

  await scenario(suite, 'NEXT with an empty pool', `
    mstate.players = {p1:{name:'Kohli', basePrice:1, status:'sold'}};
    mstate.auction = {currentPlayerId:null, awaitingNext:true};
    await nextPlayer();`, (w, ctx, check) => {
    const auc = (find(w, 'set', 'auction') || {}).value || {};
    check('nothing put up', auc.currentPlayerId === null);
    check('bidding stays closed', auc.biddingOpen === false);
  });

  await scenario(suite, 'SIGN OUT pauses', 'await pauseSession();', (w, ctx, check) => {
    const auc = (find(w, 'update', 'auction') || {}).value || {};
    check('marked paused', auc.paused === true);
    check('bidding closed', auc.biddingOpen === false);
    check('pause time recorded', typeof auc.pausedAt === 'number');
    check('current lot preserved', auc.currentPlayerId === undefined, 'must not clear the player');
  });

  await scenario(suite, 'SIGN OUT with nothing running writes nothing', `
    mstate.auction = {};
    await pauseSession();`, (w, ctx, check) => {
    check('no pointless write', w.length === 0);
  });

  await scenario(suite, 'RESUME mid-lot', `
    mstate.auction = {currentPlayerId:'p1', currentPrice:18, leaderTeamId:'t1', paused:true, biddingOpen:false};
    await resumeSession();`, (w, ctx, check) => {
    const auc = (find(w, 'update', 'auction') || {}).value || {};
    check('unpaused', auc.paused === false);
    check('bidding reopened', auc.biddingOpen === true);
    check('pause time cleared', auc.pausedAt === null);
    check('bid + leader untouched', auc.currentPrice === undefined && auc.leaderTeamId === undefined);
  });

  await scenario(suite, 'RESUME between lots leaves bidding shut', `
    mstate.auction = {currentPlayerId:null, awaitingNext:true, paused:true, biddingOpen:false};
    await resumeSession();`, (w, ctx, check) => {
    const auc = (find(w, 'update', 'auction') || {}).value || {};
    check('unpaused', auc.paused === false);
    check('bidding stays closed', auc.biddingOpen === false, 'nothing is on the block yet');
  });

  await scenario(suite, 'RESET BID', 'await resetBid();', (w, ctx, check) => {
    const auc = (find(w, 'update', 'auction') || {}).value || {};
    check('price back to base', auc.currentPrice === 0);
    check('leader cleared', auc.leaderTeamId === null);
    check('player stays up', auc.currentPlayerId === undefined);
  });

  await scenario(suite, 'PAUSE button', 'await pauseBidding();', (w, ctx, check) => {
    const auc = (find(w, 'update', 'auction') || {}).value || {};
    check('marked paused', auc.paused === true);
    check('bidding closed', auc.biddingOpen === false);
    check('reason recorded=manual', auc.pauseReason === 'manual');
    check('current lot preserved', auc.currentPlayerId === undefined);
  });

  await scenario(suite, 'SIGN OUT records its own reason', "await pauseSession('signout');", (w, ctx, check) => {
    const auc = (find(w, 'update', 'auction') || {}).value || {};
    check('reason recorded=signout', auc.pauseReason === 'signout');
  });

  await scenario(suite, 'COMPLETE BIDDING', 'await completeBidding();', (w, ctx, check) => {
    const auc = (find(w, 'update', 'auction') || {}).value || {};
    check('marked completed', auc.completed === true);
    check('completion time set', typeof auc.completedAt === 'number');
    check('bidding closed', auc.biddingOpen === false);
    check('nothing on the block', auc.currentPlayerId === null);
    check('leader cleared', auc.leaderTeamId === null);
    check('not left paused', auc.paused === false);
    check('not awaiting next', auc.awaitingNext === false);
    check('stale last result cleared', auc.lastResult === null);
    check('no player records touched', !find(w, 'update', '/'), 'results must be preserved as-is');
  });

  await scenario(suite, 'REOPEN', `
    mstate.auction = {completed:true, completedAt:1, biddingOpen:false};
    await reopenAuction();`, (w, ctx, check) => {
    const auc = (find(w, 'update', 'auction') || {}).value || {};
    check('no longer completed', auc.completed === false);
    check('completion time cleared', auc.completedAt === null);
    check('bidding still shut', auc.biddingOpen === false, 'nothing is up yet');
    check('not paused', auc.paused === false);
  });

  await scenario(suite, 'NEXT after reopen clears the completed flag', `
    mstate.auction = {completed:false, awaitingNext:false};
    await nextPlayer();`, (w, ctx, check) => {
    const auc = (find(w, 'set', 'auction') || {}).value || {};
    check('uses set, so completed is gone', auc.completed === undefined);
    check('a player is put up', !!auc.currentPlayerId);
    check('bidding open', auc.biddingOpen === true);
  });

  await scenario(suite, 'disconnect handler registered', 'attachListeners();', (w, ctx, check) => {
    const d = find(w, 'onDisconnect', 'auction');
    check('pauses if the console drops', !!d && d.value.paused === true && d.value.biddingOpen === false);
    check('  tagged as a disconnect', !!d && d.value.pauseReason === 'disconnect');
  });

  // ---- Live Results dedup: a player's sale row must be a single, live
  // record of their CURRENT status, not an append-only log — see CLAUDE.md
  // "Live Results" for why a leftover row after release double-counted
  // spend and showed a player as sold twice. ----

  await scenario(suite, 'RELEASE clears the player\'s results-log row', `
    mstate.teams.t1.squad = {p1:{price:22}};
    await doRelease('t1','p1');`, (w, ctx, check) => {
    check('squad entry removed', !!find(w, 'remove', 'squads/t1/p1'));
    check('player back to pending', !!find(w, 'update', 'players/p1'));
    check('results-log row removed, not left stale', !!find(w, 'remove', 'recentSales/p1'));
  });

  await scenario(suite, 'RETURN TO POOL clears the player\'s results-log row', `
    mstate.players.p1 = {name:'Kohli', category:'Batsman', basePrice:15, status:'unsold'};
    await returnToPool('p1');`, (w, ctx, check) => {
    check('player back to pending', !!find(w, 'update', 'players/p1'));
    check('results-log row removed, not left stale', !!find(w, 'remove', 'recentSales/p1'));
  });

  await scenario(suite, 'DELETE PLAYER clears the player\'s results-log row too', `
    mstate.players.p1 = {name:'Kohli', category:'Batsman', basePrice:15, status:'sold', soldTo:'t1'};
    mstate.teams.t1.squad = {p1:{price:22}};
    await deletePlayer('p1');`, (w, ctx, check) => {
    check('squad entry removed', !!find(w, 'remove', 'squads/t1/p1'));
    check('player removed', !!find(w, 'remove', 'players/p1'));
    check('results-log row removed, not left as a ghost for a deleted player', !!find(w, 'remove', 'recentSales/p1'));
  });

  suite.section('SOLD -> RELEASED -> RESOLD leaves exactly one row, at the new price');
  {
    // Not the scenario() helper: this one needs writes to persist and be
    // re-applied to mstate across three real actions in a row, the way a
    // moderator would actually click through it.
    const ctx = ctxFor(['js/shared.js', 'js/moderator.js']);
    evalIn(ctx, SEED);
    ctx.__writes.length = 0;
    await evalIn(ctx, 'markSold()'); // Kohli sold to Lions for 18
    const firstSaleWrites = ctx.__writes.slice();
    const firstRoot = rootUpdate(firstSaleWrites);
    suite.check('first sale logged once', !!firstRoot['recentSales/p1']);

    // Apply that write back into mstate, exactly like the live listener would.
    evalIn(ctx, `mstate.players.p1 = {name:'Kohli', category:'Batsman', basePrice:15, status:'sold', soldTo:'t1'};
                 mstate.teams.t1.squad = {p1:{price:18}};`);
    ctx.__writes.length = 0;
    await evalIn(ctx, "doRelease('t1','p1')");
    suite.check('release removes that one row', !!find(ctx.__writes, 'remove', 'recentSales/p1'));

    // Put Kohli back up and sell again, to a different team at a different price.
    evalIn(ctx, `mstate.players.p1 = {name:'Kohli', category:'Batsman', basePrice:15, status:'pending'};
                 mstate.teams.t1.squad = {};
                 mstate.auction = {currentPlayerId:'p1', currentPrice:30, leaderTeamId:'t2', biddingOpen:true, paused:false, awaitingNext:false};`);
    ctx.__writes.length = 0;
    await evalIn(ctx, 'markSold()'); // Kohli resold to Tigers for 30
    const secondRoot = rootUpdate(ctx.__writes);
    const secondSale = secondRoot['recentSales/p1'];
    suite.check('resale writes the SAME key as before (no second row can exist)', !!secondSale);
    suite.check('reflects the NEW sale only', secondSale && secondSale.team === 'Tigers' && secondSale.price === 30,
      JSON.stringify(secondSale));
    suite.check('does not still say Lions / 18 from the first sale', !(secondSale && (secondSale.team === 'Lions' || secondSale.price === 18)));
  }

  // ---- Retain / pre-assign a player to a team at a chosen price, without
  // going through the live floor (e.g. IPL-style retentions before an
  // auction starts). Ends up in exactly the same shape a real SOLD does. ----

  await scenario(suite, 'ASSIGN records the same shape as a real sale', `
    mstate.auction = {}; // nothing on the floor — this can happen before bidding starts
    document.getElementById('asTeam').value = 't2';
    document.getElementById('asPrice').value = '40';
    await confirmAssignPlayer('p1');`, (w, ctx, check) => {
    const root = rootUpdate(w);
    check('player marked sold', root['players/p1/status'] === 'sold');
    check('sold to the CHOSEN team, not a bidding leader', root['players/p1/soldTo'] === 't2');
    check('at the TYPED price', root['players/p1/soldPrice'] === 40);
    check('added to that team\'s squad', root['squads/t2/p1'] && root['squads/t2/p1'].price === 40);
    const sale = root['recentSales/p1'];
    check('logged in the results table like a real sale', sale && sale.result === 'sold' && sale.team === 'Tigers' && sale.price === 40);
  });

  await scenario(suite, 'ASSIGN refuses a team that cannot afford it', `
    mstate.teams.t2.budget = 10; // well under the 40 we're about to try
    document.getElementById('asTeam').value = 't2';
    document.getElementById('asPrice').value = '40';
    await confirmAssignPlayer('p1');`, (w, ctx, check) => {
    check('nothing written', w.length === 0);
    check('explains why', evalIn(ctx, "document.getElementById('asErr').textContent").length > 0);
  });

  await scenario(suite, 'ASSIGN refuses a player currently on the block', `
    mstate.auction = {currentPlayerId:'p1', currentPrice:0, leaderTeamId:null, biddingOpen:true};
    assignPlayerPrompt('p1');`, (w, ctx, check) => {
    check('modal never opens / nothing written', w.length === 0);
  });

  return suite.summarize();
}

module.exports = { name: 'flow', run };

if (require.main === module){
  run().then(summary => process.exit(printSummary(summary)));
}
