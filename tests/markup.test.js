/* ============================================================
   tests/markup.test.js — tag-balance check on real rendered HTML from every
   page's main views. Catches an unclosed <div> or a stray </span> that
   render.test.js's "did it throw / leak undefined" check wouldn't notice
   (broken markup still returns a non-empty string).
   ============================================================ */
const { ctxFor, evalIn, tagBalanceError } = require('./lib/dom-stub');
const { FIXTURES } = require('./lib/fixtures');
const { makeSuite, printSummary } = require('./lib/suite');

function checkCases(suite, label, files, seedExtra, cases){
  const ctx = ctxFor(files);
  evalIn(ctx, FIXTURES + seedExtra);
  for (const [name, code] of cases){
    const out = evalIn(ctx, '(function(){ ' + code + ' })()');
    const err = tagBalanceError(out);
    suite.check(label + ' / ' + name, !err, err);
  }
}

function run(){
  const suite = makeSuite('markup');

  suite.section('moderator');
  checkCases(suite, 'moderator', ['js/shared.js', 'js/moderator.js'],
    `session={role:'moderator'}; mstate={settings:SETTINGS, teams:TEAMS(), players:PLAYERS, auction:LIVE, recentSales:SALES};`,
    [
      ['setup', 'return renderSetup();'],
      ['players', 'return renderPlayers();'],
      ['teams', 'return renderTeams();'],
      ['summary', 'return renderSummary();'],
      ['results', 'return renderResults();'],
      ['floor live', 'mstate.auction=LIVE; return renderAuction();'],
      ['floor awaiting', 'mstate.auction=AWAITING; return renderAuction();'],
      ['floor paused', 'mstate.auction=PAUSED; return renderAuction();'],
      ['floor idle', 'mstate.auction={}; return renderAuction();'],
      ['floor completed', 'mstate.auction=DONE; return renderAuction();'],
    ]);

  suite.section('public');
  checkCases(suite, 'public', ['js/shared.js', 'js/public.js'],
    `pv={settings:SETTINGS, teams:TEAMS(), players:PLAYERS, auction:LIVE, sales:salesArray(SALES)};`,
    [
      ['full page', 'pv.auction=LIVE; renderPublic(); return document.getElementById("tabContent").innerHTML;'],
      ['full page awaiting', 'pv.auction=AWAITING; renderPublic(); return document.getElementById("tabContent").innerHTML;'],
      ['stage live', 'return renderStage(LIVE, PLAYERS.p1, {name:"Lions"}, 2);'],
      ['awaiting', 'return renderStage(AWAITING, null, null, 2);'],
      ['paused', 'return renderStage(PAUSED, PLAYERS.p1, null, 2);'],
      ['done', 'return renderStage(AWAITING, null, null, 0);'],
      ['idle', 'return renderStage({}, null, null, 2);'],
      ['home screen', 'pv.auction=DONE; showPastResults=false; renderPublic(); return document.getElementById("tabContent").innerHTML;'],
      ['home + results', 'pv.auction=DONE; showPastResults=true; renderPublic(); return document.getElementById("tabContent").innerHTML;'],
      ['home no history', 'pv.sales=[]; pv.auction=DONE; showPastResults=false; renderPublic(); return document.getElementById("tabContent").innerHTML;'],
    ]);

  suite.section('team');
  checkCases(suite, 'team', ['js/shared.js', 'js/team.js'],
    `tSession={role:'team', teamId:'t1'}; tstate={settings:SETTINGS, teams:TEAMS(), players:PLAYERS, auction:LIVE};`,
    [
      ['live', 'tstate.auction=LIVE; return renderDashboard();'],
      ['awaiting', 'tstate.auction=AWAITING; return renderDashboard();'],
      ['paused', 'tstate.auction=PAUSED; return renderDashboard();'],
      ['idle', 'tstate.auction={}; return renderDashboard();'],
      ['completed', 'tstate.auction=DONE; return renderDashboard();'],
    ]);

  suite.section('admin');
  checkCases(suite, 'admin', ['js/shared.js', 'js/admin.js'],
    `adminState={session:{label:'a'}, settings:SETTINGS, teams:TEAMS(), players:PLAYERS, auction:LIVE, sales:salesArray(SALES),
      keys:{'MOD-A':{role:'moderator', active:true, createdAt:1}}};`,
    [
      ['keys', 'return renderKeys();'],
      ['teams', 'return renderTeamsTab();'],
      ['players', 'return renderPlayersTab();'],
      ['live', 'adminState.auction=LIVE; return renderLiveTab();'],
      ['live awaiting', 'adminState.auction=AWAITING; return renderLiveTab();'],
      ['live idle', 'adminState.auction={}; return renderLiveTab();'],
      ['live completed', 'adminState.auction=DONE; return renderLiveTab();'],
      ['data', 'return renderDataTab();'],
      ['login', 'return renderLogin();'],
    ]);

  return suite.summarize();
}

module.exports = { name: 'markup', run };

if (require.main === module){
  process.exit(printSummary(run()));
}
