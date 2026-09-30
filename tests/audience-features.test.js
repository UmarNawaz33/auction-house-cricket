/* ============================================================
   tests/audience-features.test.js — the audience-engagement features in
   js/public.js: the "New Record" banner, the bidding-war visual, the
   player-reveal animation, and spectator reactions.

   (A fifth feature, a live purse race bar, was built and then removed by
   request — see git history / CLAUDE.md §6a if you're wondering why a
   "3. LIVE PURSE RACE BAR" section isn't here; nothing currently in
   public.js references renderPurseRace()/`.pv-race*` and nothing should.)

   All are public.js-only (the other three pages are worked by the people
   running the auction, not an audience) and none of them write to Firebase
   — reactions in particular are explicitly local-only, covered in their own
   section below.

   Run this after touching: public.js's handleAuctionTransition/registerBid/
   isBiddingWarActive (bidding war + reveal flag), seedRecordFromHistory/
   isNewRecord/updateRecord (record banner), or sendReaction/clearReactions/
   injectReactionBar (reactions).
   ============================================================ */
const { ctxFor, evalIn } = require('./lib/dom-stub');
const { makeSuite, printSummary } = require('./lib/suite');

/** document.createElement/body.appendChild/getElementById, all overridden
 *  to actually track state — the base dom-stub's versions are no-ops (see
 *  its own header comment), which is enough for render-function tests but
 *  not for code that creates elements, appends them, and later looks them
 *  up again, exactly like takeover.test.js's own "showSoldTakeover / dismiss"
 *  section needed. getElementById here searches window.__made by the `.id`
 *  PROPERTY (not attribute) because this file's code sets `el.id = ...`
 *  directly, never setAttribute('id', ...). */
function trackedDom(ctx){
  evalIn(ctx, `
    window.__timers = []; window.__appended = []; window.__made = [];
    setTimeout = function(fn, ms){ window.__timers.push({fn, ms}); return window.__timers.length; };
    clearTimeout = function(){};
    const realCreate = document.createElement;
    document.createElement = function(tag){
      const el = realCreate.call(document);
      el.tag = tag; el.removed = false; el.attrs = {};
      el.remove = function(){ el.removed = true; };
      el.setAttribute = function(k, v){ el.attrs[k] = v; };
      el.classes = []; el.classList = { add(c){ el.classes.push(c); }, remove(){}, toggle(){ return true; } };
      window.__made.push(el);
      return el;
    };
    document.body.appendChild = function(el){ window.__appended.push(el); };
    document.getElementById = function(id){
      const hits = window.__made.filter(el => el.id === id && !el.removed);
      return hits.length ? hits[hits.length - 1] : null;
    };
  `);
}

async function run(){
  const suite = makeSuite('audience-features');

  /* ============================================================
     1. "NEW RECORD" BANNER
     ============================================================ */
  suite.section('record banner: seedRecordFromHistory / isNewRecord / updateRecord');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    const history = [
      {id:'p1', result:'sold', via:'auction', price:20, time:3},
      {id:'p2', result:'sold', via:'assigned', price:99, time:2}, // retained — must not count
      {id:'p3', result:'unsold', price:null, time:1}
    ];
    evalIn(ctx, `seedRecordFromHistory(${JSON.stringify(history)})`);
    suite.check('seeds from the highest REAL auction sale only, ignoring assigned/unsold',
      evalIn(ctx, '__recordHighest') === 20, 'got ' + evalIn(ctx, '__recordHighest'));

    suite.check('a price above the seeded record is a new record',
      evalIn(ctx, `isNewRecord({price:21, result:'sold'})`) === true);
    suite.check('a price equal to the record is NOT a new record (must beat it, not tie)',
      evalIn(ctx, `isNewRecord({price:20, result:'sold'})`) === false);
    suite.check('a price below the record is not a new record',
      evalIn(ctx, `isNewRecord({price:19, result:'sold'})`) === false);

    evalIn(ctx, `updateRecord({price:25})`);
    suite.check('updateRecord raises the bar', evalIn(ctx, '__recordHighest') === 25);
    evalIn(ctx, `updateRecord({price:10})`);
    suite.check('updateRecord never lowers it', evalIn(ctx, '__recordHighest') === 25);

    const fresh = ctxFor(['js/shared.js', 'js/public.js']);
    suite.check('with no history at all, nothing is ever a "record" (nothing to beat)',
      evalIn(fresh, `isNewRecord({price:1000000, result:'sold'})`) === false);
  }

  suite.section('record banner: soldTakeoverMarkup(sale, {isRecord}) content');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `window.__settingsCache = {currencyUnit:'Cr'};`);
    const sale = "{name:'Kohli', team:'Lions', price:50, image:''}";
    const normal = evalIn(ctx, `soldTakeoverMarkup(${sale})`);
    suite.check('without the flag, the ordinary "Sold" stamp', /pv-takeover-stamp">Sold</.test(normal));
    suite.check('  and no is-record class anywhere', !/is-record/.test(normal));

    const record = evalIn(ctx, `soldTakeoverMarkup(${sale}, {isRecord:true})`);
    suite.check('with the flag, the stamp reads "New Record!"', /pv-takeover-stamp">New Record!</.test(record));
    suite.check('  and the card carries the is-record modifier class', /pv-takeover-card is-record/.test(record));
    suite.check('  everything else about the card is unchanged (name, team, price, timer)',
      /Kohli/.test(record) && /<strong>Lions<\/strong>/.test(record) && /pv-amt">50</.test(record) && /id="pvTakeoverCount">5</.test(record));
  }

  suite.section('record banner: wired into the real sale gate end-to-end');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `
      window.__shown = [];
      showSoldTakeover = function(sale, opts){ window.__shown.push({price: sale.price, isRecord: !!(opts && opts.isRecord)}); };
      celebrateSaleFirework = function(){};
      playPublicSoldSound = function(){};
    `);
    const sold = (id, price, time) => `{id:'${id}', name:'P${id}', result:'sold', via:'auction', team:'Lions', price:${price}, time:${time}}`;

    evalIn(ctx, `maybeCelebrateNewSale([${sold('p1', 20, 1)}]);`); // first snapshot: seeds, never announces
    suite.check('first-ever sale is never flagged as a record', evalIn(ctx, 'window.__shown.length') === 0);

    evalIn(ctx, `maybeCelebrateNewSale([${sold('p2', 15, 2)}, ${sold('p1', 20, 1)}]);`);
    suite.check('a sale BELOW the existing record shows normally, not as a record',
      evalIn(ctx, 'window.__shown[0].isRecord') === false, JSON.stringify(evalIn(ctx, 'window.__shown[0]')));

    evalIn(ctx, `maybeCelebrateNewSale([${sold('p3', 35, 3)}, ${sold('p2', 15, 2)}]);`);
    suite.check('a sale ABOVE the record is flagged, and the record then updates',
      evalIn(ctx, 'window.__shown[1].isRecord') === true && evalIn(ctx, '__recordHighest') === 35);

    evalIn(ctx, `maybeCelebrateNewSale([${sold('p4', 35, 4)}, ${sold('p3', 35, 3)}]);`);
    suite.check('tying the record (not beating it) is NOT flagged',
      evalIn(ctx, 'window.__shown[2].isRecord') === false);
  }

  /* ============================================================
     2. BIDDING-WAR VISUAL
     ============================================================ */
  suite.section('bidding war: handleAuctionTransition detects real bids, not just any write');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `clearReactions = function(){};`); // no DOM tracking needed in this section
    const bid = (price, leader) => `{currentPlayerId:'p1', currentPrice:${price}, leaderTeamId:${leader ? `'${leader}'` : 'null'}}`;

    evalIn(ctx, `handleAuctionTransition({}, ${bid(0, null)})`); // new player revealed
    suite.check('a new player resets the pulse counter to empty', evalIn(ctx, '__bidPulseTimes.length') === 0);

    evalIn(ctx, `handleAuctionTransition(${bid(0,null)}, ${bid(15,'t1')})`); // first bid
    suite.check('a genuine bid (price+leader change) registers one pulse', evalIn(ctx, '__bidPulseTimes.length') === 1);

    evalIn(ctx, `handleAuctionTransition(${bid(15,'t1')}, ${bid(15,'t1')})`); // unrelated re-render, same values
    suite.check('an unchanged snapshot (e.g. another listener firing) does NOT add a pulse',
      evalIn(ctx, '__bidPulseTimes.length') === 1);

    evalIn(ctx, `handleAuctionTransition(${bid(15,'t1')}, ${bid(16,'t2')})`);
    suite.check('a second genuine bid adds another pulse', evalIn(ctx, '__bidPulseTimes.length') === 2);
  }

  suite.section('bidding war: registerBid() lights up after enough bids in the window, and clears itself');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `window.__timers = []; setTimeout = function(fn, ms){ window.__timers.push({fn, ms}); return 1; };`);

    evalIn(ctx, 'registerBid(); registerBid();');
    suite.check('not yet active with only 2 of the required 3', evalIn(ctx, 'isBiddingWarActive()') === false);

    evalIn(ctx, 'registerBid();');
    suite.check('active once the 3rd bid lands within the window', evalIn(ctx, 'isBiddingWarActive()') === true);
    suite.check('schedules exactly one clear-check timer, timed to the display window',
      evalIn(ctx, 'window.__timers.length') === 1 && evalIn(ctx, 'window.__timers[0].ms') === 5050);

    evalIn(ctx, '__biddingWarUntil = Date.now() - 1;'); // simulate the window having elapsed
    suite.check('once elapsed, it reports inactive again', evalIn(ctx, 'isBiddingWarActive()') === false);
  }

  suite.section('bidding war: old pulses fall out of the window (no permanent "always 3" lock-in)');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `window.__timers = []; setTimeout = function(fn, ms){ window.__timers.push({fn, ms}); return 1; };`);
    // two pulses "9+ seconds ago" (outside the window), then one fresh one —
    // should NOT trigger the war (only 1 pulse actually within the window)
    evalIn(ctx, `__bidPulseTimes = [Date.now() - 20000, Date.now() - 15000];`);
    evalIn(ctx, 'registerBid();');
    suite.check('stale pulses are pruned, so 1 fresh bid alone does not trigger it',
      evalIn(ctx, 'isBiddingWarActive()') === false, 'pulses: ' + JSON.stringify(evalIn(ctx, '__bidPulseTimes')));
  }

  suite.section('bidding war: renderLiveLot() shows the tag only while active');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `window.__settingsCache = {currencyUnit:'Cr'}; pv.sales = [];`);
    const player = "{name:'Kohli', category:'Batsman', basePrice:15, image:''}";

    evalIn(ctx, `__biddingWarUntil = 0;`);
    let html = evalIn(ctx, `renderLiveLot({currentPrice:20}, ${player}, null)`);
    suite.check('no tag when not active', !/pv-war-tag/.test(html));

    evalIn(ctx, `__biddingWarUntil = Date.now() + 5000;`);
    html = evalIn(ctx, `renderLiveLot({currentPrice:20}, ${player}, null)`);
    suite.check('the tag appears while active', /pv-war-tag/.test(html) && /Bidding War/.test(html));
  }

  /* ============================================================
     3. PLAYER REVEAL ANIMATION
     ============================================================ */
  suite.section('reveal: __justRevealed is set for a new player, not for a bid on the same one');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `clearReactions = function(){};`);

    evalIn(ctx, `handleAuctionTransition({}, {currentPlayerId:'p1', currentPrice:0, leaderTeamId:null})`);
    suite.check('a new player on the block sets the flag', evalIn(ctx, '__justRevealed') === true);

    evalIn(ctx, `__justRevealed = false;`); // simulate the listener's own "consumed by the render" reset
    evalIn(ctx, `handleAuctionTransition({currentPlayerId:'p1', currentPrice:0, leaderTeamId:null}, {currentPlayerId:'p1', currentPrice:15, leaderTeamId:'t1'})`);
    suite.check('a bid on the SAME player does not re-set it', evalIn(ctx, '__justRevealed') === false);

    evalIn(ctx, `handleAuctionTransition({currentPlayerId:'p1'}, {currentPlayerId:'p2', currentPrice:0, leaderTeamId:null})`);
    suite.check('a DIFFERENT player (next lot) sets it again', evalIn(ctx, '__justRevealed') === true);
  }

  suite.section('reveal: renderLiveLot() adds is-revealing only while the flag is set');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `window.__settingsCache = {currencyUnit:'Cr'}; pv.sales = [];`);
    const player = "{name:'Kohli', category:'Batsman', basePrice:15, image:''}";

    evalIn(ctx, `__justRevealed = false;`);
    let html = evalIn(ctx, `renderLiveLot({currentPrice:20}, ${player}, null)`);
    suite.check('no is-revealing class when the flag is false', !/is-revealing/.test(html));

    evalIn(ctx, `__justRevealed = true;`);
    html = evalIn(ctx, `renderLiveLot({currentPrice:20}, ${player}, null)`);
    suite.check('is-revealing appears on the lot panel when the flag is true', /pv-lot [\w-]*is-revealing|pv-lot.*is-revealing/.test(html), html.slice(0,120));
  }

  suite.section('reveal: the auction listener consumes the flag after one render (real end-to-end)');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `
      window.__settingsCache = {currencyUnit:'Cr'};
      pv.teams = {}; pv.players = {p1:{name:'Kohli', category:'Batsman', basePrice:15, status:'pending'}};
      pv.sales = [];
    `);
    // drive the exact listener callback registered at file load — simplest
    // way to prove the flag really does get cleared afterward, not just that
    // the pieces work in isolation
    evalIn(ctx, `db.ref('auction')._trigger({currentPlayerId:'p1', currentPrice:0, leaderTeamId:null});`);
    const firstHtml = evalIn(ctx, 'document.getElementById("tabContent").innerHTML');
    suite.check('the render right after a new player appears carries is-revealing', /is-revealing/.test(firstHtml));
    suite.check('the flag is false again immediately after (consumed)', evalIn(ctx, '__justRevealed') === false);

    evalIn(ctx, `db.ref('auction')._trigger({currentPlayerId:'p1', currentPrice:16, leaderTeamId:'t1'});`);
    const secondHtml = evalIn(ctx, 'document.getElementById("tabContent").innerHTML');
    suite.check('a bid on the same lot right after does NOT replay the reveal', !/is-revealing/.test(secondHtml));
  }

  /* ============================================================
     4. SPECTATOR REACTIONS — explicitly client-only, nothing stored
     ============================================================ */
  suite.section('reactions: REACTION_EMOJI is declared before injectReactionBar() is CALLED');
  {
    // This is a regression test for a real bug, not a style preference.
    // injectReactionBar() runs at module load (top-level `injectReactionBar();`
    // near the top of public.js) and reads REACTION_EMOJI, a `const` — which
    // is NOT given a value until ITS OWN declaration line runs, unlike a
    // function declaration. With the declaration below the call, loading the
    // file in a real browser threw "Cannot access 'REACTION_EMOJI' before
    // initialization" immediately, which aborted the ENTIRE script — nothing
    // after that point ever ran, so the whole public page went blank. No
    // Node test here caught it: the default dom-stub's getElementById()
    // always returns a truthy stub (see dom-stub.js's own doc comment), so
    // injectReactionBar()'s "already exists, skip" guard silently
    // short-circuited before ever reaching REACTION_EMOJI — the throw only
    // showed up on an actual page load in an actual browser. Checking
    // SOURCE ORDER directly, rather than trying to re-simulate the dom-stub
    // gap that hid it, is what makes this test actually catch a regression.
    const fs = require('fs');
    const path = require('path');
    const { ROOT } = require('./lib/dom-stub');
    const src = fs.readFileSync(path.join(ROOT, 'js/public.js'), 'utf8');
    const declIdx = src.indexOf('const REACTION_EMOJI');
    const callIdx = src.indexOf('injectReactionBar();');
    suite.check('both are present', declIdx !== -1 && callIdx !== -1);
    suite.check('the const comes before the call that reads it (not after, next to its functions)',
      declIdx !== -1 && callIdx !== -1 && declIdx < callIdx,
      `REACTION_EMOJI at ${declIdx}, injectReactionBar() call at ${callIdx}`);
  }

  suite.section('reactions: never touch Firebase, by construction');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    trackedDom(ctx);
    evalIn(ctx, `injectReactionBar(); sendReaction('🔥'); sendReaction('👏');`);
    suite.check('zero writes recorded anywhere', evalIn(ctx, 'typeof db.ref') === 'function'); // sanity: db exists
    suite.check('  and specifically: no Firebase write was made', JSON.stringify(ctx.__writes) === '[]');
  }

  suite.section('reactions: bar is injected once, outside the normal render cycle');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    trackedDom(ctx);
    evalIn(ctx, 'injectReactionBar();');
    suite.check('one element appended to <body>', evalIn(ctx, 'window.__appended.length') === 1);
    const barHtml = evalIn(ctx, 'window.__appended[0]._html');
    suite.check('it has one button per REACTION_EMOJI entry', evalIn(ctx, 'REACTION_EMOJI.length') >= 4
      && (barHtml.match(/pv-reaction-btn/g) || []).length === evalIn(ctx, 'REACTION_EMOJI.length'));
    suite.check('each button calls sendReaction with its own emoji', /onclick="sendReaction\('🔥'\)"/.test(barHtml));

    evalIn(ctx, 'injectReactionBar(); injectReactionBar();'); // called again, e.g. if some future code re-invokes it
    suite.check('calling it again does not duplicate the bar', evalIn(ctx, 'window.__appended.length') === 1);
  }

  suite.section('reactions: sendReaction() spawns a self-removing particle');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    trackedDom(ctx);
    evalIn(ctx, `sendReaction('🎉');`);
    suite.check('creates the floating layer on first use', evalIn(ctx, 'window.__made.some(el => el.id === "pvReactionLayer")') === true);
    const particle = evalIn(ctx, 'window.__made.find(el => el.textContent === "🎉")');
    suite.check('the particle carries the emoji as its text', !!particle);
    suite.check('  and is marked decorative for screen readers', particle && particle.attrs['aria-hidden'] === 'true');
    suite.check('schedules its own removal', evalIn(ctx, 'window.__timers.length') === 1 && evalIn(ctx, 'window.__timers[0].ms') === 2600);
    evalIn(ctx, 'window.__timers[0].fn();');
    suite.check('firing that timer removes it', evalIn(ctx, 'window.__made.find(el => el.textContent === "🎉").removed') === true);
  }

  suite.section('reactions: a burst of taps spreads out rather than stacking in one spot');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    trackedDom(ctx);
    evalIn(ctx, `sendReaction('🔥'); sendReaction('🔥'); sendReaction('🔥');`);
    const lefts = evalIn(ctx, 'window.__made.filter(el => el.textContent === "🔥").map(el => el.style.left)');
    suite.check('three taps, three particles', lefts.length === 3);
    suite.check('not all placed at the exact same spot', new Set(lefts).size > 1, JSON.stringify(lefts));
  }

  suite.section('reactions: cleared on a new bid / new lot — clearReactions()');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    trackedDom(ctx);
    evalIn(ctx, `sendReaction('🔥'); sendReaction('👏');`);
    suite.check('sendReaction creates the floating layer', evalIn(ctx, `!!document.getElementById('pvReactionLayer')`));
    // appendChild is a no-op in this harness (see dom-stub.js's own doc
    // comment) — it doesn't model a real child/parent tree, so the layer's
    // .innerHTML never reflects appended particles the way a real DOM would.
    // Set it directly here to simulate "something is visibly on screen" the
    // way production's appendChild calls would, so the next check is
    // actually exercising clearReactions()'s real `layer.innerHTML = ''`
    // statement — not just observing that it started out empty anyway.
    evalIn(ctx, `document.getElementById('pvReactionLayer').innerHTML = '<span>placeholder</span>';`);
    suite.check('(simulated) something is on screen before clearing',
      evalIn(ctx, `document.getElementById('pvReactionLayer').innerHTML`).length > 0);
    evalIn(ctx, 'clearReactions();');
    suite.check('clearReactions empties the layer', evalIn(ctx, `document.getElementById('pvReactionLayer').innerHTML`) === '');
    suite.check('calling it when the layer does not exist yet is harmless',
      (() => { const c2 = ctxFor(['js/shared.js', 'js/public.js']); evalIn(c2, 'clearReactions();'); return true; })());
  }

  suite.section('reactions: handleAuctionTransition() clears the layer on every lot-scoped change');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    trackedDom(ctx);
    evalIn(ctx, `sendReaction('🔥'); window.__cleared = 0; clearReactions = function(){ window.__cleared++; };`);

    evalIn(ctx, `handleAuctionTransition({}, {currentPlayerId:'p1', currentPrice:0, leaderTeamId:null})`);
    suite.check('new player on the block clears reactions', evalIn(ctx, 'window.__cleared') === 1);

    evalIn(ctx, `handleAuctionTransition({currentPlayerId:'p1', currentPrice:0, leaderTeamId:null}, {currentPlayerId:'p1', currentPrice:16, leaderTeamId:'t1'})`);
    suite.check('a real bid clears reactions too', evalIn(ctx, 'window.__cleared') === 2);

    evalIn(ctx, `handleAuctionTransition({currentPlayerId:'p1'}, {currentPlayerId:null})`);
    suite.check('the lot ending clears them as well', evalIn(ctx, 'window.__cleared') === 3);
  }

  /* ============================================================
     PAGE LAYOUT — Teams above Live Results on the live page
     ============================================================ */
  suite.section('renderPublic(): Teams renders above Live Results (moved by request)');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `
      window.__settingsCache = {currencyUnit:'Cr'};
      pv.teams = {t1:{name:'Lions', budget:100, squad:{}}, t2:{name:'Tigers', budget:100, squad:{}}};
      pv.players = {p1:{name:'Kohli', category:'Batsman', basePrice:15, status:'pending'}};
      pv.sales = [];
      pv.auction = {currentPlayerId:'p1', currentPrice:20, leaderTeamId:'t1', biddingOpen:true, paused:false, awaitingNext:false};
    `);
    const html = evalIn(ctx, 'renderPublic(); document.getElementById("tabContent").innerHTML');
    const teamsIdx = html.indexOf('pv-head-title">Teams');
    const resultsIdx = html.indexOf('pv-head-title">Live Results');
    suite.check('both sections are present', teamsIdx !== -1 && resultsIdx !== -1);
    suite.check('Teams comes before Live Results in the live page',
      teamsIdx !== -1 && resultsIdx !== -1 && teamsIdx < resultsIdx,
      `Teams at ${teamsIdx}, Live Results at ${resultsIdx}`);
  }

  return suite.summarize();
}

module.exports = { name: 'audience-features', run };

if (require.main === module){
  run().then(summary => process.exit(printSummary(summary)));
}
