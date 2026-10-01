/* ============================================================
   tests/pick-replay-maxbid.test.js — three features added 2026-10-04:

     1. Slot-machine player pick (public.js): showSlotPick()/tickSlotPick()/
        slotPickMarkup()/dismissSlotPick(), wired to the `auction` listener
        via __slotPickPending/__auctionSeen.
     2. Highlights replay (public.js): replaySales()/startReplay()/
        showReplaySlide()/nextReplaySlide()/stopReplay() and the
        "▶ Replay the auction" button on the completed home screen.
     3. "Max You Can Bid" (shared.js maxAffordableBid + team.js's chip).

   Timers are captured (not run) the same way takeover.test.js does, so each
   step of the setTimeout chains can be stepped through and inspected.

   Run this after touching any of those.
   ============================================================ */
const { ctxFor, evalIn } = require('./lib/dom-stub');
const { makeSuite, printSummary } = require('./lib/suite');

/** Capture timers + created/appended elements instead of the harness's
 *  run-immediately default. */
function captureDom(ctx){
  evalIn(ctx, `
    window.__settingsCache = {currencyUnit:'Cr'};
    window.__timers = []; window.__appended = []; window.__made = [];
    setTimeout = function(fn, ms){ window.__timers.push({fn, ms}); return window.__timers.length; };
    clearTimeout = function(){};
    const realCreate = document.createElement;
    document.createElement = function(){
      const el = realCreate.call(document);
      el.removed = false; el.attrs = {};
      el.remove = function(){ el.removed = true; };
      el.setAttribute = function(k, v){ el.attrs[k] = v; };
      el.classes = []; el.classList = { add(c){ el.classes.push(c); } };
      window.__made.push(el);
      return el;
    };
    document.body.appendChild = function(el){ window.__appended.push(el); };
  `);
}
const lastTimer = ctx => evalIn(ctx, 'window.__timers[window.__timers.length-1]');
const fireLast = ctx => evalIn(ctx, 'window.__timers[window.__timers.length-1].fn()');

const PLAYERS = `{
  p1:{name:'Kohli',  category:'Batsman', basePrice:15, status:'pending'},
  p2:{name:'Bumrah', category:'Bowler',  basePrice:12, status:'pending'},
  p3:{name:'Jadeja', category:'All-Rounder', basePrice:8, status:'pending'}
}`;

function run(){
  const suite = makeSuite('pick-replay-maxbid');

  /* ---------------- 1. slot machine ---------------- */
  suite.section('1. slot-machine pick — when it fires');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `
      window.__settingsCache = {currencyUnit:'Cr'};
      pv.players = ${PLAYERS};
      pv.teams = {t1:{name:'Lions', budget:100, squad:{}}};
      window.__spins = [];
      showSlotPick = function(p){ window.__spins.push(p ? p.name : null); };
    `);
    const trig = v => evalIn(ctx, `db.ref('auction')._trigger(${v})`);

    trig(`{currentPlayerId:'p1', currentPrice:0, leaderTeamId:null, biddingOpen:true}`);
    suite.check('never on the first snapshot (opening the page mid-lot)', evalIn(ctx, 'window.__spins.length') === 0);

    trig(`{currentPlayerId:'p1', currentPrice:16, leaderTeamId:'t1', biddingOpen:true}`);
    suite.check('never for a bid on the same player', evalIn(ctx, 'window.__spins.length') === 0);

    trig(`{currentPlayerId:null, awaitingNext:true}`);
    suite.check('never when the floor empties', evalIn(ctx, 'window.__spins.length') === 0);

    trig(`{currentPlayerId:'p2', currentPrice:0, leaderTeamId:null, biddingOpen:true}`);
    suite.check('spins for a genuinely new player, landing on them', evalIn(ctx, 'JSON.stringify(window.__spins)') === '["Bumrah"]');

    trig(`{currentPlayerId:'p2', currentPrice:0, leaderTeamId:null, biddingOpen:false, paused:true}`);
    suite.check('a pause on the same player does not re-spin', evalIn(ctx, 'window.__spins.length') === 1);
  }

  suite.section('2. slot-machine pick — the reel itself');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    captureDom(ctx);
    evalIn(ctx, `pv.players = ${PLAYERS};`);

    evalIn(ctx, `showSlotPick(pv.players.p1)`);
    suite.check('puts one overlay on the page', evalIn(ctx, 'window.__appended.length') === 1);
    suite.check('  hidden from screen readers (the lot underneath is the real announcement)', evalIn(ctx, 'window.__made[0].attrs["aria-hidden"]') === 'true');
    suite.check('  tapping it skips', /dismissSlotPick/.test(evalIn(ctx, 'window.__made[0].attrs.onclick')));
    suite.check('  starts on someone OTHER than the pick', !/pv-slot-name">Kohli/.test(evalIn(ctx, 'window.__made[0].innerHTML')));

    // step through every reel tick
    const ticks = evalIn(ctx, 'SLOT_TICKS');
    const delays = [];
    for(let i = 1; i < ticks; i++){
      delays.push(lastTimer(ctx).ms);
      fireLast(ctx);
    }
    suite.check('the reel slows down (each delay >= the one before)', delays.every((d, i) => i === 0 || d >= delays[i - 1]), JSON.stringify(delays));
    suite.check('  and never shows the real pick before landing', !/pv-slot-name">Kohli/.test(evalIn(ctx, 'window.__made[0].innerHTML')));

    fireLast(ctx); // the landing tick
    const landed = evalIn(ctx, 'window.__made[0].innerHTML');
    suite.check('lands on the chosen player', /pv-slot-name">Kohli/.test(landed) && landed.includes('is-landed') && landed.includes('Up next'));
    suite.check('  holds there for SLOT_HOLD_MS', lastTimer(ctx).ms === evalIn(ctx, 'SLOT_HOLD_MS'));

    fireLast(ctx);
    suite.check('then fades out', evalIn(ctx, 'window.__made[0].classes.includes("is-leaving")') && lastTimer(ctx).ms === evalIn(ctx, 'SLOT_EXIT_MS'));
    fireLast(ctx);
    suite.check('then is removed', evalIn(ctx, 'window.__made[0].removed') && evalIn(ctx, '__slotEl') === null);
  }

  suite.section('3. slot-machine pick — skipping and edge cases');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    captureDom(ctx);
    evalIn(ctx, `pv.players = ${PLAYERS}; showSlotPick(pv.players.p1);`);
    const pending = evalIn(ctx, 'window.__timers.length');
    evalIn(ctx, 'dismissSlotPick()');
    suite.check('a tap removes it immediately', evalIn(ctx, 'window.__made[0].removed'));
    evalIn(ctx, `window.__timers[${pending - 1}].fn()`);
    suite.check('  and a tick that was already pending does nothing', evalIn(ctx, 'window.__timers.length') === pending);

    evalIn(ctx, 'window.__appended.length = 0; onSlotKey({key:"Escape"});');
    evalIn(ctx, 'showSlotPick(pv.players.p2); onSlotKey({key:"a"});');
    suite.check('an ordinary key does not skip', !evalIn(ctx, 'window.__made[window.__made.length-1].removed'));
    evalIn(ctx, 'onSlotKey({key:"Escape"});');
    suite.check('Escape skips', evalIn(ctx, 'window.__made[window.__made.length-1].removed'));

    evalIn(ctx, `window.__appended.length = 0; pv.players = {p1:{name:'Kohli'}}; showSlotPick(pv.players.p1);`);
    suite.check('nobody else to spin through -> no overlay', evalIn(ctx, 'window.__appended.length') === 0);

    evalIn(ctx, `window.__appended.length = 0; pv.players = ${PLAYERS};
      window.matchMedia = function(){ return {matches:true}; }; showSlotPick(pv.players.p1);`);
    suite.check('prefers-reduced-motion -> no overlay', evalIn(ctx, 'window.__appended.length') === 0);

    const esc = evalIn(ctx, `slotPickMarkup({name:'<i>X</i>', category:'<b>c</b>'})`);
    suite.check('names and categories are HTML-escaped', !esc.includes('<i>X</i>') && !esc.includes('<b>c</b>'));
  }

  suite.section('3b. team.html waits out the big screen\'s spin');
  {
    // The two pages must agree on the length — prove slotPickDurationMs()
    // (what team.js waits) equals what public.js's reel actually schedules
    // from start to the moment it starts fading away.
    const pub = ctxFor(['js/shared.js', 'js/public.js']);
    captureDom(pub);
    evalIn(pub, `pv.players = ${PLAYERS}; showSlotPick(pv.players.p1);`);
    let spun = 0;
    for(let guard = 0; guard < 50 && !evalIn(pub, 'window.__made[0].classes.includes("is-leaving")'); guard++){
      spun += lastTimer(pub).ms;
      fireLast(pub);
    }
    suite.check('team.js waits exactly as long as the big screen spins + holds', spun === evalIn(pub, 'slotPickDurationMs()'), `reel ${spun}ms vs ${evalIn(pub, 'slotPickDurationMs()')}ms`);

    const ctx = ctxFor(['js/shared.js', 'js/team.js']);
    evalIn(ctx, `
      window.__timers = [];
      setTimeout = function(fn, ms){ window.__timers.push({fn, ms}); return window.__timers.length; };
      clearTimeout = function(){};
      tSession = {role:'team', teamId:'t1', label:'Lions'};
      attachListeners();
      tstate.settings = {bidIncrement:1, defaultBasePrice:5, maxPlayersPerTeam:18, minPlayersPerTeam:0, currencyUnit:'Cr'};
      window.__settingsCache = tstate.settings;
      tstate.teams = {t1:{name:'Lions', budget:100, squad:{}}, t2:{name:'Tigers', budget:100, squad:{}}};
      tstate.players = ${PLAYERS};
    `);
    const trig = v => evalIn(ctx, `db.ref('auction')._trigger(${v})`);
    const dash = () => evalIn(ctx, 'renderDashboard()');

    trig(`{currentPlayerId:'p1', currentPrice:0, leaderTeamId:null, biddingOpen:true}`);
    suite.check('first snapshot (page opened mid-lot): no wait, the lot shows at once', !dash().includes('pv-pick-wait') && /pv-name">Kohli/.test(dash()));

    trig(`{currentPlayerId:'p1', currentPrice:16, leaderTeamId:'t2', biddingOpen:true}`);
    suite.check('a bid on the same player: no wait', !dash().includes('pv-pick-wait'));

    trig(`{currentPlayerId:null, awaitingNext:true}`);
    trig(`{currentPlayerId:'p2', currentPrice:0, leaderTeamId:null, biddingOpen:true}`);
    let html = dash();
    suite.check('a NEW player: "Picking the next player…" instead of the lot', html.includes('pv-pick-wait') && html.includes('Picking the next player'));
    suite.check('  the player is not revealed anywhere on the page', !html.includes('pv-lot-grid') && !/pv-name">Bumrah/.test(html));
    suite.check('  no bid buttons', !html.includes('placeMyBid('));
    suite.check('  the target list does not tag them "on the block" either', !html.includes('is-live'));
    suite.check('  the reveal is scheduled for slotPickDurationMs()', lastTimer(ctx).ms === evalIn(ctx, 'slotPickDurationMs()'));

    evalIn(ctx, `tstate.auction = {currentPlayerId:'p2', currentPrice:0, leaderTeamId:null, biddingOpen:true};`);
    ctx.__writes.length = 0;
    evalIn(ctx, 'placeMyBid(1)');
    suite.check('placeMyBid() refuses during the wait, writing nothing', ctx.__writes.length === 0
      && ctx.__toasts.some(t => /still being revealed/.test(t[1])));

    fireLast(ctx);
    html = dash();
    suite.check('once the spin is over, the lot and the bid buttons appear', !html.includes('pv-pick-wait') && /pv-name">Bumrah/.test(html) && html.includes('placeMyBid(1)'));

    // floor empties mid-hold -> the hold is dropped, nothing lingers
    trig(`{currentPlayerId:'p3', currentPrice:0, leaderTeamId:null, biddingOpen:true}`);
    suite.check('another new player starts a fresh wait', dash().includes('pv-pick-wait'));
    trig(`{currentPlayerId:null, awaitingNext:true}`);
    suite.check('the floor emptying mid-wait clears it', evalIn(ctx, '__pickHoldPlayer') === null);

    // nobody else to spin through -> the big screen skips its spin, so no wait here either
    evalIn(ctx, `tstate.players = {p1:{name:'Kohli', status:'pending'}};`);
    trig(`{currentPlayerId:'p1', currentPrice:0, leaderTeamId:null, biddingOpen:true}`);
    suite.check('no wait when the big screen would have nobody else to spin through', !dash().includes('pv-pick-wait'));
  }

  /* ---------------- 2. replay ---------------- */
  const SALES = `[
    {id:'a', name:'Kohli',  result:'sold',   via:'auction',  team:'Lions',  price:40, basePrice:10, image:'', time:30},
    {id:'b', name:'Gill',   result:'sold',   via:'assigned', team:'Lions',  price:90, basePrice:5,  image:'', time:20},
    {id:'c', name:'Bumrah', result:'sold',   via:'auction',  team:'Tigers', price:12, basePrice:12, image:'', time:10},
    {id:'d', name:'Pant',   result:'unsold', via:'auction',  team:null,     price:null, basePrice:8, image:'', time:5}
  ]`;

  suite.section('4. highlights replay — what it plays, and the button');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `window.__settingsCache = {currencyUnit:'Cr'}; pv.sales = ${SALES}; pv.teams = {}; pv.auction = {completed:true};`);
    suite.check('replays auction sales only, oldest first (no retained, no unsold)',
      evalIn(ctx, 'replaySales().map(s => s.name).join(",")') === 'Bumrah,Kohli');

    let html = evalIn(ctx, 'renderPublic(); document.getElementById("tabContent").innerHTML');
    suite.check('the completed home screen offers "Replay the auction"', html.includes('Replay the auction') && html.includes('startReplay()'));
    suite.check('  alongside the awards and results buttons', html.includes('View auction awards') && html.includes('View previous bidding results'));

    html = evalIn(ctx, `pv.sales = [${'{id:"b", name:"Gill", result:"sold", via:"assigned", team:"Lions", price:90, basePrice:5, time:1}'}]; renderPublic(); document.getElementById("tabContent").innerHTML`);
    suite.check('no replay button when nothing was sold at auction', !html.includes('Replay the auction'));
  }

  suite.section('5. highlights replay — the slideshow');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    captureDom(ctx);
    evalIn(ctx, `pv.sales = ${SALES}; startReplay();`);
    const el = () => evalIn(ctx, 'window.__made[0].innerHTML');

    suite.check('opens one overlay, as a labelled dialog', evalIn(ctx, 'window.__appended.length') === 1
      && evalIn(ctx, 'window.__made[0].attrs.role') === 'dialog');
    suite.check('slide 1 is the oldest auction sale', /pv-replay-name">Bumrah/.test(el()) && el().includes('Lot 1 of 2'));
    suite.check('  each slide lasts REPLAY_SLIDE_MS', lastTimer(ctx).ms === evalIn(ctx, 'REPLAY_SLIDE_MS'));
    suite.check('  its progress bar runs for the same time', el().includes(`animation-duration:${evalIn(ctx, 'REPLAY_SLIDE_MS')}ms`));

    fireLast(ctx);
    suite.check('the timer advances to slide 2', /pv-replay-name">Kohli/.test(el()) && el().includes('Lot 2 of 2'));

    fireLast(ctx);
    suite.check('then a wrap-up slide with the totals', el().includes("That's a wrap") && el().includes('Players sold') && /Top buy: <strong>Kohli/.test(el()));

    fireLast(ctx);
    suite.check('then fades out', evalIn(ctx, 'window.__made[0].classes.includes("is-leaving")'));
    fireLast(ctx);
    suite.check('then is removed', evalIn(ctx, 'window.__made[0].removed') && evalIn(ctx, '__replayEl') === null);
  }

  suite.section('6. highlights replay — controls');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    captureDom(ctx);
    evalIn(ctx, `pv.sales = ${SALES}; startReplay();`);
    suite.check('tapping the overlay goes to the next slide', /nextReplaySlide/.test(evalIn(ctx, 'window.__made[0].attrs.onclick')));
    evalIn(ctx, 'nextReplaySlide()');
    suite.check('  next jumps straight to slide 2', evalIn(ctx, 'window.__made[0].innerHTML').includes('Lot 2 of 2'));
    evalIn(ctx, 'onReplayKey({key:"ArrowRight"})');
    suite.check('  → also advances', evalIn(ctx, 'window.__made[0].innerHTML').includes("That's a wrap"));
    suite.check('the Close button stops it without also counting as a "next" tap',
      /event\.stopPropagation\(\); stopReplay\(\)/.test(evalIn(ctx, 'window.__made[0].innerHTML')));
    evalIn(ctx, 'onReplayKey({key:"Escape"})');
    suite.check('Escape closes it', evalIn(ctx, 'window.__made[0].removed'));
    const before = evalIn(ctx, 'window.__made[0].innerHTML');
    evalIn(ctx, 'nextReplaySlide()');
    suite.check('next after closing does nothing', evalIn(ctx, 'window.__made[0].innerHTML') === before);

    evalIn(ctx, 'window.__appended.length = 0; pv.sales = []; startReplay();');
    suite.check('nothing to replay -> no overlay', evalIn(ctx, 'window.__appended.length') === 0);

    const esc = evalIn(ctx, `replaySlideMarkup({name:'<i>X</i>', team:'<b>T</b>', price:5}, 0, 1)`);
    suite.check('names are HTML-escaped', !esc.includes('<i>X</i>') && !esc.includes('<b>T</b>'));
  }

  /* ---------------- 3. max you can bid ---------------- */
  suite.section('7. maxAffordableBid() — the inverse of teamCanAffordBid()');
  {
    const ctx = ctxFor(['js/shared.js']);
    const S = `{maxPlayersPerTeam:5, minPlayersPerTeam:4, defaultBasePrice:5, bidIncrement:1}`;
    // 100 purse, 1 player owned at 20 -> 80 left; buying one more leaves
    // 4-2 = 2 slots to fill at base 5 -> reserve 10 -> max 70
    const T = `{budget:100, squad:{a:{price:20}}}`;
    suite.check('purse minus the reserve for the rest of the minimum squad', evalIn(ctx, `maxAffordableBid(${T}, ${S})`) === 70);
    suite.check('  teamCanAffordBid agrees that exact amount is legal', evalIn(ctx, `teamCanAffordBid(${T}, ${S}, 70)`) === true);
    suite.check('  and that a penny more is not', evalIn(ctx, `teamCanAffordBid(${T}, ${S}, 70.5)`) === false);
    suite.check('a full squad can bid nothing',
      evalIn(ctx, `maxAffordableBid({budget:100, squad:{a:{price:1},b:{price:1},c:{price:1},d:{price:1},e:{price:1}}}, ${S})`) === 0);
    suite.check('never negative when the reserve swallows the purse',
      evalIn(ctx, `maxAffordableBid({budget:12, squad:{}}, ${S})`) === 0);
    suite.check('missing settings default sensibly (no min squad -> the whole purse)',
      evalIn(ctx, `maxAffordableBid({budget:50, squad:{}}, {})`) === 50);
  }

  suite.section('8. "Max You Can Bid" chip on team.html');
  {
    const ctx = ctxFor(['js/shared.js', 'js/team.js']);
    evalIn(ctx, `
      tSession = {role:'team', teamId:'t1', label:'Lions'};
      tstate.settings = {bidIncrement:1, defaultBasePrice:5, maxPlayersPerTeam:5, minPlayersPerTeam:4, currencyUnit:'Cr'};
      window.__settingsCache = tstate.settings;
      tstate.teams = {t1:{name:'Lions', budget:100, squad:{a:{price:20}}}};
      tstate.players = {}; tstate.auction = {};
    `);
    let html = evalIn(ctx, 'renderDashboard()');
    suite.check('shows the max as a plain .chip, same design as its neighbours',
      html.includes('<div class="chip"><div class="val">70 Cr</div><div class="lbl">Max You Can Bid</div></div>'), html.slice(0, 600));
    suite.check('  placed right after Purse Remaining',
      html.indexOf('Purse Remaining') < html.indexOf('Max You Can Bid') && html.indexOf('Max You Can Bid') < html.indexOf('Squad Size'));

    evalIn(ctx, `tstate.teams.t1.squad = {a:{price:1},b:{price:1},c:{price:1},d:{price:1},e:{price:1}};`);
    html = evalIn(ctx, 'renderDashboard()');
    suite.check('a full squad says "Squad full" instead of 0', html.includes('<div class="val">Squad full</div><div class="lbl">Max You Can Bid</div>'));
  }

  return suite.summarize();
}

module.exports = { name: 'pick-replay-maxbid', run };

if (require.main === module){
  process.exit(printSummary(run()));
}
