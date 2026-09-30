/* ============================================================
   tests/bidsteps.test.js — the team owner's +1 / +2 raise buttons: pricing
   (bidPriceFor in shared.js), per-button affordability gating, and what
   actually gets written to Firebase when each is pressed.

   Run this after touching: js/shared.js's bidPriceFor()/teamCanAffordBid(),
   or js/team.js's renderDashboard() bid buttons / placeMyBid().
   ============================================================ */
const { ctxFor, evalIn } = require('./lib/dom-stub');
const { makeSuite, printSummary } = require('./lib/suite');

// count bid buttons carrying the disabled attribute (it sits after onclick,
// so match the whole opening tag rather than just after the class)
const disabledCount = html => (html.match(/<button[^>]*pv-bid-btn[^>]*>/g) || [])
  .filter(tag => / disabled/.test(tag)).length;
const bidBtnTags = html => html.match(/<button[^>]*pv-bid-btn[^>]*>/g) || [];

const S = "{bidIncrement:2,defaultBasePrice:5,maxPlayersPerTeam:18,minPlayersPerTeam:0,currencyUnit:'Cr'}";
const P = "{name:'Kohli',category:'Batsman',basePrice:15,status:'pending'}";

function run(){
  const suite = makeSuite('bidsteps');
  const ctx = ctxFor(['js/shared.js', 'js/team.js']);

  suite.section('1. pricing (increment = 2)');
  const price = (cur, steps) => evalIn(ctx, `bidPriceFor({currentPrice:${cur}}, ${P}, ${S}, ${steps})`);
  suite.check('first bid, +1 = base price', price(0, 1) === 15, 'got ' + price(0, 1));
  suite.check('first bid, +2 = base + one step', price(0, 2) === 17, 'got ' + price(0, 2));
  suite.check('live bid 20, +1 = 22', price(20, 1) === 22, 'got ' + price(20, 1));
  suite.check('live bid 20, +2 = 24', price(20, 2) === 24, 'got ' + price(20, 2));
  suite.check('missing steps defaults to +1', price(20, undefined) === 22);
  suite.check('zero/negative steps clamp to +1', price(20, 0) === 22 && price(20, -3) === 22);

  suite.section('2. both raises offered when affordable');
  evalIn(ctx, `window.__settingsCache=${S};
    tSession={role:'team',teamId:'t1',label:'Lions'};
    tstate={settings:${S},teams:{t1:{name:'Lions',budget:100,squad:{}},t2:{name:'Tigers',budget:100,squad:{}}},
      players:{p1:${P}},
      auction:{currentPlayerId:'p1',currentPrice:20,leaderTeamId:'t2',biddingOpen:true,paused:false}};`);
  let out = evalIn(ctx, 'renderDashboard()');
  suite.check('two bid buttons rendered', (out.match(/pv-bid-btn"/g) || []).length === 2, 'found ' + (out.match(/pv-bid-btn"/g) || []).length);
  suite.check('calls placeMyBid(1)', out.includes('placeMyBid(1)'));
  suite.check('calls placeMyBid(2)', out.includes('placeMyBid(2)'));
  suite.check('shows +2 Cr raise', out.includes('+2 Cr'));
  suite.check('shows +4 Cr raise', out.includes('+4 Cr'));
  suite.check('shows resulting 22 Cr', out.includes('Bid 22 Cr'));
  suite.check('shows resulting 24 Cr', out.includes('Bid 24 Cr'));
  suite.check('neither is disabled', disabledCount(out) === 0);

  suite.section('3. purse gates each raise on its own');
  // 23 left: can afford +1 (22) but not +2 (24)
  evalIn(ctx, `tstate.teams.t1.budget=43; tstate.teams.t1.squad={x:{price:20}};`);
  out = evalIn(ctx, 'renderDashboard()');
  const tags = bidBtnTags(out);
  suite.check('+1 stays enabled', !/ disabled/.test(tags[0] || ''), 'purse 23, bid 22');
  suite.check('+2 is disabled', / disabled/.test(tags[1] || ''), 'purse 23, bid 24');
  suite.check('explains the bigger raise', out.includes('bigger raise is out of reach'));

  suite.section('4. paused closes both');
  evalIn(ctx, `tstate.teams.t1.budget=100; tstate.teams.t1.squad={};
    tstate.auction.paused=true; tstate.auction.biddingOpen=false;`);
  out = evalIn(ctx, 'renderDashboard()');
  suite.check('both disabled when paused', disabledCount(out) === 2, 'disabled=' + disabledCount(out));
  suite.check('says bidding is closed', out.includes('Bidding is closed right now'));

  suite.section('5. leading team cannot raise itself');
  evalIn(ctx, `tstate.auction.paused=false; tstate.auction.biddingOpen=true;
    tstate.auction.leaderTeamId='t1';`);
  out = evalIn(ctx, 'renderDashboard()');
  suite.check('both disabled while leading', disabledCount(out) === 2, 'disabled=' + disabledCount(out));
  suite.check('says you are highest', out.includes('highest bidder'));

  suite.section('6. pressing each button writes the right price');
  evalIn(ctx, `tstate.auction.leaderTeamId='t2';`);
  ctx.__writes.length = 0;
  evalIn(ctx, 'placeMyBid(1)');
  let w = ctx.__writes[0];
  suite.check('+1 writes 22', w && w.value && w.value.currentPrice === 22, JSON.stringify(w));
  suite.check('  and claims the lead', w && w.value && w.value.leaderTeamId === 't1');
  suite.check('  and cancels any "going once/twice" call', w && w.value && w.value.callState === null);
  ctx.__writes.length = 0;
  evalIn(ctx, 'placeMyBid(2)');
  w = ctx.__writes[0];
  suite.check('+2 writes 24', w && w.value && w.value.currentPrice === 24, JSON.stringify(w));

  suite.section('7. an unaffordable raise is refused even if the button is bypassed');
  evalIn(ctx, `tstate.teams.t1.budget=43; tstate.teams.t1.squad={x:{price:20}};`);
  ctx.__writes.length = 0;
  ctx.__toasts.length = 0;
  evalIn(ctx, 'placeMyBid(2)');
  suite.check('nothing written', ctx.__writes.length === 0);
  suite.check('tells the owner why', ctx.__toasts.some(t => /cannot afford/i.test(t[1])), JSON.stringify(ctx.__toasts));

  return suite.summarize();
}

module.exports = { name: 'bidsteps', run };

if (require.main === module){
  process.exit(printSummary(run()));
}
