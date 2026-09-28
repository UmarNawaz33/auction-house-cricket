/* ============================================================
   tests/public-sound.test.js — the sold sound on the PUBLIC view
   (js/public.js: playPublicSoldSound).

   By request, this has no unlock button and no "enabled" flag: it attempts
   to play unconditionally on every genuinely new sale, the same call shape
   as moderator.js's playSoldSound(), and simply loses silently wherever the
   browser's autoplay policy blocks it (nobody clicks index.html — it's the
   unattended big screen — so there's no user gesture to spend; see
   CLAUDE.md §6a). It rides the exact same once-per-new-sale gate as the
   takeover and fireworks (covered in depth by fireworks.test.js and
   takeover.test.js) — this file checks that playPublicSoldSound() itself is
   wired to that gate and behaves safely, not the gate again.

   Run this after touching: public.js's playPublicSoldSound(), or
   maybeCelebrateNewSale().
   ============================================================ */
const { ctxFor, evalIn } = require('./lib/dom-stub');
const { makeSuite, printSummary } = require('./lib/suite');

async function run(){
  const suite = makeSuite('public-sound');

  suite.section('playPublicSoldSound() plays unconditionally — no unlock step');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, 'playPublicSoldSound()');
    suite.check('attempts to play immediately, nothing to enable first',
      ctx.__audio.length === 1 && ctx.__audio[0] === 'sound/sell.mp3');
  }

  suite.section('reuses one <audio> element rather than rebuilding it');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, 'playPublicSoldSound();');
    const first = evalIn(ctx, 'publicSoldSound');
    evalIn(ctx, 'playPublicSoldSound(); playPublicSoldSound();');
    suite.check('same object across calls', evalIn(ctx, 'publicSoldSound') === first);
    suite.check('three plays recorded', ctx.__audio.filter(s => s === 'sound/sell.mp3').length === 3);
  }

  suite.section('a rejected play() (the realistic case: autoplay blocked) does not throw');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, `Audio = function(src){ this.src = src; this.play = () => Promise.reject(new Error('NotAllowedError')); };`);
    // the rejection itself must actually be handled (p.catch), not just
    // survive being thrown past — an unhandled one would surface as a real
    // Node warning/crash risk, not a silently lost sound
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.once('unhandledRejection', onUnhandled);
    evalIn(ctx, 'playPublicSoldSound()');
    await new Promise(r => setImmediate(r));
    process.removeListener('unhandledRejection', onUnhandled);
    suite.check('no throw and no unhandled promise rejection', unhandled.length === 0);
  }

  suite.section('missing Audio (e.g. a stripped-down browser context) does not throw');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, 'Audio = undefined;');
    suite.check('no throw', (() => { evalIn(ctx, 'playPublicSoldSound()'); return true; })());
  }

  suite.section('wired to the same new-sale gate as the takeover/fireworks');
  {
    const ctx = ctxFor(['js/shared.js', 'js/public.js']);
    evalIn(ctx, 'celebrateSaleFirework = function(){}; showSoldTakeover = function(){};');

    const sold = (id, name, via, time) => `{id:'${id}', name:'${name}', result:'sold', ${via ? `via:'${via}',` : ''} team:'Lions', price:20, time:${time}}`;
    const unsold = (id, name, time) => `{id:'${id}', name:'${name}', result:'unsold', team:null, price:null, time:${time}}`;

    evalIn(ctx, `maybeCelebrateNewSale([${sold('s1', 'Kohli', 'auction', 1)}]);`); // first snapshot
    suite.check('nothing on first load', ctx.__audio.length === 0);

    evalIn(ctx, `maybeCelebrateNewSale([${sold('s2', 'Bumrah', 'auction', 2)}, ${sold('s1', 'Kohli', 'auction', 1)}]);`);
    suite.check('a genuinely new auction sale plays the hammer', ctx.__audio.length === 1);

    evalIn(ctx, `maybeCelebrateNewSale([${sold('s2', 'Bumrah', 'auction', 2)}, ${sold('s1', 'Kohli', 'auction', 1)}]);`);
    suite.check('re-rendering the same sale does not replay it', ctx.__audio.length === 1);

    evalIn(ctx, `maybeCelebrateNewSale([${unsold('s3', 'Pant', 3)}, ${sold('s2', 'Bumrah', 'auction', 2)}]);`);
    suite.check('unsold never plays it', ctx.__audio.length === 1);

    evalIn(ctx, `maybeCelebrateNewSale([${sold('s4', 'Gill', 'assigned', 4)}, ${unsold('s3', 'Pant', 3)}]);`);
    suite.check('a pre-auction Assign never plays it', ctx.__audio.length === 1);

    evalIn(ctx, `maybeCelebrateNewSale([${sold('s2', 'Bumrah', 'auction', 50)}, ${sold('s4', 'Gill', 'assigned', 4)}]);`);
    suite.check('the SAME player released and re-sold plays it again', ctx.__audio.length === 2);
  }

  suite.section('no leftover "enable sound" UI');
  {
    const fs = require('fs');
    const path = require('path');
    const { ROOT } = require('./lib/dom-stub');
    for (const page of ['index.html', 'admin.html', 'moderator.html', 'team.html']){
      const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
      suite.check(page + ' has no soundToggle button', !/soundToggle/.test(html));
    }
    const src = fs.readFileSync(path.join(ROOT, 'js/public.js'), 'utf8');
    suite.check('public.js defines no enablePublicSound/updateSoundToggle/publicSoundEnabled',
      !/enablePublicSound|updateSoundToggle|publicSoundEnabled/.test(src));
  }

  return suite.summarize();
}

module.exports = { name: 'public-sound', run };

if (require.main === module){
  run().then(summary => process.exit(printSummary(summary)));
}
