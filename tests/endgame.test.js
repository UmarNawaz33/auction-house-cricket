/* ============================================================
   tests/endgame.test.js — the end-of-auction journey, asserted on real
   rendered content (not just "did it throw"): last player sold -> the
   moderator's "All Players Auctioned" panel -> Complete Bidding Session ->
   index.html's home screen -> previous results shown on request.

   Run this after touching: js/moderator.js's renderAuction() all-done panel
   or completeBidding(); or js/public.js's renderHomeScreen()/togglePastResults().
   ============================================================ */
const { ctxFor, evalIn } = require('./lib/dom-stub');
const { makeSuite, printSummary } = require('./lib/suite');

const has = (html, text) => html.includes(text);
const hasI = (html, text) => html.toLowerCase().includes(text.toLowerCase()); // user-facing copy: presence matters, not casing

const S = "{numTeams:2,defaultBudget:100,defaultBasePrice:5,bidIncrement:1,maxPlayersPerTeam:18,minPlayersPerTeam:0,currencyUnit:'Cr'}";
const SALES = "{s1:{name:'Kohli',category:'Batsman',image:'',basePrice:15,result:'sold',teamId:'t1',team:'Lions',price:20,time:2}," +
              " s2:{name:'Jadeja',category:'All-Rounder',image:'',basePrice:8,result:'unsold',teamId:null,team:null,price:null,time:1}}";
// every player accounted for: one sold, one unsold, none pending
const DONE_PLAYERS = "{p1:{name:'Kohli',category:'Batsman',basePrice:15,image:'',status:'sold',soldTo:'t1',soldPrice:20}," +
                      " p2:{name:'Jadeja',category:'All-Rounder',basePrice:8,image:'',status:'unsold'}}";
const TEAMS = "{t1:{name:'Lions',budget:100,squad:{p1:{price:20}}}}";

function run(){
  const suite = makeSuite('endgame');

  suite.section('1. moderator: last player sold, pool empty');
  const m = ctxFor(['js/shared.js', 'js/moderator.js']);
  evalIn(m, "session={role:'moderator'};window.__settingsCache=" + S + ";" +
    "mstate={settings:" + S + ",teams:" + TEAMS + ",players:" + DONE_PLAYERS + "," +
    "auction:{currentPlayerId:null,biddingOpen:false,paused:false,awaitingNext:true," +
    "lastResult:{name:'Kohli',result:'sold',team:'Lions',price:20}},recentSales:" + SALES + "};");
  let out = evalIn(m, 'renderAuction()');
  suite.check('shows "All Players Auctioned"', has(out, 'All Players Auctioned'));
  suite.check('offers Complete Bidding Session', has(out, 'Complete Bidding Session'));
  suite.check('  as the primary call to action', /class="primary xl" onclick="confirmCompleteBidding\(\)"/.test(out));
  suite.check('no "Next Player" button', !has(out, 'Next Player</button>'));
  suite.check('summarises sold count', has(out, '>1</div><div class="lbl">Sold<'));
  suite.check('summarises unsold count', has(out, '>1</div><div class="lbl">Unsold<'));
  suite.check('summarises total spend', has(out, '20 Cr'));
  suite.check('reassures nothing is deleted', has(out, 'reopen the auction afterwards'));

  suite.section('2. moderator: same panel when idle with no pending players');
  evalIn(m, "mstate.auction={currentPlayerId:null,awaitingNext:false,biddingOpen:false};");
  out = evalIn(m, 'renderAuction()');
  suite.check('shows the all-done panel', has(out, 'All Players Auctioned'));
  suite.check('offers Complete Bidding Session', has(out, 'Complete Bidding Session'));

  suite.section('3. moderator: empty pool with no players at all is NOT "all done"');
  evalIn(m, "mstate.players={};mstate.recentSales={};");
  out = evalIn(m, 'renderAuction()');
  suite.check('prompts to add players instead', has(out, 'No players in the pool yet'));
  suite.check('does not offer to complete', !has(out, 'Complete Bidding Session'));

  suite.section('4. pressing it writes the completed flag');
  evalIn(m, "mstate.players=" + DONE_PLAYERS + ";mstate.recentSales=" + SALES + ";" +
    "mstate.auction={currentPlayerId:null,awaitingNext:true,biddingOpen:false};");
  m.__writes.length = 0;
  evalIn(m, 'completeBidding()');
  const auc = (m.__writes.find(w => w.op === 'update' && w.path === 'auction') || {}).value || {};
  suite.check('auction marked completed', auc.completed === true);
  suite.check('bidding closed', auc.biddingOpen === false);
  suite.check('results left untouched', !m.__writes.some(w => w.path === '/' || w.path === 'recentSales'));

  suite.section('5. index.html falls back to its home screen');
  const pub = ctxFor(['js/shared.js', 'js/public.js']);
  evalIn(pub, "window.__settingsCache=" + S + ";" +
    "pv={settings:" + S + ",teams:" + TEAMS + ",players:" + DONE_PLAYERS + "," +
    "auction:{completed:true,completedAt:9,biddingOpen:false,currentPlayerId:null},sales:salesArray(" + SALES + ")};" +
    "showPastResults=false; renderPublic();");
  out = pub.document.getElementById('tabContent').innerHTML;
  suite.check('says no live auction', hasI(out, 'No live auction'));
  suite.check('explains nothing is running', has(out, 'no bidding going on'));
  suite.check('offers the results button', hasI(out, 'View previous bidding results'));
  suite.check('results table hidden by default', !hasI(out, '>Previous Bidding Results<'));
  suite.check('no live player card', !has(out, 'pv-lot') && !has(out, 'pv-photo-frame'));
  suite.check('team cards hidden too', !has(out, 'pv-team'));

  suite.section('6. pressing that button reveals the previous results');
  evalIn(pub, 'togglePastResults();');
  out = pub.document.getElementById('tabContent').innerHTML;
  suite.check('results table shown', hasI(out, 'Previous Bidding Results'));
  suite.check('  sold row present', has(out, 'Kohli') && has(out, 'Lions') && has(out, '20 Cr'));
  suite.check('  unsold row present', has(out, 'Jadeja'));
  suite.check('final squads shown', hasI(out, 'Final Squads'));
  suite.check('button flips to hide', hasI(out, 'Hide previous results'));
  suite.check('still says no live auction', hasI(out, 'No live auction'));

  suite.section('7. and collapses again');
  evalIn(pub, 'togglePastResults();');
  out = pub.document.getElementById('tabContent').innerHTML;
  suite.check('back to just the home screen', hasI(out, 'View previous bidding results') && !hasI(out, 'Final Squads'));

  suite.section('8. home screen with no history at all');
  evalIn(pub, 'pv.sales=[]; showPastResults=false; renderPublic();');
  out = pub.document.getElementById('tabContent').innerHTML;
  suite.check('says there are no results', has(out, 'No results to show yet'));
  suite.check('hides the results button', !has(out, 'View Previous Bidding Results'));

  return suite.summarize();
}

module.exports = { name: 'endgame', run };

if (require.main === module){
  process.exit(printSummary(run()));
}
