/* ============================================================
   tests/render.test.js — "does this render at all, on every page, in every
   auction/session state, without throwing or leaking undefined/NaN into the
   markup." The broadest, cheapest safety net: run this after almost any
   template-string change.

   Covers: js/moderator.js, js/public.js, js/team.js, js/admin.js — every
   tab/state each renders. Does NOT check visual layout (see markup.test.js
   for tag balance, or take a screenshot for anything about how it looks).
   ============================================================ */
const { ctxFor, evalIn } = require('./lib/dom-stub');
const { FIXTURES } = require('./lib/fixtures');
const { makeSuite, printSummary } = require('./lib/suite');

function tabContent(ctx){
  return ctx.document.getElementById('tabContent').innerHTML;
}

/** Run one named `code` snippet in ctx; fail on a thrown error, empty output,
 *  or a leaked undefined/NaN/[object Object] in the rendered string. */
function tryRender(suite, ctx, name, code){
  try{
    const out = evalIn(ctx, '(function(){ ' + code + ' })()');
    if (typeof out !== 'string' || !out.trim()) throw new Error('rendered nothing');
    const bad = out.match(/.{0,70}(undefined|\[object Object\]|NaN).{0,70}/);
    if (bad) throw new Error('suspicious output: …' + bad[0].replace(/\s+/g, ' ') + '…');
    suite.check(name, true);
  }catch(e){
    suite.check(name, false, e.message);
  }
}

function run(){
  const suite = makeSuite('render');

  // ---- moderator.js ----
  suite.section('moderator.js');
  {
    const ctx = ctxFor(['js/shared.js', 'js/moderator.js']);
    evalIn(ctx, FIXTURES + `
      session = {role:'moderator', label:'Main Mod'};
      mstate = {settings:SETTINGS, teams:TEAMS(), players:PLAYERS, auction:LIVE, recentSales:SALES};
    `);
    const cases = [
      ['setup', 'return renderSetup();'],
      ['players', 'return renderPlayers();'],
      ['teams', 'return renderTeams();'],
      ['summary', 'return renderSummary();'],
      ['results', 'return renderResults();'],
      ['auction: live w/ bid', 'mstate.auction=LIVE; return renderAuction();'],
      ['auction: no bids yet', 'mstate.auction=NOBIDS; return renderAuction();'],
      ['auction: awaiting next', 'mstate.auction=AWAITING; return renderAuction();'],
      ['auction: after skip', 'mstate.auction=SKIPPED; return renderAuction();'],
      ['auction: paused', 'mstate.auction=PAUSED; return renderAuction();'],
      ['auction: not started', 'mstate.auction=EMPTY; return renderAuction();'],
      ['auction: no sales yet', 'mstate.recentSales={}; mstate.auction=LIVE; return renderAuction();'],
      ['auction: all sold', 'mstate.recentSales=SALES; mstate.players={p2:PLAYERS.p2}; mstate.auction=AWAITING; return renderAuction();'],
      ['auction: no teams', 'mstate.teams={}; return renderAuction();'],
      ['auction: completed', 'mstate.players=PLAYERS; mstate.recentSales=SALES; mstate.auction=DONE; return renderAuction();'],
      ['auction: completed, none left', 'mstate.players={p2:PLAYERS.p2}; mstate.auction=DONE; return renderAuction();'],
      ['auction: completed, no sales', 'mstate.players=PLAYERS; mstate.recentSales={}; mstate.auction=DONE; return renderAuction();'],
      ['auction: paused (manual)', 'mstate.recentSales=SALES; mstate.auction=PAUSED; return renderAuction();'],
      ['auction: paused (signout)', 'mstate.auction=PAUSED_SIGNOUT; return renderAuction();'],
      ['auction: paused (dropped)', 'mstate.auction=PAUSED_DROP; return renderAuction();'],
      ['photo picker', "return photoPickerHtml({file:'f',path:'p',preview:'v'}, 'images/x.jpg');"],
      ['empty database', 'mstate={settings:SETTINGS, teams:{}, players:{}, auction:{}, recentSales:{}}; return renderSetup()+renderPlayers()+renderTeams()+renderSummary()+renderResults()+renderAuction();'],
    ];
    for (const [name, code] of cases) tryRender(suite, ctx, name, code);
  }

  // ---- public.js ----
  suite.section('public.js');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, FIXTURES + `
      pv = {settings:SETTINGS, teams:TEAMS(), players:PLAYERS, auction:LIVE, sales:salesArray(SALES)};
    `);
    const cases = [
      ['live lot', 'pv.auction=LIVE; renderPublic(); return document.getElementById("tabContent").innerHTML;'],
      ['awaiting next', 'pv.auction=AWAITING; renderPublic(); return document.getElementById("tabContent").innerHTML;'],
      ['all done', 'pv.auction=AWAITING; pv.players={p2:PLAYERS.p2}; renderPublic(); return document.getElementById("tabContent").innerHTML;'],
      ['paused', 'pv.players=PLAYERS; pv.auction=PAUSED; renderPublic(); return document.getElementById("tabContent").innerHTML;'],
      ['nothing on', 'pv.auction=EMPTY; renderPublic(); return document.getElementById("tabContent").innerHTML;'],
      ['no sales', 'pv.sales=[]; renderPublic(); return document.getElementById("tabContent").innerHTML;'],
      ['completed: home screen', 'pv.sales=salesArray(SALES); pv.auction=DONE; showPastResults=false; renderPublic(); return document.getElementById("tabContent").innerHTML;'],
      ['completed: results revealed', 'pv.auction=DONE; showPastResults=true; renderPublic(); return document.getElementById("tabContent").innerHTML;'],
      ['completed: never any results', 'pv.sales=[]; pv.auction=DONE; showPastResults=false; renderPublic(); return document.getElementById("tabContent").innerHTML;'],
      ['completed: toggle round trip', 'pv.sales=salesArray(SALES); pv.auction=DONE; showPastResults=false; togglePastResults(); const a=document.getElementById("tabContent").innerHTML; togglePastResults(); return a+document.getElementById("tabContent").innerHTML;'],
      ['empty database', 'showPastResults=false; pv={settings:SETTINGS, teams:{}, players:{}, auction:{}, sales:[]}; renderPublic(); return document.getElementById("tabContent").innerHTML;'],
    ];
    for (const [name, code] of cases) tryRender(suite, ctx, name, code);
  }

  // ---- team.js ----
  suite.section('team.js');
  {
    const ctx = ctxFor(['js/shared.js', 'js/team.js']);
    evalIn(ctx, FIXTURES + `
      tSession = {role:'team', teamId:'t1', label:'Lions Owner'};
      tstate = {settings:SETTINGS, teams:TEAMS(), players:PLAYERS, auction:LIVE};
    `);
    const cases = [
      ['live lot (leading)', 'tstate.auction=LIVE; return renderDashboard();'],
      ['live lot (no bids)', 'tstate.auction=NOBIDS; return renderDashboard();'],
      ['awaiting next', 'tstate.auction=AWAITING; return renderDashboard();'],
      ['paused', 'tstate.auction=PAUSED; return renderDashboard();'],
      ['nothing on', 'tstate.auction=EMPTY; return renderDashboard();'],
      ['no squad yet', 'tstate.teams=TEAMS(); tstate.teams.t1.squad={}; tstate.auction=LIVE; return renderDashboard();'],
      ['completed', 'tstate.auction=DONE; return renderDashboard();'],
      ['team missing', 'tstate.teams={}; return renderDashboard();'],
    ];
    for (const [name, code] of cases) tryRender(suite, ctx, name, code);
  }

  // ---- admin.js ----
  suite.section('admin.js');
  {
    const ctx = ctxFor(['js/shared.js', 'js/admin.js']);
    evalIn(ctx, FIXTURES + `
      adminState = {session:{role:'admin', label:'me@x.com'}, settings:SETTINGS, teams:TEAMS(),
        players:PLAYERS, auction:LIVE, sales:salesArray(SALES),
        keys:{'MOD-AAA111':{role:'moderator', teamId:null, label:'Main', active:true, createdAt:1727400000000},
              'TEAM-BBB222':{role:'team', teamId:'t1', label:'Lions', active:false, createdAt:1727400000000}}};
    `);
    const cases = [
      ['keys', 'return renderKeys();'],
      ['teams', 'return renderTeamsTab();'],
      ['players', 'return renderPlayersTab();'],
      ['live: bidding', 'adminState.auction=LIVE; return renderLiveTab();'],
      ['live: awaiting', 'adminState.auction=AWAITING; return renderLiveTab();'],
      ['live: paused', 'adminState.auction=PAUSED; return renderLiveTab();'],
      ['live: idle', 'adminState.auction=EMPTY; return renderLiveTab();'],
      ['live: completed', 'adminState.auction=DONE; return renderLiveTab();'],
      ['live: paused (manual)', 'adminState.auction=PAUSED; return renderLiveTab();'],
      ['live: paused (dropped)', 'adminState.auction=PAUSED_DROP; return renderLiveTab();'],
      ['data & reset', 'return renderDataTab();'],
      ['key with no label', "adminState.keys={'MOD-X':{role:'moderator', active:true, createdAt:1727400000000}}; return renderKeys();"],
      ['empty database', 'Object.assign(adminState,{teams:{},players:{},auction:{},sales:[],keys:{}}); return renderKeys()+renderTeamsTab()+renderPlayersTab()+renderLiveTab()+renderDataTab();'],
    ];
    for (const [name, code] of cases) tryRender(suite, ctx, name, code);
  }

  return suite.summarize();
}

module.exports = { name: 'render', run };

if (require.main === module){
  process.exit(printSummary(run()));
}
