/* ============================================================
   tests/takeover.test.js — the SOLD TAKEOVER in js/public.js: a full-screen
   card on the public view when a real auction sale lands.

   It rides the same once-per-new-sale gate as the fireworks
   (maybeCelebrateNewSale), so it must fire for a genuinely new auction sale —
   including a player who was released and re-sold, whose row is overwritten
   under the same id — and never on first load, on a repeat render, for
   'unsold', or for a pre-auction "Assign". The gate itself is covered in more
   depth by fireworks.test.js; this file checks the takeover's own content,
   escaping, dismissal, and that it is wired to that gate.

   Run this after touching: public.js's takeover (soldTakeoverMarkup /
   showSoldTakeover / dismissSoldTakeover) or its sale gate.
   ============================================================ */
const { ctxFor, evalIn } = require('./lib/dom-stub');
const { makeSuite, printSummary } = require('./lib/suite');

async function run(){
  const suite = makeSuite('takeover');

  suite.section('soldTakeoverMarkup');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `window.__settingsCache = {currencyUnit:'Cr'};`);
    const html = evalIn(ctx, `soldTakeoverMarkup({name:'Virat Kohli', team:'Chennai Kings', price:16, image:'images/kohli.jpg'})`);
    suite.check('says SOLD', /pv-takeover-stamp">Sold</.test(html));
    suite.check('names the player', /Virat Kohli/.test(html));
    suite.check('names the team', /<strong>Chennai Kings<\/strong>/.test(html));
    suite.check('shows the price in the headline format', /pv-amt">16</.test(html) && /pv-unit">Cr</.test(html));
    suite.check('uses the player\'s photo', /src="images\/kohli\.jpg"/.test(html));
    suite.check('has the circular countdown, starting at 5',
      /pv-takeover-ring/.test(html) && /id="pvTakeoverCount">5</.test(html));
    suite.check('  its ring sweeps for exactly the same 5s the digit counts',
      /pv-takeover-ring-fg"[^>]*animation-duration:5s/.test(html));
    suite.check('  the reduced-motion step count comes from the same 5',
      /--pv-take-steps:5/.test(html));
    suite.check('  it is hidden from screen readers (it would announce every second)',
      /pv-takeover-timer" aria-hidden="true"/.test(html));
    suite.check('falls back to the default photo if it fails to load', /onerror=/.test(html));

    const bare = evalIn(ctx, `soldTakeoverMarkup({name:'Gill', team:'Lions', price:5, image:''})`);
    suite.check('a player with no photo gets the default image, not a broken src', !/src=""/.test(bare));

    const hostile = evalIn(ctx, `soldTakeoverMarkup({name:'<img src=x onerror=alert(1)>', team:'<b>Evil</b>', price:1, image:''})`);
    suite.check('player and team names are HTML-escaped',
      !/<img src=x/.test(hostile) && !/<b>Evil/.test(hostile) && /&lt;img/.test(hostile) && /&lt;b&gt;Evil/.test(hostile));
    // Strip tags first: the photo's own `onerror="this.onerror=null;…"` guard
    // legitimately contains the word null, and it's the visible text that
    // must never leak one.
    const visible = evalIn(ctx, `soldTakeoverMarkup({})`).replace(/<[^>]*>/g, ' ');
    suite.check('missing fields degrade gracefully instead of printing "undefined"',
      !/undefined|NaN|null/.test(visible) && /Player/.test(visible) && /a team/.test(visible), visible.replace(/\s+/g, ' '));
  }

  suite.section('showSoldTakeover / dismiss');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `
      window.__settingsCache = {currencyUnit:'Cr'};
      window.__timers = []; window.__appended = []; window.__made = [];
      // capture timers instead of the harness's run-immediately default, so the
      // dismiss timer can be observed rather than firing before we look
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
    const sale = "{name:'Kohli', team:'Lions', price:16, image:''}";

    evalIn(ctx, `showSoldTakeover(${sale})`);
    suite.check('puts one overlay on the page', evalIn(ctx, 'window.__appended.length') === 1);
    suite.check('  it is a polite status region', evalIn(ctx, `window.__made[0].attrs.role`) === 'status'
      && evalIn(ctx, `window.__made[0].attrs['aria-live']`) === 'polite');
    suite.check('  tapping it dismisses', /dismissSoldTakeover/.test(evalIn(ctx, `window.__made[0].attrs.onclick`)));
    suite.check('  it schedules the first one-second tick', evalIn(ctx, 'window.__timers.length') === 1
      && evalIn(ctx, 'window.__timers[0].ms') === 1000);

    // Drive the real chain: each fired timer schedules the next, exactly as
    // the browser would, and we read the digit the viewer would see.
    const count = () => ctx.document.getElementById('pvTakeoverCount').textContent;
    const seen = [];
    for (let i = 0; i < 5; i++){
      evalIn(ctx, `window.__timers[${i}].fn()`);
      seen.push(count());
    }
    suite.check('the timer counts down 4, 3, 2, 1, 0', seen.join(',') === '4,3,2,1,0', seen.join(','));
    suite.check('  one second per step, five seconds in all',
      evalIn(ctx, 'window.__timers.slice(0,5).every(t => t.ms === 1000)')
      && evalIn(ctx, 'window.__timers.slice(0,5).reduce((n,t) => n + t.ms, 0)') === 5000);
    suite.check('  at 0 the card starts fading out but is still on the page',
      evalIn(ctx, 'window.__made[0].classes.join()') === 'is-leaving' && evalIn(ctx, 'window.__made[0].removed') === false);
    suite.check('  the exit is a short fade, not another full second',
      evalIn(ctx, 'window.__timers.length') === 6 && evalIn(ctx, 'window.__timers[5].ms') === 300);
    evalIn(ctx, 'window.__timers[5].fn()');
    suite.check('then it is removed', evalIn(ctx, 'window.__made[0].removed') === true);

    // closing early must stop the chain, not let a stale tick reach a dead card
    evalIn(ctx, `window.__timers.length = 0; showSoldTakeover(${sale})`);
    evalIn(ctx, 'window.__timers[0].fn()');
    suite.check('an early close: the card is mid-countdown at 4', count() === '4');
    evalIn(ctx, `onTakeoverKey({key:'Escape'})`);
    evalIn(ctx, 'window.__timers[1].fn()');   // the tick that was already pending
    suite.check('a tick that fires after an early close does nothing',
      count() === '4' && evalIn(ctx, 'window.__appended.length') === 2);

    evalIn(ctx, `showSoldTakeover(${sale})`);
    evalIn(ctx, `onTakeoverKey({key:'a'})`);
    suite.check('an ordinary key does not dismiss', evalIn(ctx, 'window.__made[2].removed') === false);
    evalIn(ctx, `onTakeoverKey({key:'Escape'})`);
    suite.check('Escape dismisses', evalIn(ctx, 'window.__made[2].removed') === true);

    evalIn(ctx, `showSoldTakeover(${sale}); showSoldTakeover(${sale});`);
    suite.check('a second sale straight after replaces the first rather than stacking',
      evalIn(ctx, 'window.__made[3].removed') === true && evalIn(ctx, 'window.__made[4].removed') === false);

    suite.check('dismissing when nothing is showing is harmless',
      (() => { evalIn(ctx, 'dismissSoldTakeover(); dismissSoldTakeover();'); return true; })());
  }

  suite.section('the takeover rides the same gate as the fireworks');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `
      window.__shown = [];
      showSoldTakeover = function(sale){ window.__shown.push(sale.name); };
      celebrateSaleFirework = function(){};
    `);
    const shown = () => evalIn(ctx, 'window.__shown.join(",")');
    const sold = (id, name, via) => `{id:'${id}', name:'${name}', result:'sold', ${via ? `via:'${via}',` : ''} team:'Lions', price:20, time:1}`;
    const unsold = (id, name) => `{id:'${id}', name:'${name}', result:'unsold', team:null, price:null, time:1}`;

    evalIn(ctx, `maybeCelebrateNewSale([${sold('s1','Kohli','auction')}])`);
    suite.check('nothing on first load', shown() === '');
    evalIn(ctx, `maybeCelebrateNewSale([${sold('s2','Bumrah','auction')}, ${sold('s1','Kohli','auction')}])`);
    suite.check('a new auction sale shows it, with that sale\'s details', shown() === 'Bumrah', shown());
    evalIn(ctx, `maybeCelebrateNewSale([${sold('s2','Bumrah','auction')}, ${sold('s1','Kohli','auction')}])`);
    suite.check('the same sale re-rendered does not show it again', shown() === 'Bumrah');
    evalIn(ctx, `maybeCelebrateNewSale([${unsold('s3','Pant')}, ${sold('s2','Bumrah')}])`);
    suite.check('unsold never shows it', shown() === 'Bumrah');
    evalIn(ctx, `maybeCelebrateNewSale([${sold('s4','Gill','assigned')}, ${unsold('s3','Pant')}])`);
    suite.check('a pre-auction assign never shows it', shown() === 'Bumrah');
    evalIn(ctx, `maybeCelebrateNewSale([${sold('s5','Siraj')}, ${sold('s4','Gill','assigned')}])`);
    suite.check('a legacy row with no `via` still does', shown() === 'Bumrah,Siraj', shown());

    // Released and re-sold: the row is keyed by player id so it is OVERWRITTEN
    // (same id) with a fresh time. This used to show nothing the second time.
    const resold = (time) => `{id:'s5', name:'Siraj', result:'sold', via:'auction', team:'Tigers', price:30, time:${time}}`;
    evalIn(ctx, `maybeCelebrateNewSale([${resold(50)}, ${sold('s4','Gill','assigned')}])`);
    suite.check('re-selling the same player shows it again, with the NEW team and price',
      shown() === 'Bumrah,Siraj,Siraj', shown());
    evalIn(ctx, `maybeCelebrateNewSale([${resold(50)}, ${sold('s4','Gill','assigned')}])`);
    suite.check('  and re-rendering that re-sale does not repeat it', shown() === 'Bumrah,Siraj,Siraj', shown());
  }

  suite.section('it does not depend on the temporary fireworks flag');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    suite.check('the takeover code does not reference TEMP_FIREWORKS_ENABLED',
      !/TEMP_FIREWORKS_ENABLED/.test(evalIn(ctx, 'showSoldTakeover.toString() + soldTakeoverMarkup.toString()')));
  }

  return suite.summarize();
}

module.exports = { name: 'takeover', run };

if (require.main === module){
  run().then(summary => process.exit(printSummary(summary)));
}
