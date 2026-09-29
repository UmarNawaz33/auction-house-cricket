/* ============================================================
   tests/retained-label.test.js — a player placed with the moderator's
   pre-auction Assign button shows "Retained"/"retained" everywhere the app
   would otherwise say "Sold"/"sold", so it isn't confused for a real
   live-auction sale. A real auction sale must keep saying "Sold".

   The single source of truth is shared.js's soldLabel(sale), which reads
   `via` off the matching recentSales row ('assigned' → retained, anything
   else including a legacy row with no `via` at all → sold — see saleRecord()
   in shared.js). Every renderer below looks up its own sale record
   differently (mstate.recentSales is a map, adminState.sales is an array,
   pv.sales is public.js's own array with its own capitalised markup) — this
   file checks each of those lookups is wired correctly, not soldLabel()
   itself in isolation more than once.

   Run this after touching: shared.js's soldLabel()/renderSalesTable(),
   moderator.js's Players/Summary tabs or its edit/delete-player modals,
   admin.js's Players tab, or public.js's own results table markup.
   ============================================================ */
const { ctxFor, evalIn } = require('./lib/dom-stub');
const { FIXTURES } = require('./lib/fixtures');
const { makeSuite, printSummary } = require('./lib/suite');

function run(){
  const suite = makeSuite('retained-label');

  suite.section('soldLabel(): the one place this decision is made');
  {
    const ctx = ctxFor(['js/shared.js']);
    const label = (js) => evalIn(ctx, `soldLabel(${js})`);
    suite.check('an assigned sale reads "retained"', label(`{via:'assigned'}`) === 'retained');
    suite.check('an auction sale reads "sold"', label(`{via:'auction'}`) === 'sold');
    suite.check('a legacy row with no `via` at all reads "sold" (saleRecord()\'s own default)', label(`{result:'sold'}`) === 'sold');
    suite.check('no matching sale (undefined) reads "sold"', label('undefined') === 'sold');
    suite.check('no matching sale (null) reads "sold"', label('null') === 'sold');
    suite.check('always lowercase — callers re-case it themselves if they need Title Case',
      label(`{via:'assigned'}`) === label(`{via:'assigned'}`).toLowerCase());
  }

  suite.section('renderSalesTable() (shared.js — moderator Live Results + admin Data view)');
  {
    const ctx = ctxFor(['js/shared.js']);
    const sales = [
      {id:'p1', name:'Kohli', category:'Batsman', basePrice:15, result:'sold', via:'auction', team:'Lions', price:20, time:3},
      {id:'p2', name:'Gill',  category:'Batsman', basePrice:10, result:'sold', via:'assigned', team:'Tigers', price:10, time:2},
      {id:'p3', name:'Jadeja', category:'All-Rounder', basePrice:8, result:'unsold', team:null, price:null, time:1}
    ];
    const html = evalIn(ctx, `renderSalesTable(${JSON.stringify(sales)})`);
    suite.check('the auction sale still says sold', /<span class="badge sold">sold<\/span>/.test(html));
    suite.check('the assigned sale says retained, not sold', /<span class="badge sold">retained<\/span>/.test(html));
    suite.check('  and the literal word "sold" never appears for Gill\'s row',
      !new RegExp('Gill[\\s\\S]{0,120}>sold<').test(html));
    suite.check('the unsold row is untouched', /<span class="badge unsold">unsold<\/span>/.test(html));
    suite.check('the badge CLASS stays "sold" (green) for a retained row — only the text changes, not the styling',
      /badge sold">retained/.test(html));
  }

  suite.section('moderator.js: Players tab + Summary tab, after a real assign');
  {
    const ctx = ctxFor(['js/shared.js', 'js/moderator.js']);
    evalIn(ctx, FIXTURES + `
      session = {role:'moderator', label:'Mod'};
      mstate = {settings:SETTINGS, teams:TEAMS(), players:PLAYERS, auction:{}, recentSales:SALES};
      document.getElementById('asTeam').value = 't2';
      document.getElementById('asPrice').value = '9';
    `);
    evalIn(ctx, 'confirmAssignPlayer("p3")'); // p3 (Jadeja) starts 'unsold' in fixtures — free to assign
    // the stub doesn't feed a write back into mstate (no real Firebase round
    // trip) — apply it by hand, the same thing render.test.js/markup.test.js
    // do throughout: seed state directly, then render and inspect the string
    evalIn(ctx, `
      mstate.players.p3.status = 'sold'; mstate.players.p3.soldTo = 't2'; mstate.players.p3.soldPrice = 9;
      mstate.recentSales.p3 = {name:'Ravindra Jadeja', category:'All-Rounder', image:'', basePrice:8,
        result:'sold', via:'assigned', teamId:'t2', team:'Tigers', price:9, time:9999};
    `);

    const players = evalIn(ctx, 'renderPlayers()');
    suite.check('Players tab: the assigned player shows retained', /<span class="badge sold">retained<\/span>/.test(players));
    suite.check('Players tab: the pre-existing REAL sale (Bumrah, fixtures\' SALES.s1, no `via`) still shows sold',
      /Jasprit Bumrah[\s\S]{0,200}>sold</.test(players));

    const summary = evalIn(ctx, 'renderSummary()');
    suite.check('Summary tab\'s Full Results table also shows retained for the same player',
      /<span class="badge sold">retained<\/span>/.test(summary));
  }

  suite.section('moderator.js: edit-player and delete-player modal wording');
  {
    const ctx = ctxFor(['js/shared.js', 'js/moderator.js']);
    evalIn(ctx, FIXTURES + `
      session = {role:'moderator', label:'Mod'};
      mstate = {settings:SETTINGS, teams:TEAMS(), players:PLAYERS, auction:{}, recentSales:SALES};
      mstate.players.p3 = {name:'Ravindra Jadeja', category:'All-Rounder', basePrice:8, status:'sold', soldTo:'t2', soldPrice:9};
      mstate.recentSales.p3 = {name:'Ravindra Jadeja', result:'sold', via:'assigned', teamId:'t2', team:'Tigers', price:9, time:9999};
      mstate.recentSales.p2 = {name:'Jasprit Bumrah', result:'sold', via:'auction', teamId:'t1', team:'Lions', price:12, time:8888};
    `);

    evalIn(ctx, 'editPlayerPrompt("p3")');
    let modal = evalIn(ctx, "document.getElementById('modalRoot').innerHTML");
    suite.check('edit modal: a retained player reads "retained by", not "sold to"',
      /Currently <b>retained<\/b> by <b>Tigers<\/b>/.test(modal), modal);

    evalIn(ctx, 'editPlayerPrompt("p2")');
    modal = evalIn(ctx, "document.getElementById('modalRoot').innerHTML");
    suite.check('edit modal: a real auction sale still reads "sold to"',
      /Currently <b>sold<\/b> to <b>Lions<\/b>/.test(modal), modal);

    evalIn(ctx, 'confirmDeletePlayer("p3")');
    modal = evalIn(ctx, "document.getElementById('modalRoot').innerHTML");
    suite.check('delete modal: title says "retained player"', /Delete retained player\?/.test(modal));
    suite.check('  and body says "is retained by", not "is sold to"', /Jadeja[\s\S]{0,10} is retained by Tigers/.test(modal), modal);

    evalIn(ctx, 'confirmDeletePlayer("p2")');
    modal = evalIn(ctx, "document.getElementById('modalRoot').innerHTML");
    suite.check('delete modal: a real sale still says "sold player" / "is sold to"',
      /Delete sold player\?/.test(modal) && /is sold to Lions/.test(modal), modal);
  }

  suite.section('admin.js: Players tab');
  {
    const ctx = ctxFor(['js/shared.js', 'js/admin.js']);
    evalIn(ctx, `
      adminState = {session:{role:'admin', label:'me@x.com'},
        settings:{currencyUnit:'Cr', minPlayersPerTeam:0, maxPlayersPerTeam:18, defaultBasePrice:1, bidIncrement:1},
        teams:{t1:{name:'Lions', budget:100, squad:{}}, t2:{name:'Tigers', budget:100, squad:{}}},
        players:{
          p1:{name:'Kohli', category:'Batsman', basePrice:15, status:'sold', soldTo:'t1', soldPrice:20},
          p2:{name:'Gill',  category:'Batsman', basePrice:10, status:'sold', soldTo:'t2', soldPrice:10}
        },
        auction:{}, keys:{},
        sales:[
          {id:'p1', result:'sold', via:'auction',   teamId:'t1', team:'Lions',  price:20, time:2},
          {id:'p2', result:'sold', via:'assigned', teamId:'t2', team:'Tigers', price:10, time:1}
        ]};
    `);
    const html = evalIn(ctx, 'renderPlayersTab()');
    suite.check('the auction sale (Kohli) still shows sold', /Kohli[\s\S]{0,200}>sold</.test(html));
    suite.check('the assigned player (Gill) shows retained', /Gill[\s\S]{0,200}>retained</.test(html));
  }

  suite.section('public.js: its own (separately-implemented) results table');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `
      pv.teams = {t1:{name:'Lions'}, t2:{name:'Tigers'}};
      pv.players = {};
      pv.auction = {completed:true};
      pv.sales = [
        {id:'p1', name:'Kohli', category:'Batsman', image:'', basePrice:15, result:'sold', via:'auction',   team:'Lions',  price:20, time:2},
        {id:'p2', name:'Gill',  category:'Batsman', image:'', basePrice:10, result:'sold', via:'assigned', team:'Tigers', price:10, time:1}
      ];
      showPastResults = true;
    `);
    const html = evalIn(ctx, 'renderPublic(); document.getElementById("tabContent").innerHTML');
    suite.check('public results table: a real sale reads "Sold" (Title Case, this file\'s own convention)',
      /Kohli[\s\S]{0,400}>Sold</.test(html), 'no match near Kohli');
    suite.check('public results table: an assigned player reads "Retained"',
      /Gill[\s\S]{0,400}>Retained</.test(html), 'no match near Gill');
    suite.check('  and never the word "Sold" for that same player',
      !/Gill[\s\S]{0,400}>Sold</.test(html));
  }

  return suite.summarize();
}

module.exports = { name: 'retained-label', run };

if (require.main === module){
  process.exit(printSummary(run()));
}
