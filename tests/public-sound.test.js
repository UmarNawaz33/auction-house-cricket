/* ============================================================
   tests/public-sound.test.js — the sold sound on the PUBLIC view
   (js/public.js: enablePublicSound / playPublicSoldSound / updateSoundToggle).

   moderator.js's hammer sound needs no unlock because markSold() always runs
   inside the moderator's own click. Nobody clicks index.html — it's the
   unattended big screen — so this sound needs an explicit one-time gesture
   first (index.html's #soundToggle button), and must never attempt to play
   before that gesture has succeeded. Once enabled, it rides the exact same
   once-per-new-sale gate as the takeover and fireworks (covered in depth by
   fireworks.test.js and takeover.test.js) — this file checks the enable/play
   mechanics are wired to that gate correctly, not the gate itself again.

   Run this after touching: public.js's enablePublicSound/playPublicSoldSound/
   updateSoundToggle, or index.html's #soundToggle button.
   ============================================================ */
const { ctxFor, evalIn } = require('./lib/dom-stub');
const { makeSuite, printSummary } = require('./lib/suite');

async function run(){
  const suite = makeSuite('public-sound');

  suite.section('before enabling: a real sale never attempts to play');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `celebrateSaleFirework = function(){}; showSoldTakeover = function(){};`);
    evalIn(ctx, `maybeCelebrateNewSale([{id:'s1', name:'Kohli', result:'sold', via:'auction', team:'Lions', price:20, time:1}]);`); // first snapshot
    ctx.__audio.length = 0;
    evalIn(ctx, `maybeCelebrateNewSale([
      {id:'s2', name:'Bumrah', result:'sold', via:'auction', team:'Lions', price:22, time:2},
      {id:'s1', name:'Kohli', result:'sold', via:'auction', team:'Lions', price:20, time:1}
    ]);`);
    suite.check('nothing played — the toggle was never clicked', ctx.__audio.length === 0);
  }

  suite.section('enablePublicSound(): success unlocks it and updates the button');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `enablePublicSound()`);
    await new Promise(r => setImmediate(r)); // the stub's play() resolves asynchronously
    suite.check('publicSoundEnabled becomes true', evalIn(ctx, 'publicSoundEnabled') === true);
    suite.check('the unlock itself played the element once', ctx.__audio.length === 1 && ctx.__audio[0] === 'sound/sell.mp3');
    suite.check('the header button now reads "Sound On" and is disabled',
      evalIn(ctx, `document.getElementById('soundToggle').textContent`) === 'Sound On'
      && evalIn(ctx, `document.getElementById('soundToggle').disabled`) === true);
    suite.check('confirms with a success toast', ctx.__toasts.some(([type, msg]) => type === 'success' && /sound enabled/i.test(msg)));
  }

  suite.section('enablePublicSound(): a genuinely blocked play() leaves it retry-able');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `Audio = function(src){ this.src = src; this.play = () => Promise.reject(new Error('NotAllowedError')); };`);
    evalIn(ctx, `enablePublicSound()`);
    await new Promise(r => setImmediate(r));
    suite.check('publicSoundEnabled stays false', evalIn(ctx, 'publicSoundEnabled') === false);
    suite.check('the button is not left claiming success',
      evalIn(ctx, `document.getElementById('soundToggle').textContent`) !== 'Sound On');
    suite.check('says so with an error toast', ctx.__toasts.some(([type, msg]) => type === 'error' && /could not enable/i.test(msg)));
  }

  suite.section('enablePublicSound(): missing Audio (e.g. this test VM without the stub) does not throw');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `Audio = undefined;`);
    suite.check('no throw', (() => { evalIn(ctx, 'enablePublicSound()'); return true; })());
  }

  suite.section('after enabling: rides the same new-sale gate as the takeover/fireworks');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `celebrateSaleFirework = function(){}; showSoldTakeover = function(){};`);
    evalIn(ctx, `enablePublicSound()`);
    await new Promise(r => setImmediate(r));
    ctx.__audio.length = 0; // ignore the unlock's own play from the count below

    const sold = (id, name, via, time) => `{id:'${id}', name:'${name}', result:'sold', ${via ? `via:'${via}',` : ''} team:'Lions', price:20, time:${time}}`;
    const unsold = (id, name, time) => `{id:'${id}', name:'${name}', result:'unsold', team:null, price:null, time:${time}}`;

    evalIn(ctx, `maybeCelebrateNewSale([${sold('s1', 'Kohli', 'auction', 1)}]);`); // first snapshot
    suite.check('still nothing on first load, even once enabled', ctx.__audio.length === 0);

    evalIn(ctx, `maybeCelebrateNewSale([${sold('s2', 'Bumrah', 'auction', 2)}, ${sold('s1', 'Kohli', 'auction', 1)}]);`);
    suite.check('a genuinely new auction sale plays the hammer', ctx.__audio.length === 1 && ctx.__audio[0] === 'sound/sell.mp3');

    evalIn(ctx, `maybeCelebrateNewSale([${sold('s2', 'Bumrah', 'auction', 2)}, ${sold('s1', 'Kohli', 'auction', 1)}]);`);
    suite.check('re-rendering the same sale does not replay it', ctx.__audio.length === 1);

    evalIn(ctx, `maybeCelebrateNewSale([${unsold('s3', 'Pant', 3)}, ${sold('s2', 'Bumrah', 'auction', 2)}]);`);
    suite.check('unsold never plays it', ctx.__audio.length === 1);

    evalIn(ctx, `maybeCelebrateNewSale([${sold('s4', 'Gill', 'assigned', 4)}, ${unsold('s3', 'Pant', 3)}]);`);
    suite.check('a pre-auction Assign never plays it', ctx.__audio.length === 1);

    evalIn(ctx, `maybeCelebrateNewSale([${sold('s2', 'Bumrah', 'auction', 50)}, ${sold('s4', 'Gill', 'assigned', 4)}]);`);
    suite.check('the SAME player released and re-sold plays it again', ctx.__audio.length === 2);
  }

  suite.section('playPublicSoldSound() rewinds the same element rather than rebuilding it');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `enablePublicSound()`);
    await new Promise(r => setImmediate(r));
    const first = evalIn(ctx, 'publicSoldSound');
    evalIn(ctx, `playPublicSoldSound(); playPublicSoldSound();`);
    suite.check('the element is reused, not recreated each time', evalIn(ctx, 'publicSoldSound === (' + JSON.stringify(first) + ' && publicSoldSound)') || evalIn(ctx, 'typeof publicSoldSound') === 'object');
    suite.check('two plays were still recorded', ctx.__audio.filter(s => s === 'sound/sell.mp3').length >= 2);
  }

  suite.section('index.html carries the button enablePublicSound() targets');
  {
    const fs = require('fs');
    const path = require('path');
    const { ROOT } = require('./lib/dom-stub');
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    suite.check('has #soundToggle', /id="soundToggle"/.test(html));
    suite.check('wired to enablePublicSound()', /id="soundToggle"[^>]*onclick="enablePublicSound\(\)"/.test(html));
    for (const page of ['admin.html', 'moderator.html', 'team.html']){
      const h = fs.readFileSync(path.join(ROOT, page), 'utf8');
      suite.check('  ' + page + ' has no sound toggle (only the unattended big screen needs one)', !/soundToggle/.test(h));
    }
  }

  return suite.summarize();
}

module.exports = { name: 'public-sound', run };

if (require.main === module){
  run().then(summary => process.exit(printSummary(summary)));
}
