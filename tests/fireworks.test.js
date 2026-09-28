/* ============================================================
   tests/fireworks.test.js — the temporary fireworks-on-sold feature in
   js/public.js must fire ONLY for a genuinely new, real live-auction sale:
   never on first page load, never for a repeat render of the same sale,
   never for 'unsold', and never for the moderator's pre-auction "Assign"
   action (tagged `via:'assigned'` in shared.js's saleRecord()). It DOES fire
   again when the same player is released and re-sold: sales are keyed by
   player id so the row is overwritten, and only its id + time distinguish the
   new sale from the old one.

   `maybeCelebrateNewSale()` is the standalone function public.js's
   `recentSales` listener calls — tested directly here rather than via a
   simulated Firebase snapshot event, which the shared dom stub can't fire.

   Run this after touching: public.js's maybeCelebrateNewSale() or its
   `recentSales` listener, or shared.js's saleRecord()/`via` tagging.
   ============================================================ */
const { ctxFor, evalIn } = require('./lib/dom-stub');
const { makeSuite, printSummary } = require('./lib/suite');

function run(){
  const suite = makeSuite('fireworks');
  const ctx = ctxFor(['js/shared.js', 'js/public.js']);

  // Spy on celebrateSaleFirework() instead of letting the real one run — it
  // touches canvas/requestAnimationFrame, which this stub doesn't provide.
  evalIn(ctx, `
    window.__celebrations = [];
    celebrateSaleFirework = function(){ window.__celebrations.push(true); };
  `);
  const calls = () => evalIn(ctx, 'window.__celebrations.length');

  // A sale's `time` is part of what identifies it (see saleKey() in public.js),
  // so each id gets one FIXED time. Re-rendering a sale hands back the stored
  // row byte-for-byte; building it with a fresh Date.now() each call made
  // "the same sale" differ by a millisecond about 1 run in 9 — a flaky test.
  // `at` overrides it to model a genuine re-sale, which is stamped anew.
  const timeOf = (id) => 1000 * parseInt(id.slice(1), 10);
  const auctionSale = (id, name, at) => `{id:'${id}', name:'${name}', result:'sold', via:'auction', team:'Lions', price:20, time:${at || timeOf(id)}}`;
  const legacySale  = (id, name, at) => `{id:'${id}', name:'${name}', result:'sold', team:'Lions', price:20, time:${at || timeOf(id)}}`; // no `via` at all — pre-existing data written before this field existed
  const assignedSale = (id, name, at) => `{id:'${id}', name:'${name}', result:'sold', via:'assigned', team:'Lions', price:20, time:${at || timeOf(id)}}`;
  const unsoldEntry = (id, name, at) => `{id:'${id}', name:'${name}', result:'unsold', team:null, price:null, time:${at || timeOf(id)}}`;

  suite.section('never fires on the very first snapshot (page load)');
  evalIn(ctx, `maybeCelebrateNewSale([${auctionSale('s1', 'Kohli')}]);`);
  suite.check('no celebration on first load, even though the newest row is sold', calls() === 0);

  suite.section('a genuinely new AUCTION sale after that celebrates');
  evalIn(ctx, `maybeCelebrateNewSale([${auctionSale('s2', 'Bumrah')}, ${auctionSale('s1', 'Kohli')}]);`);
  suite.check('celebrates exactly once', calls() === 1);

  suite.section('re-rendering the SAME newest sale again does not re-fire');
  evalIn(ctx, `maybeCelebrateNewSale([${auctionSale('s2', 'Bumrah')}, ${auctionSale('s1', 'Kohli')}]);`);
  suite.check('still exactly one celebration total', calls() === 1);

  suite.section('a legacy row with no `via` field at all still celebrates (treated as auction)');
  evalIn(ctx, `maybeCelebrateNewSale([${legacySale('s3', 'Jadeja')}, ${auctionSale('s2', 'Bumrah')}, ${auctionSale('s1', 'Kohli')}]);`);
  suite.check('celebrates (now 2 total)', calls() === 2);

  suite.section('a new UNSOLD result never celebrates');
  evalIn(ctx, `maybeCelebrateNewSale([${unsoldEntry('s4', 'Pant')}, ${legacySale('s3', 'Jadeja')}]);`);
  suite.check('no new celebration (still 2 total)', calls() === 2);

  suite.section('a new ASSIGNED (pre-auction retain) sale never celebrates');
  evalIn(ctx, `maybeCelebrateNewSale([${assignedSale('s5', 'Gill')}, ${unsoldEntry('s4', 'Pant')}]);`);
  suite.check('no celebration for an assigned player (still 2 total)', calls() === 2);

  suite.section('a genuinely new auction sale right after an assigned one still celebrates');
  evalIn(ctx, `maybeCelebrateNewSale([${auctionSale('s6', 'Siraj')}, ${assignedSale('s5', 'Gill')}]);`);
  suite.check('celebrates (now 3 total)', calls() === 3);

  suite.section('re-selling the SAME player (released, then sold again) celebrates');
  // Sales are keyed by player id, so the second sale OVERWRITES the first row:
  // same id, but saleRecord() stamps a fresh time. This used to be silent.
  const before = calls();
  evalIn(ctx, `maybeCelebrateNewSale([${auctionSale('s6', 'Siraj', 99000)}, ${assignedSale('s5', 'Gill')}])`);
  suite.check('the re-sold player celebrates again', calls() === before + 1, 'before ' + before + ', after ' + calls());
  evalIn(ctx, `maybeCelebrateNewSale([${auctionSale('s6', 'Siraj', 99000)}, ${assignedSale('s5', 'Gill')}])`);
  suite.check('  and re-rendering that re-sale does not fire it a third time', calls() === before + 1);
  evalIn(ctx, `maybeCelebrateNewSale([${auctionSale('s6', 'Siraj', 120000)}, ${assignedSale('s5', 'Gill')}])`);
  suite.check('  a second re-sale of the same player fires again too', calls() === before + 2);

  suite.section('a re-sale that turns out to be an UNSOLD or an ASSIGN stays silent');
  evalIn(ctx, `maybeCelebrateNewSale([${unsoldEntry('s6', 'Siraj', 130000)}, ${assignedSale('s5', 'Gill')}])`);
  suite.check('same player, now unsold: no celebration', calls() === before + 2);
  evalIn(ctx, `maybeCelebrateNewSale([${assignedSale('s6', 'Siraj', 140000)}, ${assignedSale('s5', 'Gill')}])`);
  suite.check('same player, now retained via Assign: no celebration', calls() === before + 2);

  suite.section('an empty results log (fresh database) never throws or celebrates');
  const freshCtx = ctxFor(['js/shared.js', 'js/public.js']);
  evalIn(freshCtx, `window.__celebrations = []; celebrateSaleFirework = function(){ window.__celebrations.push(true); };`);
  evalIn(freshCtx, 'maybeCelebrateNewSale([]);'); // first snapshot, empty
  evalIn(freshCtx, `maybeCelebrateNewSale([${auctionSale('s1', 'Kohli')}]);`); // first real sale after that
  suite.check('first sale into an empty log still celebrates', evalIn(freshCtx, 'window.__celebrations.length') === 1);

  return suite.summarize();
}

module.exports = { name: 'fireworks', run };

if (require.main === module){
  process.exit(printSummary(run()));
}
