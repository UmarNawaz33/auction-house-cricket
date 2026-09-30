/* ============================================================
   tests/showtime-features.test.js — the "showtime" features added
   2026-10-01, follow-up requests to the four public.js-only audience
   features in audience-features.test.js — these are different: they span
   multiple pages and one adds a new `auction` field.

     1. "Going once… going twice…" banner — auction.callState ('once'|
        'twice'|null), moderator.js's callOnce()/callTwice()/cancelCall()
        (Firebase-write coverage lives in flow.test.js, next to every OTHER
        auction-node write that clears callState back to null — not here),
        callBannerMarkup() (shared.js), rendered on public.js AND team.js.
     2. Leader-color stage wash — #pvStageWash (public.js), tinted to
        hueFor(leader.name). classList-based, so its actual CSS class
        output can't be asserted through this harness (see its own section
        below) — the coverage here is "doesn't throw", the real class
        output was verified in a real browser (CLAUDE.md §6a). Went through
        several follow-up size revisions over the next two days, all
        CSS-only (no new JS to test): broadened to two radial gradients,
        reverted to the original ONE gradient (that version "was good")
        just sized up, then dialed back down 30% by area — always ONE
        gradient since the revert; see the CSS comment for the exact
        numbers and the instruction not to reintroduce the two-gradient
        version.
     3. Theatrical player reveal — CSS-only upgrade of the existing
        .pv-lot.is-revealing class; the JS that adds/removes the class is
        unchanged, so this file only re-confirms the class still appears.
     4. Record sale bigger than normal — celebrateSaleFirework(isRecord)
        and screenShakeForRecord() (public.js). Coverage here is "receives
        the right isRecord flag and doesn't throw either way" — the
        resulting canvas/particle output isn't inspectable through this
        harness (a canvas 2D context isn't real here either); a bigger
        burst count for a record sale was eyeballed in a real browser.

   A "ticking price counter" (tickPriceTo()/syncPriceTicker(), lotMarkup's
   `priceId`) was built the same day and then REMOVED by request — none of
   that code exists any more; don't reintroduce it from an old diff without
   being asked. shared.js's `teamTilesMarkup()` (the Teams tile grid) and
   the leader-capsule hue-matching in public.js's sheet (section 6 below)
   were added 2026-10-02. team.js's "how do I show the signed-in team's own
   name" answer changed TWICE that same week: first the full all-teams grid
   (`teamTilesMarkup()`), then a single `.pv-team`/`.pv-dot`-styled tile for
   just that one team, then — by a further follow-up request, "in the same
   manner" as the existing Purse Remaining/Squad Size chips — a third and
   current form: a plain `.chip` (matching those two exactly), FIRST in
   that same `.chip-row`, no colour-coding. `teamTilesMarkup()` itself is
   unchanged throughout and still used by public.js's `renderTeamsPanel()`
   — team.js never calls it.

   Run this after touching any of: shared.js's callBannerMarkup/
   teamTilesMarkup/lotMarkup's leader hue class, moderator.js's callOnce/
   callTwice/cancelCall, team.js's call banner or its own-team chip, or
   public.js's stage wash / reveal CSS / leader-hue CSS /
   celebrateSaleFirework/screenShakeForRecord.
   ============================================================ */
const { ctxFor, evalIn } = require('./lib/dom-stub');
const { makeSuite, printSummary } = require('./lib/suite');

function run(){
  const suite = makeSuite('showtime-features');

  suite.section('1. callBannerMarkup() (shared.js) — pure string builder');
  {
    const ctx = ctxFor(['js/shared.js']);
    suite.check('no auction object at all -> empty string', evalIn(ctx, 'callBannerMarkup(null)') === '');
    suite.check('no call in progress -> empty string', evalIn(ctx, "callBannerMarkup({callState:null})") === '');
    suite.check('callState missing entirely -> empty string', evalIn(ctx, "callBannerMarkup({})") === '');
    const once = evalIn(ctx, "callBannerMarkup({callState:'once'})");
    suite.check('"once" renders the banner', once.includes('pv-call-banner'));
    suite.check('  says Going Once', /Going Once/.test(once));
    suite.check('  is not tagged .twice', !/pv-call-banner twice/.test(once));
    const twice = evalIn(ctx, "callBannerMarkup({callState:'twice'})");
    suite.check('"twice" renders the banner', twice.includes('pv-call-banner'));
    suite.check('  says Going Twice', /Going Twice/.test(twice));
    suite.check('  IS tagged .twice (distinct styling)', /pv-call-banner twice/.test(twice));
    suite.check('an unrecognised value renders nothing', evalIn(ctx, "callBannerMarkup({callState:'sold'})") === '');
  }

  suite.section('2. the call banner on public.js\'s live lot');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `
      window.__settingsCache = {currencyUnit:'Cr'};
      pv.teams = {t1:{name:'Lions', budget:100, squad:{}}};
      pv.players = {p1:{name:'Kohli', category:'Batsman', basePrice:15, status:'pending'}};
      pv.sales = [];
    `);
    evalIn(ctx, `pv.auction = {currentPlayerId:'p1', currentPrice:20, leaderTeamId:'t1', biddingOpen:true, paused:false, awaitingNext:false, callState:'once'};`);
    let html = evalIn(ctx, '(function(){ renderPublic(); return document.getElementById("tabContent").innerHTML; })()');
    suite.check('shows while a call is active', html.includes('pv-call-banner') && /Going Once/.test(html));

    evalIn(ctx, `pv.auction = {currentPlayerId:'p1', currentPrice:20, leaderTeamId:'t1', biddingOpen:true, paused:false, awaitingNext:false, callState:null};`);
    html = evalIn(ctx, '(function(){ renderPublic(); return document.getElementById("tabContent").innerHTML; })()');
    suite.check('gone once the call is cleared', !html.includes('pv-call-banner'));

    suite.check('never shown on the completed/home screen', (function(){
      evalIn(ctx, `pv.auction = {completed:true, callState:'once'};`);
      const h = evalIn(ctx, '(function(){ renderPublic(); return document.getElementById("tabContent").innerHTML; })()');
      return !h.includes('pv-call-banner');
    })());
  }

  suite.section('3. the call banner on team.js\'s dashboard');
  {
    const ctx = ctxFor(['js/shared.js', 'js/team.js']);
    evalIn(ctx, `
      tSession = {role:'team', teamId:'t2', label:'Tigers Owner'};
      tstate.settings = {bidIncrement:1, defaultBasePrice:5, maxPlayersPerTeam:18, minPlayersPerTeam:0, currencyUnit:'Cr'};
      tstate.teams = {t1:{name:'Lions', budget:100, squad:{}}, t2:{name:'Tigers', budget:80, squad:{}}};
      tstate.players = {p1:{name:'Kohli', category:'Batsman', basePrice:15, status:'pending'}};
    `);
    evalIn(ctx, `tstate.auction = {currentPlayerId:'p1', currentPrice:20, leaderTeamId:'t1', biddingOpen:true, paused:false, awaitingNext:false, callState:'twice'};`);
    let html = evalIn(ctx, 'renderDashboard()');
    suite.check('shows while a call is active', html.includes('pv-call-banner') && /Going Twice/.test(html));

    evalIn(ctx, `tstate.auction.callState = null;`);
    html = evalIn(ctx, 'renderDashboard()');
    suite.check('gone once the call is cleared', !html.includes('pv-call-banner'));

    suite.check('does not block the bid buttons underneath', html.includes('placeMyBid'));
  }

  suite.section('4. leader-color stage wash — doesn\'t throw across every auction state');
  {
    // classList is a no-op in this harness (tests/lib/dom-stub.js's own doc
    // comment), so the actual CSS class it ends up with can't be asserted
    // here — confirmed for real in a real browser instead (CLAUDE.md §6a).
    // What IS provable here: the function runs, for every shape of auction
    // state, without throwing — including the states that deliberately
    // don't have "..leaderTeamId" or ".currentPlayerId" set.
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    suite.check('injectStageWash() itself never throws', (function(){
      try{ evalIn(ctx, 'injectStageWash(); injectStageWash();'); return true; }catch(e){ return false; }
    })());
    const states = [
      `{currentPlayerId:'p1', leaderTeamId:'t1'}`,
      `{currentPlayerId:'p1', leaderTeamId:null}`,
      `{currentPlayerId:null}`,
      `{completed:true, leaderTeamId:'t1'}`,
      `{}`,
      `null`,
    ];
    let allOk = true;
    states.forEach(s=>{
      try{ evalIn(ctx, `updateStageWash(${s}, ${s === 'null' ? 'null' : "{id:'t1',name:'Lions'}"});`); }
      catch(e){ allOk = false; }
    });
    suite.check('updateStageWash() never throws across every auction shape', allOk);
  }

  suite.section('5. record sale bigger than normal — isRecord threads through, neither path throws');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `window.__seenIsRecord = [];
      celebrateSaleFirework = function(isRecord){ window.__seenIsRecord.push(isRecord); };`);
    evalIn(ctx, `
      pv.settings = {currencyUnit:'Cr'};
      pv.sales = [
        {id:'s1', name:'Bumrah', result:'sold', via:'auction', team:'Lions', price:20, time:1}
      ];
      maybeCelebrateNewSale(pv.sales); // seeds the record from history (20), announces nothing
    `);
    suite.check('seeding a first snapshot never crashes and fires no celebration', evalIn(ctx, 'window.__seenIsRecord.length === 0'));

    evalIn(ctx, `
      pv.sales = [
        {id:'s2', name:'Kohli', result:'sold', via:'auction', team:'Tigers', price:15, time:2},
        pv.sales[0]
      ];
      maybeCelebrateNewSale(pv.sales); // 15 < the 20 record — NOT a record sale
    `);
    suite.check('an ordinary sale passes isRecord=false', evalIn(ctx, 'window.__seenIsRecord[window.__seenIsRecord.length-1] === false'));

    evalIn(ctx, `
      pv.sales = [
        {id:'s3', name:'Dhoni', result:'sold', via:'auction', team:'Lions', price:99, time:3},
        pv.sales[0], pv.sales[1]
      ];
      maybeCelebrateNewSale(pv.sales); // 99 beats the 20 record — IS a record sale
    `);
    suite.check('a record sale passes isRecord=true', evalIn(ctx, 'window.__seenIsRecord[window.__seenIsRecord.length-1] === true'));

    suite.check('screenShakeForRecord() never throws (test stub <body> has no classList)', (function(){
      try{ evalIn(ctx, 'screenShakeForRecord();'); return true; }catch(e){ return false; }
    })());
  }

  suite.section('6. theatrical player reveal — the class is still added, CSS-only upgrade');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `
      window.__settingsCache = {currencyUnit:'Cr'};
      pv.teams = {t1:{name:'Lions', budget:100, squad:{}}};
      pv.players = {p1:{name:'Kohli', category:'Batsman', basePrice:15, status:'pending'}};
      pv.sales = [];
      pv.auction = {currentPlayerId:'p1', currentPrice:0, leaderTeamId:null, biddingOpen:true, paused:false, awaitingNext:false};
      handleAuctionTransition({}, pv.auction);
    `);
    const firstHtml = evalIn(ctx, '(function(){ renderPublic(); return document.getElementById("tabContent").innerHTML; })()');
    suite.check('a freshly-revealed lot carries is-revealing', firstHtml.includes('is-revealing'));
    evalIn(ctx, '__justRevealed = false;'); // the real `auction` listener resets this right after its own render — see public.js

    evalIn(ctx, `
      pv.auction = Object.assign({}, pv.auction, {currentPrice:16, leaderTeamId:'t1'});
      handleAuctionTransition({currentPlayerId:'p1'}, pv.auction); // same player — just a bid
    `);
    const secondHtml = evalIn(ctx, '(function(){ renderPublic(); return document.getElementById("tabContent").innerHTML; })()');
    suite.check('a bid on the SAME lot does not replay it', !secondHtml.includes('is-revealing'));
  }

  suite.section('7. leader capsule tinted to the leading team\'s own color (public.js) + Teams tiles (shared.js) + team.html\'s own-team chip');
  {
    const ctx = ctxFor(['js/shared.js']);
    // hueFor('Lions') and hueFor('Tigers') — whatever bucket they land in,
    // the SAME team must get the SAME hue everywhere it's rendered.
    const lionsHue = evalIn(ctx, "hueFor('Lions')");
    const lotHtml = evalIn(ctx, `lotMarkup({name:'Kohli', category:'Batsman', basePrice:15}, {price:20, leader:{name:'Lions'}})`);
    suite.check('lotMarkup tags the leading capsule with the leader\'s own hue', lotHtml.includes(`pv-leader is-leading ${lionsHue}`), lotHtml);

    const tilesHtml = evalIn(ctx, `teamTilesMarkup([{id:'t1', name:'Lions', budget:100, squad:{}}])`);
    suite.check('teamTilesMarkup tags the same team with the SAME hue as the leader capsule', tilesHtml.includes(`pv-dot ${lionsHue}`) && tilesHtml.includes(`pv-team h-100 ${lionsHue}`), tilesHtml);
    suite.check('shows the purse remaining and total budget', tilesHtml.includes('Cr') && /left of/.test(tilesHtml));

    // teamTilesMarkup is now shared — public.js's renderTeamsPanel() and
    // team.js's own Teams card both call it. Prove both actually do.
    const pctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(pctx, `pv.teams = {t1:{name:'Lions', budget:100, squad:{}}};`);
    const publicTeams = evalIn(pctx, `renderTeamsPanel([{id:'t1', name:'Lions', budget:100, squad:{}}], 'Teams')`);
    suite.check('public.js\'s Teams panel renders a tile for the team', publicTeams.includes('pv-team') && publicTeams.includes('Lions'));

    // team.js no longer shows the all-teams grid (removed by request,
    // 2026-10-02), nor a .pv-team-style tile for the signed-in team either
    // (that lasted about a day — a follow-up request asked for a plain
    // .chip instead, "in the same manner" as the existing Purse
    // Remaining/Squad Size chips, as the FIRST chip in that same row).
    const tctx = ctxFor(['js/shared.js', 'js/team.js']);
    evalIn(tctx, `
      tSession = {role:'team', teamId:'t1', label:'Lions Owner'};
      tstate.settings = {bidIncrement:1, defaultBasePrice:5, maxPlayersPerTeam:18, minPlayersPerTeam:0, currencyUnit:'Cr'};
      tstate.teams = {t1:{name:'Lions', budget:100, squad:{}}, t2:{name:'Tigers', budget:80, squad:{}}};
      tstate.players = {};
      tstate.auction = {};
    `);
    const teamDashboard = evalIn(tctx, 'renderDashboard()');
    suite.check('shows MY OWN team\'s name as a plain chip, not a coloured tile',
      teamDashboard.includes('<div class="chip"><div class="val">Lions</div><div class="lbl">My Team</div></div>'));
    suite.check('that chip is FIRST, before Purse Remaining/Squad Size',
      teamDashboard.indexOf('My Team') < teamDashboard.indexOf('Purse Remaining'));
    suite.check('does NOT render the other teams (the all-teams grid was removed)',
      !teamDashboard.includes('Tigers') && !teamDashboard.includes('pv-bar-fill') && !teamDashboard.includes('pv-team'));
  }

  return suite.summarize();
}

module.exports = { name: 'showtime-features', run };

if (require.main === module){
  process.exit(printSummary(run()));
}
