/* ============================================================
   tests/awards-targets.test.js — two features added 2026-10-03:

     1. End-of-auction awards (public.js): computeAwards()/
        renderAwardsPanel(), shown on the completed home screen behind a
        "View auction awards" button (toggleAwards()).
     2. Team owner target list (team.js): loadTargets()/toggleTarget()/
        isTarget()/renderTargetList() and the "Your target is up" chip
        (inside the lot card since 2026-10-04 — it was a separate bar above
        the card before that) — stored ONLY in localStorage, never Firebase.

   Run this after touching any of those, or renderHomeScreen()'s buttons.
   ============================================================ */
const { ctxFor, evalIn } = require('./lib/dom-stub');
const { makeSuite, printSummary } = require('./lib/suite');

// A small in-memory localStorage for the VM (the stub has none by default).
function fakeStorage(){
  const data = {};
  return {
    data,
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
  };
}

function run(){
  const suite = makeSuite('awards-targets');

  /* ---------------- awards ---------------- */
  const SALES = `[
    {id:'p1', name:'Kohli',  result:'sold',   via:'auction',  team:'Lions',  price:40, basePrice:10, time:5},
    {id:'p2', name:'Bumrah', result:'sold',   via:'auction',  team:'Tigers', price:12, basePrice:12, time:4},
    {id:'p3', name:'Jadeja', result:'sold',   via:'auction',  team:'Tigers', price:9,  basePrice:3,  time:3},
    {id:'p4', name:'Gill',   result:'sold',   via:'assigned', team:'Lions',  price:90, basePrice:5,  time:2},
    {id:'p5', name:'Pant',   result:'unsold', via:'auction',  team:null,     price:null, basePrice:8, time:1}
  ]`;
  const TEAMS = `[
    {id:'t1', name:'Lions',  budget:200, squad:{p1:{price:40}, p4:{price:90}}},
    {id:'t2', name:'Tigers', budget:100, squad:{p2:{price:12}, p3:{price:9}}},
    {id:'t3', name:'Sharks', budget:100, squad:{}}
  ]`;

  suite.section('1. computeAwards() — who wins what');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `window.__settingsCache = {currencyUnit:'Cr'};`);
    const awards = evalIn(ctx, `computeAwards(${SALES}, ${TEAMS})`);
    const by = t => awards.find(a => a.title === t);
    suite.check('most expensive buy is the top AUCTION sale (Kohli 40), not the retained Gill at 90',
      by('Most Expensive Buy') && by('Most Expensive Buy').winner === 'Kohli', JSON.stringify(by('Most Expensive Buy')));
    suite.check('biggest jump is the highest price/base ratio (Kohli, 4×)',
      by('Biggest Bidding Jump') && by('Biggest Bidding Jump').winner === 'Kohli' && /4×/.test(by('Biggest Bidding Jump').detail));
    suite.check('best bargain is the lowest price/base ratio (Bumrah, at base)',
      by('Best Bargain') && by('Best Bargain').winner === 'Bumrah');
    suite.check('biggest spender reads squad spend (Lions 130 incl. the retention)',
      by('Biggest Spender') && by('Biggest Spender').winner === 'Lions' && /130/.test(by('Biggest Spender').detail));
    suite.check('thriftiest is the buyer with the most purse left (Tigers 79), not a team that bought nobody',
      by('Thriftiest Team') && by('Thriftiest Team').winner === 'Tigers');
    suite.check('biggest squad ignores a team with no players',
      by('Biggest Squad') && by('Biggest Squad').winner !== 'Sharks');
    suite.check('an unsold player never wins anything', !awards.some(a => a.winner === 'Pant'));
  }

  suite.section('2. computeAwards() — graceful with thin data');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    suite.check('no sales, no teams -> no awards, no throw', evalIn(ctx, 'computeAwards([], []).length') === 0);
    suite.check('only retained players -> no player awards',
      evalIn(ctx, `computeAwards([{id:'x', name:'G', result:'sold', via:'assigned', team:'L', price:9, basePrice:1, time:1}], []).length`) === 0);
    suite.check('a zero base price never divides by zero (no Jump/Bargain, Most Expensive still there)', (function(){
      const a = evalIn(ctx, `computeAwards([{id:'x', name:'Z', result:'sold', via:'auction', team:'L', price:5, basePrice:0, time:1}], [])`);
      return a.length === 1 && a[0].title === 'Most Expensive Buy';
    })());
    suite.check('a single buying team gets no "Thriftiest" (nobody to compare with)', (function(){
      const a = evalIn(ctx, `computeAwards([], [{id:'t', name:'L', budget:100, squad:{a:{price:5}}}])`);
      return !a.some(x => x.title === 'Thriftiest Team') && a.some(x => x.title === 'Biggest Spender');
    })());
  }

  suite.section('3. the awards button + panel on the completed home screen');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `
      window.__settingsCache = {currencyUnit:'Cr'};
      pv.teams = {t1:{name:'Lions', budget:200, squad:{p1:{price:40}}}, t2:{name:'Tigers', budget:100, squad:{p2:{price:12}}}};
      pv.sales = ${SALES};
      pv.auction = {completed:true};
      showAwards = false; showPastResults = false;
    `);
    let html = evalIn(ctx, 'renderPublic(); document.getElementById("tabContent").innerHTML');
    suite.check('home screen offers the awards button', html.includes('View auction awards') && html.includes('toggleAwards()'));
    suite.check('  and still the original results button', html.includes('View previous bidding results'));
    suite.check('awards are NOT shown until asked', !html.includes('pv-awards'));

    html = evalIn(ctx, 'toggleAwards(); document.getElementById("tabContent").innerHTML');
    suite.check('pressing it shows the awards panel', html.includes('pv-awards') && html.includes('Most Expensive Buy'));
    suite.check('  and the button flips to "Hide"', html.includes('Hide auction awards'));
    suite.check('  without opening the results table', !html.includes('Previous Bidding Results'));

    html = evalIn(ctx, 'toggleAwards(); document.getElementById("tabContent").innerHTML');
    suite.check('pressing again hides it', !html.includes('pv-awards'));

    html = evalIn(ctx, 'pv.sales = []; renderPublic(); document.getElementById("tabContent").innerHTML');
    suite.check('no history -> no awards button at all', !html.includes('View auction awards'));

    html = evalIn(ctx, `pv.sales = ${SALES}; pv.auction = {currentPlayerId:null, awaitingNext:true}; showAwards = true; renderPublic(); document.getElementById("tabContent").innerHTML`);
    suite.check('never shown while the auction is still live, even if toggled on', !html.includes('pv-awards'));

    const esc = evalIn(ctx, `pv.auction = {completed:true}; pv.sales = [{id:'q', name:'<b>X</b>', result:'sold', via:'auction', team:'L', price:5, basePrice:1, time:1}]; renderAwardsPanel([])`);
    suite.check('award winner names are HTML-escaped', !esc.includes('<b>X</b>') && esc.includes('&lt;b&gt;'));
  }

  /* ---------------- target list ---------------- */
  function teamCtx(withStorage){
    const ctx = ctxFor(['js/shared.js', 'js/team.js']);
    const store = withStorage ? fakeStorage() : null;
    if(store) ctx.localStorage = store;
    evalIn(ctx, `
      tSession = {role:'team', teamId:'t1', label:'Lions Owner'};
      tstate.settings = {bidIncrement:1, defaultBasePrice:5, maxPlayersPerTeam:18, minPlayersPerTeam:0, currencyUnit:'Cr'};
      tstate.teams = {t1:{name:'Lions', budget:100, squad:{}}};
      tstate.players = {
        p1:{name:'Kohli',  category:'Batsman', basePrice:15, status:'pending'},
        p2:{name:'Bumrah', category:'Bowler',  basePrice:12, status:'pending'},
        p3:{name:'Gill',   category:'Batsman', basePrice:10, status:'sold'}
      };
      tstate.auction = {};
    `);
    return {ctx, store};
  }

  suite.section('4. target list — starring, persistence, privacy');
  {
    const {ctx, store} = teamCtx(true);
    let html = evalIn(ctx, 'renderDashboard()');
    suite.check('lists pending players as star chips', html.includes('pv-target-list') && html.includes('Kohli') && html.includes('Bumrah'));
    suite.check('a player already sold is not offered', !/pv-target-name">Gill/.test(html));
    suite.check('starts with nothing starred', html.includes('0 starred'));

    ctx.__writes.length = 0;
    evalIn(ctx, "toggleTarget('p2')");
    suite.check('starring saves to localStorage under this team', JSON.parse(store.data['pv_targets_t1'] || '[]').includes('p2'));
    suite.check('  and writes NOTHING to Firebase', ctx.__writes.length === 0);
    html = evalIn(ctx, 'renderDashboard()');
    suite.check('the starred player shows as on and sorts first',
      html.includes('1 starred') && html.indexOf('Bumrah') < html.indexOf('Kohli') && /pv-target is-on[^>]*toggleTarget\('p2'\)/.test(html));

    evalIn(ctx, "toggleTarget('p2')");
    suite.check('tapping again un-stars it', !JSON.parse(store.data['pv_targets_t1']).includes('p2'));

    // a fresh page load reads the saved list back
    store.data['pv_targets_t1'] = JSON.stringify(['p1']);
    const reload = teamCtx(false);
    reload.ctx.localStorage = store;
    suite.check('a reload restores the saved targets', evalIn(reload.ctx, "isTarget('p1') && !isTarget('p2')"));

    // another team on the same device has its own list
    evalIn(reload.ctx, "__targets = null; tSession = {role:'team', teamId:'t2', label:'Tigers'};");
    suite.check('another team signed in on the same device does not see it', evalIn(reload.ctx, "!isTarget('p1')"));
  }

  suite.section('5. "Your target is up!"');
  {
    const {ctx} = teamCtx(true);
    evalIn(ctx, "toggleTarget('p1'); tstate.auction = {currentPlayerId:'p1', currentPrice:0, leaderTeamId:null, biddingOpen:true};");
    let html = evalIn(ctx, 'renderDashboard()');
    suite.check('shows a "Your target is up" chip when a starred player is on the block', html.includes('pv-target-chip') && /Your target is up/.test(html));
    suite.check('  the chip sits INSIDE the lot card, not as a separate bar above it',
      html.indexOf('card pv-lot is-target') !== -1 && html.indexOf('pv-target-chip') > html.indexOf('card pv-lot is-target')
      && html.indexOf('pv-target-chip') < html.indexOf('pv-lot-grid'));
    suite.check('  the old separate alert bar is gone', !html.includes('pv-target-alert'));
    suite.check('  and rings the lot card', html.includes('card pv-lot is-target'));
    suite.check('  and tags the list chip as on the block', /pv-target is-on is-live/.test(html));

    evalIn(ctx, "tstate.auction = {currentPlayerId:'p2', currentPrice:0, leaderTeamId:null, biddingOpen:true};");
    html = evalIn(ctx, 'renderDashboard()');
    suite.check('no chip for a player who is not a target', !html.includes('pv-target-chip') && !html.includes('is-target'));

    evalIn(ctx, "tstate.auction = {completed:true};");
    html = evalIn(ctx, 'renderDashboard()');
    suite.check('the list is hidden once the auction is complete', !html.includes('pv-target-list'));
  }

  suite.section('6. no localStorage at all (private mode / blocked storage)');
  {
    const {ctx} = teamCtx(false);
    suite.check('renders without throwing', (function(){ try{ evalIn(ctx, 'renderDashboard()'); return true; }catch(e){ return false; } })());
    evalIn(ctx, "toggleTarget('p1')");
    suite.check('starring still works for this tab (kept in memory)', evalIn(ctx, "isTarget('p1')"));
  }

  return suite.summarize();
}

module.exports = { name: 'awards-targets', run };

if (require.main === module){
  process.exit(printSummary(run()));
}
