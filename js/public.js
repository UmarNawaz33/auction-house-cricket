/* ============================================================
   public.js — read-only live view. No auth, no writes.

   LIQUID GLASS (dark). Everything this look needs — Bootstrap
   and the whole theme — is injected from this one file, so
   index.html and css/styles.css are untouched and reverting is
   a single swap:

       copy js\public.classic.js js\public.js

   js/public.classic.js is a byte-identical copy of the original.

   The material follows Apple's Liquid Glass vocabulary:
     - lensing      a refractive rim where the glass bends the
                    colour behind it, brightest where light hits
     - specular     a highlight sweep across the top of each
                    surface, plus a soft inner bloom
     - concentric   nested radii step down by their inset, so
                    inner corners sit parallel to outer ones
     - floating     the header is a detached capsule of glass
                    riding above the content, not a chrome bar
   Saturated colour orbs sit behind everything: glass needs
   vivid content behind it or the lensing has nothing to bend.
   ============================================================ */

/* ---------------- Look & feel ----------------
   index.html links css/styles.css, then Bootstrap, then css/theme.css; this
   sheet is appended last so it wins over all three. */

(function injectLook(){
  // Bootstrap and css/theme.css are linked from index.html now; this only adds
  // the pv-* component styles the public view uses on top of them.
  const style = document.createElement('style');
  style.id = 'pv-theme';
  style.textContent = pvCss(); // hoisted; the sheet itself lives at the foot of this file
  document.head.appendChild(style);
})();

// REACTION_EMOJI must be declared before the injectReactionBar() call just
// below, not down in the "Spectator reactions" section next to the
// functions that use it (a `const` is NOT given a value until its own
// declaration line runs, unlike a function declaration — reading one before
// that line throws "Cannot access before initialization"). This is the
// SAME TDZ trap __fwSeenFirstSnapshot/__takeoverEl above exist to avoid, and
// it bit this feature for real the first time round: the default test-stub
// getElementById() always returns a truthy stub (see tests/lib/dom-stub.js's
// own doc comment), so injectReactionBar()'s "already exists, skip" guard
// silently short-circuited before ever reaching REACTION_EMOJI in every
// Node test — the throw only showed up on a real page load in a real
// browser. Don't move this line back down without re-testing in an actual
// browser, not just `node tests/run.js`.
const REACTION_EMOJI = ['🔥','👏','😮','❤️','😂'];

// injectReactionBar() is defined further down (Spectator reactions, hoisted
// like pvCss() above); the reaction bar is static markup that never needs to
// re-render, so it's injected once here rather than living in renderPublic().
injectReactionBar();

// injectStageWash() is defined further down (Leader-color stage wash,
// hoisted like the two above); its element is also injected once and then
// only ever has classes toggled on it (updateStageWash(), called from
// renderPublic()) — never destroyed/recreated, same reasoning as the
// reaction bar.
injectStageWash();

/* ---------------- State ---------------- */

let pv = { settings:{currencyUnit:'Cr'}, teams:{}, players:{}, auction:{}, sales:[] };

// Once bidding is complete the page falls back to a home screen; the previous
// results stay one click away rather than on show.
let showPastResults = false;
function togglePastResults(){ showPastResults = !showPastResults; renderPublic(); }
// Same idea for the end-of-auction awards: on request, never auto-shown.
let showAwards = false;
function toggleAwards(){ showAwards = !showAwards; renderPublic(); }

// TEMP FIREWORKS state — part of the temporary fireworks-on-sold feature
// (search this file for "TEMP FIREWORKS" / "TEMP_FIREWORKS" to find every
// piece; the bulk of it, including how to remove it, lives near the foot of
// the file). These two MUST be declared before the `recentSales` listener
// below, which reads them: `.on('value', cb)` can resolve synchronously from
// Firebase's local cache, and a `let` referenced before its own declaration
// line throws — this bit a browser test the first time round.
let __fwSeenFirstSnapshot = false; // true once we've seen one recentSales snapshot
let __fwLastSaleKey = null;        // newest sale (id + time) we've already reacted to

// Sold takeover state. Same rule as the two above: declared here, before the
// `recentSales` listener, because that listener can run synchronously from
// Firebase's local cache and reaches showSoldTakeover() on its first call.
let __takeoverEl = null;           // the overlay currently on screen, if any
let __takeoverTimer = null;        // the pending countdown tick / exit timer
const TAKEOVER_SECONDS = 5;        // how long the card stays up, and what the timer counts from
const TAKEOVER_EXIT_MS = 300;      // the fade-out once the timer reaches 0

/* Public-view sold sound. moderator.js's hammer sound plays fine because
   markSold() runs inside the moderator's own click — that IS the user
   gesture browsers require before audio may play. Nobody clicks index.html;
   it's the unattended big screen. So the sound here needs an explicit
   one-time unlock: index.html's header has an "Enable Sound" button
   (#soundToggle) wired to enablePublicSound() below. Declared here, not
   lower in the file, for the same reason as the two blocks above it: the
   `recentSales` listener a few lines down can resolve synchronously from
   Firebase's local cache and may reach playPublicSoldSound() on its very
   first call. */
let publicSoldSound = null;    // the one <audio> element, reused every play — see below for why reuse matters
let publicSoundEnabled = false; // true only after a real click has succeeded

/* State for the four audience features driven off the `auction` listener
   below (record banner excepted — that one lives off the recentSales
   listener, next to the sold takeover it shares a gate with). Declared here
   for the same TDZ reason as every block above: the listener can resolve
   synchronously from Firebase's local cache on its very first call. */
let __bidPulseTimes = [];  // recent Date.now()s of genuine bid changes, oldest first
let __biddingWarUntil = 0; // Date.now() the "heating up" visual should clear by
let __lastBidPrice = null; // for detecting a genuine bid vs. an unrelated auction write
let __lastBidLeader = null;
let __justRevealed = false; // true for exactly one render: the lot just changed
const BIDDING_WAR_COUNT = 3;        // this many bids...
const BIDDING_WAR_WINDOW_MS = 9000; //  ...within this many ms...
const BIDDING_WAR_DISPLAY_MS = 5000; // ...shows the "heating up" visual for this long

watchConnection('connBadge');

db.ref('settings').on('value', s=>{ pv.settings = s.val() || pv.settings; window.__settingsCache = pv.settings; renderPublic(); });
db.ref('teams').on('value', s=>{ pv.teams = s.val() || {}; renderPublic(); });
db.ref('squads').on('value', s=>{
  const squads = s.val() || {};
  Object.keys(pv.teams).forEach(id=>{ pv.teams[id] = pv.teams[id] || {}; pv.teams[id].squad = squads[id] || {}; });
  renderPublic();
});
db.ref('players').on('value', s=>{ pv.players = s.val() || {}; renderPublic(); });
db.ref('auction').on('value', s=>{
  const next = s.val() || {};
  handleAuctionTransition(pv.auction, next); // bidding-war pulse, reveal flag, reaction reset
  pv.auction = next;
  renderPublic();
  __justRevealed = false; // consumed by the render just above — see its own comment
});
db.ref('recentSales').on('value', s=>{
  pv.sales = salesArray(s.val());
  maybeCelebrateNewSale(pv.sales); // TEMP FIREWORKS hook (piece 2 of 3 — see below)
  renderPublic();
});

/**
 * Three audience features share one piece of bookkeeping: "did the lot just
 * change, and did a bid just land?" `prev`/`next` are the auction node before
 * and after this snapshot.
 *
 *   - a NEW player on the block (including the first snapshot this viewer
 *     ever sees, if a lot is already live) sets __justRevealed for the
 *     player-reveal animation, and resets everything below as a fresh start
 *   - the lot ending (currentPlayerId -> null, any reason) resets the same
 *     things — no player on the block, nothing to be "heating up" about
 *   - the SAME player, but currentPrice or leaderTeamId changed, is a real
 *     bid: it feeds the bidding-war pulse counter
 *
 * Every one of those three cases also clears any reaction emoji still
 * floating on screen (clearReactions()) — "reset for every new bid" is a
 * deliberate product choice, not a technical necessity: nothing here is
 * stored anywhere, so there's no data-integrity reason to clear it, it just
 * keeps the screen feeling like it's moving forward with the auction rather
 * than accumulating clutter.
 *
 * Known imprecision: the moderator's "Reset Bid" (resetBid() in
 * moderator.js) also changes currentPrice/leaderTeamId on the SAME lot, so
 * it is indistinguishable from a real bid here and can contribute one spare
 * pulse to the bidding-war counter. Accepted — Reset Bid is rare, and the
 * consequence is one extra pulse, not a wrongly-shown banner.
 */
function handleAuctionTransition(prev, next){
  const prevPlayer = (prev && prev.currentPlayerId) || null;
  const nextPlayer = (next && next.currentPlayerId) || null;

  if(nextPlayer && nextPlayer !== prevPlayer){
    __justRevealed = true;
    __bidPulseTimes = [];
    __biddingWarUntil = 0;
    __lastBidPrice = next.currentPrice != null ? next.currentPrice : null;
    __lastBidLeader = next.leaderTeamId || null;
    clearReactions();
    return;
  }
  if(!nextPlayer){
    __bidPulseTimes = [];
    __biddingWarUntil = 0;
    __lastBidPrice = null;
    __lastBidLeader = null;
    clearReactions();
    return;
  }
  const price = next.currentPrice != null ? next.currentPrice : null;
  const leader = next.leaderTeamId || null;
  if(price !== __lastBidPrice || leader !== __lastBidLeader){
    registerBid();
    clearReactions();
  }
  __lastBidPrice = price;
  __lastBidLeader = leader;
}

/** A bid landed: record it, and if that makes BIDDING_WAR_COUNT within
 *  BIDDING_WAR_WINDOW_MS, light up the "heating up" visual for
 *  BIDDING_WAR_DISPLAY_MS. Nothing re-renders purely because a timeout
 *  elapses, so one extra render is scheduled right as it should clear —
 *  otherwise the glow would stay lit until the next unrelated Firebase
 *  update happened to fire. */
function registerBid(){
  const now = Date.now();
  __bidPulseTimes.push(now);
  __bidPulseTimes = __bidPulseTimes.filter(t => now - t <= BIDDING_WAR_WINDOW_MS);
  if(__bidPulseTimes.length >= BIDDING_WAR_COUNT){
    __biddingWarUntil = now + BIDDING_WAR_DISPLAY_MS;
    setTimeout(()=>{ if(Date.now() >= __biddingWarUntil) renderPublic(); }, BIDDING_WAR_DISPLAY_MS + 50);
  }
}
function isBiddingWarActive(){ return Date.now() < __biddingWarUntil; }

/* ---------------- Leader-color stage wash ----------------
   A full-viewport tint behind everything, coloured to whichever team is
   CURRENTLY LEADING the lot — hueFor(leader.name), the exact same hashing
   their team card/dot already uses, so the colour always matches. The
   room's own mood shifts with who's winning, not just a number changing.

   Injected once (alongside injectReactionBar() at the top of this file)
   and from then on only ever has classes toggled on it (updateStageWash(),
   called from renderPublic()) — never destroyed/recreated, so it survives
   every #tabContent re-render untouched, same pattern as the reaction bar.
   No leader (base price active, nobody's bid yet) means no wash — this is
   about the CONTEST, not decoration for its own sake. */
function injectStageWash(){
  if(typeof document === 'undefined') return;
  if(document.getElementById('pvStageWash')) return;
  const el = document.createElement('div');
  el.id = 'pvStageWash';
  el.setAttribute('aria-hidden', 'true');
  // appendChild, not insertBefore(…, firstChild) — DOM order doesn't matter
  // here (z-index:-1 already puts it behind the page's normal, non-positioned
  // content regardless of where in <body> it sits), and appendChild matches
  // every other injected element in this file (the reaction bar/layer), so
  // there's one pattern to remember, not two.
  document.body.appendChild(el);
}

function updateStageWash(auc, leader){
  if(typeof document === 'undefined') return;
  const el = document.getElementById('pvStageWash');
  if(!el) return;
  PV_HUES.forEach(h => el.classList.remove(h));
  const active = !!(leader && auc && auc.currentPlayerId && !isCompleted(auc));
  if(!active){ el.classList.remove('is-active', 'is-war'); return; }
  el.classList.add(hueFor(leader.name));
  el.classList.add('is-active');
  el.classList.toggle('is-war', isBiddingWarActive());
}

/**
 * TEMP FIREWORKS hook (piece 2 of 3 — see the "TEMPORARY FEATURE" block near
 * the foot of this file for the rest and how to remove it). Fires once per
 * genuinely new sale (not just a re-render), never on the page's first load,
 * and only for a real live auction sale — not the moderator's pre-auction
 * "Assign" action, which tags its row `via:'assigned'` for exactly this
 * check. Pulled out of the `recentSales` listener as its own function so it's
 * directly testable without needing to fake a Firebase snapshot event.
 *
 * "Same sale" means same id AND same time. Sales are keyed by player id, so
 * releasing a player and re-selling them OVERWRITES their one row instead of
 * adding another; an id-only comparison saw an unchanged id and stayed silent
 * for the re-sale. saleRecord() stamps a fresh `time: Date.now()` on every
 * write, so id + time identifies one specific sale event.
 */
function saleKey(sale){ return sale ? sale.id + ':' + (sale.time || 0) : null; }

/* ---- "New Record" banner state ----
   The highest REAL auction-sale price seen so far (never a retained/assigned
   player — soldLabel() in shared.js is the reminder that `via`, not `result`,
   is what tells the two apart). null until a sale has actually been seen, so
   the very first sale of the auction is never announced as "beating" a record
   that doesn't exist yet. Seeded from history (not announced) on the first
   recentSales snapshot, same as __fwLastSaleKey just above, so a viewer who
   opens the page mid-auction doesn't get a false "new record" the moment the
   NEXT ordinary sale happens to be merely high, not actually the highest. */
let __recordHighest = null;
function seedRecordFromHistory(sales){
  __recordHighest = null;
  sales.forEach(s=>{
    if(s.result==='sold' && s.via!=='assigned' && s.price!=null){
      if(__recordHighest===null || s.price > __recordHighest) __recordHighest = s.price;
    }
  });
}
function isNewRecord(sale){
  return __recordHighest !== null && sale.price != null && sale.price > __recordHighest;
}
function updateRecord(sale){
  if(sale.price == null) return;
  if(__recordHighest === null || sale.price > __recordHighest) __recordHighest = sale.price;
}

function maybeCelebrateNewSale(sales){
  const newestSale = sales[0];
  if(!__fwSeenFirstSnapshot){
    __fwSeenFirstSnapshot = true;
    __fwLastSaleKey = saleKey(newestSale);
    seedRecordFromHistory(sales);
    return;
  }
  if(newestSale && saleKey(newestSale) !== __fwLastSaleKey){
    __fwLastSaleKey = saleKey(newestSale);
    if(newestSale.result === 'sold' && newestSale.via !== 'assigned'){
      const isRecord = isNewRecord(newestSale);
      playPublicSoldSound();
      showSoldTakeover(newestSale, {isRecord});
      celebrateSaleFirework(isRecord);
      if(isRecord) screenShakeForRecord();
      updateRecord(newestSale);
    }
  }
}

/* ---------------- Public sold sound ----------------
   One <audio> element, reused for both the unlock and every later play —
   NOT rebuilt each time, the way moderator.js's playSoldSound() also reuses
   one. That reuse matters more here than there: Safari's autoplay policy is
   element-specific, so the unlock granted by enablePublicSound()'s
   gesture-triggered play() only carries over to a LATER programmatic
   play() on that exact element, not to a fresh `new Audio(...)`. */
function enablePublicSound(){
  if(typeof Audio === 'undefined') return; // headless test context
  try{
    if(!publicSoldSound) publicSoldSound = new Audio('sound/sell.mp3');
    const p = publicSoldSound.play();
    const unlocked = () => {
      publicSoldSound.pause();
      publicSoldSound.currentTime = 0;
      publicSoundEnabled = true;
      updateSoundToggle();
      toast('Sale sound enabled for this screen.', 'success');
    };
    if(p && p.then) p.then(unlocked).catch(()=>{ toast('Could not enable sound — check this tab/site isn\'t muted.', 'error'); });
    else unlocked(); // the test stub's play() doesn't return a promise-like with .then in every case
  }catch(e){ /* stays unenabled; the button stays offered so they can retry */ }
}

/** Reflects publicSoundEnabled onto index.html's static #soundToggle button.
 *  That button lives in the header, outside #tabContent, so it survives
 *  every renderPublic() re-render untouched — this is the one place that
 *  has to update it by hand. */
function updateSoundToggle(){
  if(typeof document === 'undefined') return;
  const btn = document.getElementById('soundToggle');
  if(!btn) return;
  if(publicSoundEnabled){ btn.textContent = 'Sound On'; btn.disabled = true; }
}

function playPublicSoldSound(){
  if(!publicSoundEnabled) return; // never attempted before the unlock click — an unlocked-but-blocked play() can log a console warning per browser
  if(typeof Audio === 'undefined') return;
  try{
    if(!publicSoldSound) publicSoldSound = new Audio('sound/sell.mp3');
    publicSoldSound.currentTime = 0;
    const p = publicSoldSound.play();
    if(p && p.catch) p.catch(()=>{});
  }catch(e){ /* audio is decoration; never block the takeover on it */ }
}

/* ---------------- Sold takeover ----------------
   When a real auction sale lands, the whole screen becomes the result: the
   player, the team, the price. This is the moment the room is waiting for, so
   it should not depend on anyone glancing at a corner of the page.

   It rides the SAME gate as the fireworks (maybeCelebrateNewSale above): once
   per genuinely new sale, never on first load, never for unsold, never for the
   moderator's pre-auction "Assign". It is a permanent feature and is
   independent of TEMP_FIREWORKS_ENABLED.

   It stays up TAKEOVER_SECONDS (5). A circular timer in the top-right corner
   counts 5 → 0 so the room knows how long is left; at 0 the card fades out
   over TAKEOVER_EXIT_MS. Tap or Escape closes it early.

   The number and the close are driven by ONE chain of 1-second timeouts
   (tickSoldTakeover), so the digit on screen and the moment the card goes
   can't disagree. The ring around it is a CSS animation of the same length —
   purely visual, so a throttled timer can at worst make the ring and number
   drift by a fraction of a second, never change when the card closes. (A
   setInterval / wall-clock stop condition was rejected for the same reason
   the fireworks avoid one: see CLAUDE.md §7a.)

   The markup builder is separate from the DOM code so it can be tested as a
   plain string. Every value that came from the database is escaped.

   `opts.isRecord` (from isNewRecord() above, next to maybeCelebrateNewSale)
   swaps the "Sold" stamp for "New Record!" and adds a `.is-record` modifier
   class for a distinct colour treatment — same card, same timer, same
   dismiss/Escape/replace behaviour, just a different moment. */
function soldTakeoverMarkup(sale, opts){
  const s = sale || {};
  const o = opts || {};
  return `
  <div class="pv-takeover-timer" aria-hidden="true">
    <svg class="pv-takeover-ring" viewBox="0 0 56 56" focusable="false">
      <circle class="pv-takeover-ring-bg" cx="28" cy="28" r="24"/>
      <circle class="pv-takeover-ring-fg" cx="28" cy="28" r="24" style="animation-duration:${TAKEOVER_SECONDS}s; --pv-take-steps:${TAKEOVER_SECONDS}"/>
    </svg>
    <span class="pv-takeover-count" id="pvTakeoverCount">${TAKEOVER_SECONDS}</span>
  </div>
  <div class="pv-takeover-card${o.isRecord ? ' is-record' : ''}">
    <div class="pv-takeover-stamp">${o.isRecord ? 'New Record!' : 'Sold'}</div>
    <img class="pv-takeover-photo" src="${escapeAttr(playerImageSrc({image:s.image}))}" alt=""
         onerror="this.onerror=null;this.src='${DEFAULT_PLAYER_IMAGE}';">
    <div class="pv-takeover-name">${escapeHtml(s.name || 'Player')}</div>
    <div class="pv-takeover-to">to <strong>${escapeHtml(s.team || 'a team')}</strong></div>
    <div class="pv-bid pv-takeover-price">${money(s.price)}</div>
    <div class="pv-takeover-hint">Tap anywhere to close</div>
  </div>`;
}

function dismissSoldTakeover(){
  if(__takeoverTimer){ clearTimeout(__takeoverTimer); __takeoverTimer = null; }
  if(__takeoverEl){ __takeoverEl.remove(); __takeoverEl = null; }
  if(typeof document !== 'undefined' && document.removeEventListener){
    document.removeEventListener('keydown', onTakeoverKey);
  }
}
function onTakeoverKey(e){ if(e && e.key === 'Escape') dismissSoldTakeover(); }

function showSoldTakeover(sale, opts){
  if(typeof document === 'undefined') return;
  dismissSoldTakeover(); // a second sale right behind the first replaces it
  const el = document.createElement('div');
  el.className = 'pv-takeover' + ((opts && opts.isRecord) ? ' is-record' : '');
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('onclick', 'dismissSoldTakeover()');
  el.innerHTML = soldTakeoverMarkup(sale, opts);
  document.body.appendChild(el);
  __takeoverEl = el;
  document.addEventListener('keydown', onTakeoverKey);
  // the markup already shows TAKEOVER_SECONDS; the first tick is one second in
  __takeoverTimer = setTimeout(() => tickSoldTakeover(TAKEOVER_SECONDS - 1), 1000);
}

/** One second has passed: show `left`, then either schedule the next second
 *  or, at 0, fade out and remove. Does nothing if the card was closed early. */
function tickSoldTakeover(left){
  if(!__takeoverEl) return;
  const count = document.getElementById('pvTakeoverCount');
  if(count) count.textContent = String(left);
  if(left > 0){
    __takeoverTimer = setTimeout(() => tickSoldTakeover(left - 1), 1000);
    return;
  }
  __takeoverEl.classList.add('is-leaving');
  __takeoverTimer = setTimeout(dismissSoldTakeover, TAKEOVER_EXIT_MS);
}

/* ---------------- Spectator reactions ----------------
   By explicit request: NOTHING here touches Firebase. No write path, no
   database.rules.json change, no auth — every tap is purely local to that
   one viewer's own browser tab, gone the moment they close it. That also
   means reactions are NOT shared between different viewers' screens; each
   person watching gets their own private "send a reaction" toy, not a
   stadium-wide shared overlay. If that ever needs to change, it needs a
   deliberate access-control decision first (see the "New Record"/bidding-war
   features for how little plumbing the FIREBASE-backed audience features
   needed by comparison) — don't wire this to the database as a quick add-on.

   The button bar is injected once (alongside injectLook() at the top of this
   file) and lives outside #tabContent, so renderPublic()'s full-template
   replace never touches it — it needs no state and never needs to
   re-render. The floating layer the emoji rise through is the same pattern
   as the fireworks canvas and the sold takeover: created on first use,
   appended straight to <body>, each particle removes itself once its CSS
   animation ends.

   "Reset for every new bid" (handleAuctionTransition() above) means any
   still-floating reactions are cleared out immediately whenever the lot
   changes or a bid lands — clearReactions() is called from there, not here.

   REACTION_EMOJI itself lives at the TOP of the file (next to the other
   early state), not here next to the functions that use it — see that
   declaration's own comment for why. */

function reactionBarMarkup(){
  return `
  <div class="pv-reactions" role="group" aria-label="Send a reaction">
    ${REACTION_EMOJI.map(e=>`<button type="button" class="pv-reaction-btn" onclick="sendReaction('${e}')" aria-label="React ${e}">${e}</button>`).join('')}
  </div>`;
}

function injectReactionBar(){
  if(typeof document === 'undefined') return;
  if(document.getElementById('pvReactionBar')) return;
  const el = document.createElement('div');
  el.id = 'pvReactionBar';
  el.innerHTML = reactionBarMarkup();
  document.body.appendChild(el);
}

function reactionLayer(){
  let layer = document.getElementById('pvReactionLayer');
  if(!layer){
    layer = document.createElement('div');
    layer.id = 'pvReactionLayer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
  }
  return layer;
}

/** Only ever called from a real onclick (a user gesture) — nothing here
 *  fires on its own, unlike the audio features, so there's no autoplay
 *  policy to work around. */
function sendReaction(emoji){
  if(typeof document === 'undefined') return;
  const layer = reactionLayer();
  const el = document.createElement('span');
  el.className = 'pv-reaction-particle';
  el.textContent = emoji;
  el.setAttribute('aria-hidden', 'true');
  // a little random horizontal placement + drift so a burst of taps spreads
  // out across the screen instead of stacking in one column
  el.style.left = (15 + Math.random()*70).toFixed(1) + '%';
  el.style.setProperty('--pv-drift', (Math.random()*60 - 30).toFixed(1) + 'px');
  layer.appendChild(el);
  setTimeout(()=>{ el.remove(); }, 2600);
}

function clearReactions(){
  if(typeof document === 'undefined') return;
  const layer = document.getElementById('pvReactionLayer');
  if(layer) layer.innerHTML = '';
}

/* ---------------- Render ---------------- */

function renderPublic(){
  const c = document.getElementById('tabContent');
  const teamsArr = Object.entries(pv.teams).map(([id,t])=>({id, ...t}));
  const auc = pv.auction || {};
  const player = auc.currentPlayerId ? pv.players[auc.currentPlayerId] : null;
  const leader = auc.leaderTeamId ? pv.teams[auc.leaderTeamId] : null;
  const pendingLeft = Object.values(pv.players).filter(p=>p.status==='pending').length;

  updateStageWash(auc, leader);

  // Bidding has been closed by the moderator: home screen, results on request.
  if(isCompleted(auc)){
    c.innerHTML = `
      <div class="pv-scope container-xl px-3 px-md-4">
        ${renderHomeScreen()}
        ${showAwards ? renderAwardsPanel(teamsArr) : ''}
        ${showPastResults ? `
          ${renderResultsPanel('Previous Bidding Results', 'Every player that went under the hammer, newest first.')}
          ${renderTeamsPanel(teamsArr, 'Final Squads')}
        ` : ''}
      </div>`;
    return;
  }

  c.innerHTML = `
    <div class="pv-scope container-xl px-3 px-md-4">
      ${renderStage(auc, player, leader, pendingLeft)}
      ${renderTeamsPanel(teamsArr, 'Teams')}
      ${renderResultsPanel('Live Results', 'Every player as they go under the hammer, newest first.')}
    </div>`;
}

/** The big area at the top: the live lot, or whatever is happening instead. */
function renderStage(auc, player, leader, pendingLeft){
  // Moderator stepped away — everything is on hold.
  if(isPaused(auc) && sessionInProgress(auc)){
    return pvBanner('warn', 'Auction paused',
      'The moderator has stepped away. Bidding is on hold and will pick up right where it left off.');
  }

  // A result was just called and the moderator hasn't put up the next lot yet.
  if(isAwaitingNext(auc)){
    if(pendingLeft===0){
      return pvBanner('good', "That's a wrap",
        'Every player has been auctioned. Final squads and purses are below.');
    }
    const last = auc.lastResult;
    return `
    ${last ? pvBanner(
        last.result==='sold' ? 'good' : 'warn',
        `${last.name} — ${last.result==='sold'?'sold':last.result==='unsold'?'unsold':'skipped'}`,
        last.result==='sold' ? `Bought by <b>${last.team}</b> for <b>${fmtMoney(last.price)}</b>.`
          : last.result==='unsold' ? 'No bids were placed.' : 'Back in the pool for later.'
      ) : ''}
    <section class="pv-panel pv-next">
      <div class="pv-next-eyebrow"><span class="pv-pulse"></span>Up next</div>
      <h2 class="pv-next-title">Next player coming up</h2>
      <p class="pv-next-sub">The moderator is about to put up the next lot — ${pendingLeft} player${pendingLeft===1?'':'s'} still to go.</p>
    </section>`;
  }

  if(!player){
    return `
    <section class="pv-panel pv-next">
      <div class="pv-next-eyebrow">Standing by</div>
      <h2 class="pv-next-title">No player on the block</h2>
      <p class="pv-next-sub">Waiting for the moderator to put someone up for auction.</p>
    </section>`;
  }

  return renderLiveLot(auc, player, leader);
}

/** The live lot: photo on the left, the bid — the headline — on the right.
 *  `__justRevealed` (set for exactly one render by handleAuctionTransition())
 *  adds a one-shot reveal animation class; `isBiddingWarActive()` adds a
 *  "heating up" tag when several bids have landed in quick succession. */
function renderLiveLot(auc, player, leader){
  const lotNo = pv.sales.length + 1;
  const hue = hueFor(player.category);
  const warActive = isBiddingWarActive();

  return `
  ${callBannerMarkup(auc)}
  <section class="pv-panel pv-lot ${hue}${__justRevealed ? ' is-revealing' : ''}">
    ${warActive ? `<div class="pv-war-tag"><span class="pv-war-flame" aria-hidden="true">🔥</span>Bidding War!</div>` : ''}
    ${lotMarkup(player, {
      eyebrow: `<span class="pv-live-dot"></span>Lot ${lotNo} &middot; On the block`,
      price: auc.currentPrice || player.basePrice,
      leader: leader
    })}
  </section>`;
}

/** The resting state: no auction running, with a way into the past results. */
function renderHomeScreen(){
  const sold = pv.sales.filter(r=>r.result==='sold');
  const hasHistory = pv.sales.length > 0;
  return `
  <section class="pv-panel pv-hero">
    <div class="pv-hero-mark">A</div>
    <h1 class="pv-hero-title">No live auction</h1>
    <p class="pv-hero-sub">There's no bidding going on at the moment. Check back when the next auction starts.</p>
    ${hasHistory ? `
      <div class="pv-hero-stats">
        <div class="pv-stat">
          <div class="pv-stat-val">${sold.length}</div>
          <div class="pv-stat-lbl">Players sold</div>
        </div>
        <span class="pv-stat-div"></span>
        <div class="pv-stat">
          <div class="pv-stat-val">${money(sold.reduce((s,r)=>s+(r.price||0),0))}</div>
          <div class="pv-stat-lbl">Total spend</div>
        </div>
      </div>
      <div class="pv-hero-actions">
        <button type="button" class="pv-btn pv-btn-gold" onclick="toggleAwards()">
          ${showAwards ? 'Hide auction awards' : '🏆 View auction awards'}
        </button>
        <button type="button" class="pv-btn" onclick="togglePastResults()">
          ${showPastResults ? 'Hide previous results' : 'View previous bidding results'}
        </button>
      </div>`
    : `<p class="pv-hero-none">No results to show yet.</p>`}
  </section>`;
}

/* ---------------- End-of-auction awards ----------------
   Shown on the completed home screen on request (toggleAwards()), next to
   the results button. Everything is derived from data already loaded — no
   new Firebase node, nothing stored.

   Player awards use REAL auction sales only (`via !== 'assigned'`): a
   pre-auction retention never went under the hammer, so it can't be the
   "most expensive buy" or a "bargain" (same distinction soldLabel() and the
   fireworks gate draw — read `via`, never player.status). Team awards read
   the squads (spentOf/remainingOf/squadCountOf), i.e. the same numbers the
   Teams panel shows, retentions included — a team's spend is its spend.

   Each award is null when it can't be computed (no sales, no teams, a zero
   base price); the panel only renders the ones that exist. Ties go to the
   first one found in a stable order — sales are newest-first, teams in
   database order — so a given result set always names the same winner. */
function computeAwards(sales, teamsArr){
  const auctioned = sales.filter(s => s.result === 'sold' && s.via !== 'assigned' && s.price != null);
  const pick = (arr, better) => arr.reduce((best, x) => (best === null || better(x, best)) ? x : best, null);

  const mostExpensive = pick(auctioned, (a, b) => a.price > b.price);
  const withBase = auctioned.filter(s => s.basePrice > 0);
  const biggestJump = pick(withBase, (a, b) => (a.price / a.basePrice) > (b.price / b.basePrice));
  // Lowest price-to-base ratio; on a tie, the player with the higher base
  // price is the better steal (a 20 Cr player at base beats a 2 Cr one).
  const bestBargain = pick(withBase, (a, b) => {
    const ra = a.price / a.basePrice, rb = b.price / b.basePrice;
    return ra < rb || (ra === rb && a.basePrice > b.basePrice);
  });

  const buyers = teamsArr.filter(t => squadCountOf(t) > 0);
  const biggestSpender = pick(buyers, (a, b) => spentOf(a) > spentOf(b));
  const thriftiest = pick(buyers, (a, b) => remainingOf(a) > remainingOf(b));
  const biggestSquad = pick(buyers, (a, b) => squadCountOf(a) > squadCountOf(b));

  return [
    mostExpensive && {icon:'💰', title:'Most Expensive Buy', winner:mostExpensive.name,
      detail:`${mostExpensive.team || '—'} paid ${fmtMoney(mostExpensive.price)}`, hue:hueFor(mostExpensive.team)},
    biggestJump && biggestJump.price > biggestJump.basePrice && {icon:'🚀', title:'Biggest Bidding Jump', winner:biggestJump.name,
      detail:`${(biggestJump.price / biggestJump.basePrice).toFixed(1).replace(/\.0$/,'')}× base — ${fmtMoney(biggestJump.basePrice)} → ${fmtMoney(biggestJump.price)}`, hue:hueFor(biggestJump.team)},
    bestBargain && {icon:'🏷️', title:'Best Bargain', winner:bestBargain.name,
      detail:`${bestBargain.team || '—'} got them for ${fmtMoney(bestBargain.price)} (base ${fmtMoney(bestBargain.basePrice)})`, hue:hueFor(bestBargain.team)},
    biggestSpender && {icon:'🔥', title:'Biggest Spender', winner:biggestSpender.name,
      detail:`${fmtMoney(spentOf(biggestSpender))} spent`, hue:hueFor(biggestSpender.name)},
    thriftiest && buyers.length > 1 && {icon:'🐷', title:'Thriftiest Team', winner:thriftiest.name,
      detail:`${fmtMoney(remainingOf(thriftiest))} still in the purse`, hue:hueFor(thriftiest.name)},
    biggestSquad && {icon:'👥', title:'Biggest Squad', winner:biggestSquad.name,
      detail:`${squadCountOf(biggestSquad)} player${squadCountOf(biggestSquad)===1?'':'s'} signed`, hue:hueFor(biggestSquad.name)},
  ].filter(Boolean);
}

function renderAwardsPanel(teamsArr){
  const awards = computeAwards(pv.sales, teamsArr);
  return `
  <section class="pv-panel pv-awards">
    <div class="pv-head">
      <h2 class="pv-head-title">🏆 Auction Awards</h2>
      <span class="pv-count">${awards.length}</span>
    </div>
    <p class="pv-muted">The standout moments of this auction.</p>
    ${awards.length === 0
      ? `<div class="pv-empty">No awards to hand out — nothing was sold at auction.</div>`
      : `<div class="row g-3">
          ${awards.map((a, i) => `
          <div class="col-12 col-sm-6 col-lg-4">
            <div class="pv-award h-100 ${a.hue}" style="animation-delay:${i * 90}ms;">
              <div class="pv-award-icon" aria-hidden="true">${a.icon}</div>
              <div class="pv-award-title">${a.title}</div>
              <div class="pv-award-winner">${escapeHtml(a.winner)}</div>
              <div class="pv-award-detail">${escapeHtml(a.detail)}</div>
            </div>
          </div>`).join('')}
        </div>`}
  </section>`;
}

/* ---------------- Panels ---------------- */

function pvBanner(tone, title, sub){
  return `
  <section class="pv-panel pv-banner ${tone}">
    <span class="pv-banner-rule"></span>
    <div class="pv-banner-txt">
      <div class="pv-banner-title">${title}</div>
      <div class="pv-banner-sub">${sub}</div>
    </div>
  </section>`;
}

function renderResultsPanel(heading, blurb){
  return `
  <section class="pv-panel">
    <div class="pv-head">
      <h2 class="pv-head-title">${heading}</h2>
      <span class="pv-count">${pv.sales.length}</span>
    </div>
    <p class="pv-muted">${blurb}</p>
    ${pv.sales.length===0
      ? `<div class="pv-empty">No players have gone under the hammer yet.</div>`
      : `<div class="table-responsive">
          <table class="table pv-table align-middle mb-0">
            <thead>
              <tr>
                <th>Player</th>
                <th class="d-none d-md-table-cell">Category</th>
                <th class="d-none d-lg-table-cell text-end">Base</th>
                <th class="d-none d-sm-table-cell">Result</th>
                <th class="d-none d-sm-table-cell">Sold to</th>
                <th class="text-end">Price</th>
                <th class="d-none d-lg-table-cell text-end">Time</th>
              </tr>
            </thead>
            <tbody>
              ${pv.sales.map(r=>`
              <tr>
                <td>
                  <div class="pv-player-cell">
                    <img class="pv-thumb" src="${escapeAttr(playerImageSrc(r))}" alt="" loading="lazy"
                         onerror="this.onerror=null;this.src='${DEFAULT_PLAYER_IMAGE}';">
                    <div>
                      <div class="pv-player-name">${r.name}</div>
                      <div class="pv-player-sub d-md-none">${r.category||''}</div>
                      <div class="pv-player-sub d-sm-none">
                        <span class="pv-pill ${r.result==='sold'?'sold':'unsold'}">${r.result==='sold'?(r.via==='assigned'?'Retained':'Sold'):'Unsold'}</span>
                        ${r.team ? `<span class="pv-sub-team">${r.team}</span>` : ''}
                      </div>
                    </div>
                  </div>
                </td>
                <td class="d-none d-md-table-cell">${r.category ? `<span class="pv-tag sm ${hueFor(r.category)}">${r.category}</span>` : '—'}</td>
                <td class="d-none d-lg-table-cell text-end pv-num pv-soft">${r.basePrice!=null ? fmtMoney(r.basePrice) : '—'}</td>
                <td class="d-none d-sm-table-cell"><span class="pv-pill ${r.result==='sold'?'sold':'unsold'}">${r.result==='sold'?(r.via==='assigned'?'Retained':'Sold'):'Unsold'}</span></td>
                <td class="d-none d-sm-table-cell">${r.team || '—'}</td>
                <td class="text-end ${r.result==='sold' && r.price!=null ? 'pv-price' : 'pv-dash'}">${r.result==='sold' && r.price!=null ? fmtMoney(r.price) : '—'}</td>
                <td class="d-none d-lg-table-cell text-end pv-num pv-soft">${fmtTime(r.time)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`}
  </section>`;
}

function renderTeamsPanel(teamsArr, heading){
  return `
  <section class="pv-panel">
    <div class="pv-head">
      <h2 class="pv-head-title">${heading}</h2>
      <span class="pv-count">${teamsArr.length}</span>
    </div>
    ${teamsArr.length===0
      ? `<div class="pv-empty">No teams yet.</div>`
      : teamTilesMarkup(teamsArr)}
  </section>`;
}

/* ============================================================
   TEMPORARY FEATURE — fireworks across the whole screen when a player is
   sold. Added 2026-09-27; not part of the permanent design.

   This feature is in FOUR places in this file — search for "TEMP FIREWORKS"
   / "TEMP_FIREWORKS" / "__fw" to find all of them:
     1. Two `let` declarations up near the top, right after `showPastResults`
        (they have to come before the `recentSales` listener that reads them).
     2. The one-line call to `maybeCelebrateNewSale(pv.sales)` inside the
        `recentSales` listener above.
     3. The `maybeCelebrateNewSale()` function itself, right after that
        listener.
     4. This block: the flag + the animation itself.
   Delete all four to remove the feature entirely; nothing else references it.
   (The `via:'assigned'` tag `saleRecord()` writes in shared.js, and that
   moderator.js's confirmAssignPlayer() passes, are NOT part of this — they
   stay regardless, since they're also how the results log itself tells a
   retained/assigned player apart from a real auction sale.)

   TO SWITCH IT OFF WITHOUT DELETING ANYTHING: set the flag below to false.
   ============================================================ */
const TEMP_FIREWORKS_ENABLED = true;

/**
 * A few staggered particle bursts across the top of the screen, drawn on a
 * throwaway full-viewport canvas that removes itself when the animation
 * ends. Self-contained: touches nothing but a canvas element it creates.
 *
 * `isRecord` (from maybeCelebrateNewSale's own isNewRecord() check) scales
 * this up — more bursts, more particles per burst — so a record-breaking
 * sale visibly reads as a BIGGER moment than a routine one, not just the
 * same animation with different takeover text. Part of "record sale gets
 * bigger than a normal sale", alongside screenShakeForRecord() below and
 * the takeover's own pre-existing `.is-record` treatment.
 */
function celebrateSaleFirework(isRecord){
  if(!TEMP_FIREWORKS_ENABLED) return;
  if(typeof window === 'undefined' || typeof document === 'undefined') return;
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const canvas = document.createElement('canvas');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  Object.assign(canvas.style, {
    position:'fixed', inset:'0', width:'100%', height:'100%',
    zIndex:'9999', pointerEvents:'none',
  });
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if(!ctx){ canvas.remove(); return; } // no 2D canvas support — fail silently, no error, no animation

  const COLORS = ['#FFD060','#FF9F0A','#5AC8FA','#0A84FF','#DA9BFF','#BF5AF2','#7FE3F2','#FF7A9A'];
  const GRAVITY = 0.05, DRAG = 0.985;
  let particles = [];

  function burst(x, y){
    const color = COLORS[Math.floor(Math.random()*COLORS.length)];
    const count = (isRecord ? 70 : 46) + Math.floor(Math.random()*(isRecord ? 26 : 18));
    for(let i=0; i<count; i++){
      const angle = (Math.PI*2*i)/count + Math.random()*0.3;
      const speed = 2.6 + Math.random()*3.4;
      particles.push({
        x, y, vx:Math.cos(angle)*speed, vy:Math.sin(angle)*speed,
        life:1, decay:0.011 + Math.random()*0.012, size:1.6 + Math.random()*1.8, color,
      });
    }
  }

  // Stop condition is "no more bursts queued and no particles left alive",
  // not a guessed wall-clock duration — a fixed-time guess drifts out of
  // sync with the actual particle decay, and (found while testing this)
  // doesn't advance the same way under every timing regime a browser can be
  // driven with. burstsRemaining only ever counts down; frameCap is purely a
  // defensive ceiling so a stray float-precision particle can't wedge the
  // loop open forever.
  const burstCount = (isRecord ? 7 : 4) + Math.floor(Math.random()*3);
  let burstsRemaining = burstCount;
  const burstTimers = [];
  for(let i=0; i<burstCount; i++){
    burstTimers.push(setTimeout(()=>{
      burst(canvas.width*(0.18 + Math.random()*0.64), canvas.height*(0.16 + Math.random()*0.32));
      burstsRemaining--;
    }, i*260));
  }

  let rafId = null;
  let frameCount = 0;
  const FRAME_CAP = 600; // ~10s at 60fps — safety net, not the normal exit
  function onResize(){ canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  window.addEventListener('resize', onResize);

  function cleanup(){
    if(rafId) cancelAnimationFrame(rafId);
    burstTimers.forEach(clearTimeout);
    window.removeEventListener('resize', onResize);
    canvas.remove();
  }

  function frame(){
    frameCount++;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p=>{
      p.vy += GRAVITY; p.vx *= DRAG; p.vy *= DRAG;
      p.x += p.vx; p.y += p.vy; p.life -= p.decay;
    });
    particles = particles.filter(p=>p.life > 0);
    particles.forEach(p=>{
      ctx.globalAlpha = Math.max(p.life, 0);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI*2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;

    if((burstsRemaining > 0 || particles.length) && frameCount < FRAME_CAP){
      rafId = requestAnimationFrame(frame);
    } else {
      cleanup();
    }
  }
  rafId = requestAnimationFrame(frame);
}
/* ============ END temporary fireworks feature ============ */

/** A brief screen-shake for a record-breaking sale only (maybeCelebrateNewSale,
 *  gated on isNewRecord()) — NOT part of the temporary fireworks feature above
 *  and not removed alongside it; it's the other half of "record sale gets
 *  bigger than a normal sale", independent of whether TEMP_FIREWORKS_ENABLED
 *  is on. Adds a short CSS animation class to <body> and removes it once the
 *  animation is done; respects prefers-reduced-motion like everything else
 *  here. */
function screenShakeForRecord(){
  if(typeof document === 'undefined' || !document.body || !document.body.classList) return; // the test stub's <body> has no classList
  if(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.body.classList.add('pv-shake');
  setTimeout(()=>{ document.body.classList.remove('pv-shake'); }, 650);
}

/* ============================================================
   The sheet. Injected from here so index.html and
   css/styles.css stay untouched, and this redesign reverts
   cleanly by restoring js/public.classic.js.
   ============================================================ */
function pvCss(){ return `

/* Tokens, the orb backdrop and the floating header all live in css/theme.css
   now, shared with admin/moderator/team. Bootstrap loads after that file on
   this page, so its reboot is re-asserted here for the few header elements it
   would otherwise reclaim. */
header.top .brand h1{font-size:17px; font-weight:650; letter-spacing:-.2px; text-transform:none; margin:0; color:#fff;}
header.top .brand h1 span{
  background:linear-gradient(180deg,var(--pv-orange-l),var(--pv-orange));
  -webkit-background-clip:text; background-clip:text; color:transparent; font-weight:650;
}
header.top .top-actions button.ghost{
  background:rgba(255,255,255,.10); border:1px solid rgba(255,255,255,.18);
  color:#fff; border-radius:999px; padding:7px 15px; font-size:12.5px; font-weight:550;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.22);
}
header.top .top-actions button.ghost:hover{background:rgba(255,255,255,.2);}
main{max-width:none; margin:22px auto 80px; padding:0;}

/* ---- the material, for this page's own pv-* surfaces ---- */
.pv-panel{
  position:relative; isolation:isolate;
  background:var(--pv-mat);
  -webkit-backdrop-filter:var(--pv-blur);
  backdrop-filter:var(--pv-blur);
  border:none; border-radius:var(--pv-r);
  padding:26px;
  margin-bottom:18px;
  box-shadow:
    inset 0 -24px 48px -36px rgba(255,255,255,.22),
    0 2px 6px -2px rgba(0,0,0,.5),
    0 26px 60px -26px rgba(0,0,0,.85);
}
.pv-panel::before{
  content:''; position:absolute; inset:0; z-index:-1;
  border-radius:inherit; padding:1px; pointer-events:none;
  background:linear-gradient(145deg,
    rgba(255,255,255,.72) 0%,
    rgba(255,255,255,.10) 26%,
    rgba(255,255,255,.04) 58%,
    rgba(255,255,255,.42) 100%);
  -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;
          mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
          mask-composite:exclude;
}
.pv-panel::after{
  content:''; position:absolute; inset:0; z-index:-1;
  border-radius:inherit; pointer-events:none;
  background:
    radial-gradient(130% 78% at 14% -16%, rgba(255,255,255,.20), transparent 56%),
    radial-gradient(80% 50% at 92% 108%, rgba(255,255,255,.07), transparent 60%);
}
@media(max-width:575.98px){ .pv-panel{padding:20px;} }

/* ---- layout scope ---- */
.pv-scope{
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  color:var(--pv-ink); max-width:1180px;
}
.pv-scope *{box-sizing:border-box;}

/* css/styles.css has its own, unrelated .row helper:
     .row{display:flex; gap:10px; align-items:end; flex-wrap:wrap;}
   Bootstrap's grid uses padding gutters and never sets gap or align-items, so
   those two declarations leak straight through and break it - the 10px gap
   pushes a 12-column row past 100% and every row wraps. Neutralise them here
   (this sheet is injected after Bootstrap, so it wins); Bootstrap's own
   align-items-* utilities are !important and still apply on top. */
.pv-scope .row{gap:0; align-items:initial;}

/* ---- panel headings ---- */
.pv-head{display:flex; align-items:center; gap:9px; margin-bottom:5px;}
.pv-head-title{font-size:17px; font-weight:640; letter-spacing:-.25px; margin:0; color:#fff;}
.pv-count{
  font-size:11.5px; font-weight:620; color:var(--pv-ink-2); padding:2px 9px; border-radius:999px;
  background:rgba(255,255,255,.10); box-shadow:inset 0 1px 0 rgba(255,255,255,.18);
  font-variant-numeric:tabular-nums;
}
.pv-muted{font-size:13px; color:var(--pv-ink-3); line-height:1.55; margin:0 0 20px;}
.pv-soft{color:var(--pv-ink-2);}
.pv-num{font-variant-numeric:tabular-nums;}

/* ---- status banners ---- */
.pv-banner{display:flex; align-items:stretch; gap:16px; padding:22px 24px;}
.pv-banner-rule{width:3px; border-radius:999px; flex-shrink:0; background:var(--pv-ink-3);}
.pv-banner-txt{flex:1; min-width:0;}
.pv-banner-title{font-size:16px; font-weight:650; letter-spacing:-.2px; margin-bottom:3px; color:#fff;}
.pv-banner-sub{font-size:13.5px; color:var(--pv-ink-2); line-height:1.55;}
.pv-banner.good .pv-banner-rule{background:var(--pv-green); box-shadow:0 0 18px rgba(48,209,88,.8);}
.pv-banner.good .pv-banner-title{color:var(--pv-green-l);}
.pv-banner.warn .pv-banner-rule{background:var(--pv-orange); box-shadow:0 0 18px rgba(255,159,10,.8);}
.pv-banner.warn .pv-banner-title{color:var(--pv-orange-l);}

/* ---- between lots / standing by ---- */
.pv-next{padding:46px 30px; text-align:center;}
.pv-next-eyebrow{
  display:inline-flex; align-items:center; gap:7px;
  font-size:11px; font-weight:640; letter-spacing:1.2px; text-transform:uppercase;
  color:var(--pv-ink-3); margin-bottom:10px;
}
.pv-next-title{font-size:23px; font-weight:650; letter-spacing:-.5px; margin:0 0 6px; color:#fff;}
.pv-next-sub{font-size:14px; color:var(--pv-ink-2); line-height:1.55; margin:0;}
.pv-pulse{
  width:7px; height:7px; border-radius:50%; background:var(--pv-orange);
  box-shadow:0 0 12px rgba(255,159,10,.95); animation:pvPing 1.5s ease-in-out infinite;
}

/* ---- bidding war ---- */
.pv-war-tag{
  display:inline-flex; align-items:center; gap:6px;
  margin-bottom:14px; padding:6px 14px; border-radius:999px;
  font-size:12px; font-weight:680; letter-spacing:.2px; color:#FFD3A3;
  background:rgba(255,105,26,.20);
  box-shadow:inset 0 0 0 1px rgba(255,159,10,.5), 0 0 22px -8px rgba(255,105,26,.9);
  animation:pvWarPulse 1.1s ease-in-out infinite;
}
.pv-war-flame{animation:pvWarFlame 1.1s ease-in-out infinite;}
@keyframes pvWarPulse{0%,100%{box-shadow:inset 0 0 0 1px rgba(255,159,10,.5), 0 0 22px -8px rgba(255,105,26,.9);} 50%{box-shadow:inset 0 0 0 1px rgba(255,159,10,.8), 0 0 30px -6px rgba(255,105,26,1);}}
@keyframes pvWarFlame{0%,100%{transform:scale(1) rotate(0deg);} 50%{transform:scale(1.18) rotate(-6deg);}}

/* ---- player reveal ----
   A one-shot animation when a genuinely new player comes on the block —
   __justRevealed (public.js) is true for exactly one render, so this class
   only ever appears on the FIRST render of a given lot, never on later
   re-renders of the same one (a bid landing must not replay it). Scoped to
   this page's own sheet rather than theme.css even though .pv-lot itself is
   theme.css's: this modifier class is only ever added by this file, so
   defining it elsewhere would be dead weight on moderator.html/team.html
   (which never set it) — see CLAUDE.md §5 on why public-only behaviour
   lives in this injected sheet, not the shared one. Loads after theme.css,
   so it wins the cascade for this one modifier without needing !important.

   Theatrical version: the whole panel gets a brief gold flash-ring, the
   photo brightens/blurs in rather than just fading, and a diagonal light
   sweep crosses it once (a ::after pseudo-element, so no extra markup) —
   like a spotlight finding the player, not just an opacity fade. The text
   stagger (name, then meta+bid) is unchanged. */
.pv-lot.is-revealing{animation:pvRevealFlash .6s ease-out both;}
.pv-lot.is-revealing .pv-photo-frame{position:relative; overflow:hidden; animation:pvRevealPhoto .8s cubic-bezier(.2,.8,.3,1) both;}
.pv-lot.is-revealing .pv-photo-frame::after{
  content:''; position:absolute; inset:0; z-index:1; pointer-events:none;
  background:linear-gradient(115deg, transparent 32%, rgba(255,255,255,.65) 48%, transparent 64%);
  transform:translateX(-140%);
  animation:pvRevealSweep .9s cubic-bezier(.3,.7,.2,1) .1s both;
}
.pv-lot.is-revealing .pv-name{animation:pvRevealText .5s ease-out .15s both;}
.pv-lot.is-revealing .pv-meta,
.pv-lot.is-revealing .pv-bidblock{animation:pvRevealText .5s ease-out .28s both;}
@keyframes pvRevealFlash{
  0%{box-shadow:inset 0 0 0 2px rgba(228,174,73,0), 0 0 0 rgba(228,174,73,0);}
  22%{box-shadow:inset 0 0 0 2px rgba(228,174,73,.85), 0 0 70px -12px rgba(228,174,73,.85);}
  100%{box-shadow:inset 0 0 0 2px rgba(228,174,73,0), 0 0 0 rgba(228,174,73,0);}
}
@keyframes pvRevealPhoto{
  0%{opacity:0; transform:scale(.82); filter:blur(18px) brightness(1.7);}
  55%{opacity:1; filter:blur(0) brightness(1.2);}
  100%{opacity:1; transform:scale(1); filter:blur(0) brightness(1);}
}
@keyframes pvRevealSweep{
  0%{transform:translateX(-140%); opacity:0;}
  15%{opacity:1;}
  60%{opacity:1;}
  100%{transform:translateX(140%); opacity:0;}
}
@keyframes pvRevealText{
  from{opacity:0; transform:translateY(10px);}
  to{opacity:1; transform:translateY(0);}
}
@media(prefers-reduced-motion:reduce){
  .pv-war-tag, .pv-war-flame{animation:none;}
  .pv-lot.is-revealing{animation:none;}
  .pv-lot.is-revealing .pv-photo-frame, .pv-lot.is-revealing .pv-name,
  .pv-lot.is-revealing .pv-meta, .pv-lot.is-revealing .pv-bidblock{animation:none;}
  .pv-lot.is-revealing .pv-photo-frame::after{display:none;}
}

/* ---- leader-color stage wash ----
   injectStageWash()/updateStageWash() (above, this file) manage #pvStageWash
   — a full-viewport tint behind everything, coloured to whichever team is
   currently leading (hueFor(leader.name), same hashing as their team card).
   z-index:-1 puts it behind theme.css's header (z-index:50) and this page's
   own static #tabContent/main content (ordinary, non-positioned flow sits
   above a negative-z-index sibling in CSS's stacking order) — it only shows
   through the gaps around and between panels, and faintly through their
   semi-opaque backgrounds, as a mood wash rather than a hard color block.
   pointer-events:none so it can never intercept a tap.

   ONE radial gradient, same as the original — sized larger than the
   65% 55% it started at, then dialed back down once by request ("30% less
   area" than the 180% 150% it briefly reached): area scales with the
   PRODUCT of the two ellipse dimensions, so shrinking both by the same
   linear factor of sqrt(0.7)≈0.837 shrinks the area by 30% — 180%→150%,
   150%→125%. Falloff stays at 88% (a softer, further-out fade than the
   original 70%) and the animation itself is unchanged (same pvWashPulse
   keyframe, same opacity levels) — only the gradient's size has moved,
   twice now. If asked to resize this again, keep it ONE gradient and scale
   both numbers by the same factor — don't reintroduce the two-gradient
   (top+bottom) version tried in an earlier revision. */
#pvStageWash{
  position:fixed; inset:0; z-index:-1; pointer-events:none;
  opacity:0; transition:opacity .6s ease;
  background:radial-gradient(150% 125% at 50% 0%, var(--pv-wash, transparent), transparent 88%);
}
#pvStageWash.is-active{opacity:.5;}
#pvStageWash.is-war{opacity:.8; animation:pvWashPulse 1.1s ease-in-out infinite;}
#pvStageWash.hue-blue  {--pv-wash: rgba(59,130,246,.9);}
#pvStageWash.hue-green {--pv-wash: rgba(48,209,88,.9);}
#pvStageWash.hue-purple{--pv-wash: rgba(139,92,246,.9);}
#pvStageWash.hue-orange{--pv-wash: rgba(228,174,73,.9);}
#pvStageWash.hue-pink  {--pv-wash: rgba(251,90,107,.9);}
#pvStageWash.hue-teal  {--pv-wash: rgba(20,184,166,.9);}
@keyframes pvWashPulse{0%,100%{opacity:.5;} 50%{opacity:.85;}}
@media(prefers-reduced-motion:reduce){
  #pvStageWash{transition:none;}
  #pvStageWash.is-war{animation:none;}
}

/* ---- leader capsule, tinted to the leading team's own color ----
   lotMarkup() (shared.js) adds hueFor(leader.name) to the capsule
   unconditionally; theme.css keeps the original fixed green as the base
   look for moderator.js/team.js, and this page's sheet is the only one
   that overrides per hue — so "Leading Lions" reads in Lions' own blue
   here, matching the same team's dot/tile colour in the Teams panel below,
   while moderator.js/team.js keep the plain green. hue-green needs no rule
   of its own: it's already theme.css's default. */
.pv-leader.is-leading.hue-blue{background:rgba(59,130,246,.16); box-shadow:inset 0 0 0 1px rgba(59,130,246,.4);}
.pv-leader.is-leading.hue-blue .pv-leader-dot{background:var(--pv-blue); box-shadow:0 0 12px rgba(59,130,246,.9);}
.pv-leader.is-leading.hue-blue .pv-leader-name{color:var(--pv-blue-l);}
.pv-leader.is-leading.hue-blue .pv-leader-label{color:rgba(127,176,255,.85);}

.pv-leader.is-leading.hue-purple{background:rgba(139,92,246,.16); box-shadow:inset 0 0 0 1px rgba(139,92,246,.4);}
.pv-leader.is-leading.hue-purple .pv-leader-dot{background:var(--pv-purple); box-shadow:0 0 12px rgba(139,92,246,.9);}
.pv-leader.is-leading.hue-purple .pv-leader-name{color:var(--pv-purple-l);}
.pv-leader.is-leading.hue-purple .pv-leader-label{color:rgba(184,162,255,.85);}

.pv-leader.is-leading.hue-orange{background:rgba(228,174,73,.16); box-shadow:inset 0 0 0 1px rgba(228,174,73,.4);}
.pv-leader.is-leading.hue-orange .pv-leader-dot{background:var(--pv-orange); box-shadow:0 0 12px rgba(228,174,73,.9);}
.pv-leader.is-leading.hue-orange .pv-leader-name{color:var(--pv-orange-l);}
.pv-leader.is-leading.hue-orange .pv-leader-label{color:rgba(243,205,132,.85);}

.pv-leader.is-leading.hue-pink{background:rgba(251,90,107,.16); box-shadow:inset 0 0 0 1px rgba(251,90,107,.4);}
.pv-leader.is-leading.hue-pink .pv-leader-dot{background:var(--pv-pink); box-shadow:0 0 12px rgba(251,90,107,.9);}
.pv-leader.is-leading.hue-pink .pv-leader-name{color:var(--pv-pink-l);}
.pv-leader.is-leading.hue-pink .pv-leader-label{color:rgba(255,151,160,.85);}

.pv-leader.is-leading.hue-teal{background:rgba(20,184,166,.16); box-shadow:inset 0 0 0 1px rgba(20,184,166,.4);}
.pv-leader.is-leading.hue-teal .pv-leader-dot{background:var(--pv-teal); box-shadow:0 0 12px rgba(20,184,166,.9);}
.pv-leader.is-leading.hue-teal .pv-leader-name{color:var(--pv-teal-l);}
.pv-leader.is-leading.hue-teal .pv-leader-label{color:rgba(94,234,212,.85);}

/* ---- record-sale screen shake ----
   screenShakeForRecord() (above, this file) adds/removes this on <body> —
   the other half of "record sale gets bigger than a normal sale", alongside
   the bigger firework burst in celebrateSaleFirework(isRecord) and the
   takeover's own pre-existing .is-record treatment. Not scoped under
   .pv-scope since it targets <body> itself. */
@keyframes pvShake{
  0%,100%{transform:translate(0,0);}
  20%{transform:translate(-8px,2px) rotate(-.3deg);}
  40%{transform:translate(7px,-3px) rotate(.3deg);}
  60%{transform:translate(-6px,3px) rotate(-.2deg);}
  80%{transform:translate(5px,-2px) rotate(.2deg);}
}
body.pv-shake{animation:pvShake .55s cubic-bezier(.36,.07,.19,.97) both;}
@media(prefers-reduced-motion:reduce){ body.pv-shake{animation:none;} }

/* ---- home screen ---- */
.pv-hero{padding:76px 30px; text-align:center;}
@media(max-width:575.98px){ .pv-hero{padding:56px 22px;} }
.pv-hero-mark{
  width:58px; height:58px; margin:0 auto 20px; border-radius:16px;
  display:flex; align-items:center; justify-content:center;
  font-size:27px; font-weight:750; color:#1A1000;
  background:linear-gradient(140deg,var(--pv-orange-l),var(--pv-orange));
  box-shadow:0 18px 40px -14px rgba(255,159,10,.85), inset 0 1px 0 rgba(255,255,255,.6);
}
.pv-hero-title{font-size:clamp(27px,3.8vw,36px); font-weight:670; letter-spacing:-1px; margin:0 0 8px; color:#fff;}
.pv-hero-sub{font-size:14.5px; color:var(--pv-ink-2); line-height:1.6; max-width:410px; margin:0 auto 30px;}
.pv-hero-none{font-size:13.5px; color:var(--pv-ink-3); margin:0;}
.pv-hero-stats{display:flex; align-items:center; justify-content:center; gap:34px; flex-wrap:wrap; margin-bottom:30px;}
.pv-stat-div{width:1px; align-self:stretch; background:rgba(255,255,255,.16);}
.pv-stat-val{
  font-size:30px; font-weight:680; letter-spacing:-1.1px; line-height:1;
  font-variant-numeric:tabular-nums;
  background:linear-gradient(180deg,#FFF0CE,var(--pv-orange));
  -webkit-background-clip:text; background-clip:text; color:transparent;
}
.pv-stat-val .pv-unit{font-size:15px; font-weight:580; margin-left:4px; letter-spacing:0;}
.pv-stat-lbl{font-size:12px; color:var(--pv-ink-3); margin-top:7px;}

/* a capsule of clear glass over vivid blue */
.pv-btn{
  display:inline-block; cursor:pointer; position:relative;
  padding:13px 26px; border-radius:999px;
  font-size:14.5px; font-weight:620; letter-spacing:-.1px; color:#fff;
  background:linear-gradient(180deg, rgba(90,200,250,.95), rgba(10,132,255,.95));
  border:1px solid rgba(255,255,255,.28);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.55),
    inset 0 -8px 18px -12px rgba(0,0,0,.5),
    0 14px 32px -12px rgba(10,132,255,.85);
  transition:transform .18s ease, box-shadow .18s ease, filter .18s ease;
}
.pv-btn:hover{transform:translateY(-2px); filter:brightness(1.07); box-shadow:inset 0 1px 0 rgba(255,255,255,.55), 0 20px 38px -12px rgba(10,132,255,.95);}
.pv-btn:active{transform:translateY(0);}
.pv-hero-actions{display:flex; gap:12px; justify-content:center; flex-wrap:wrap;}
.pv-btn-gold{
  color:#1A1000;
  background:linear-gradient(180deg, var(--pv-orange-l), var(--pv-orange));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.55), inset 0 -8px 18px -12px rgba(0,0,0,.4), 0 14px 32px -12px rgba(228,174,73,.85);
}
.pv-btn-gold:hover{box-shadow:inset 0 1px 0 rgba(255,255,255,.55), 0 20px 38px -12px rgba(228,174,73,.95);}

/* ---- end-of-auction awards ----
   renderAwardsPanel()/computeAwards() (above, this file). Each card picks
   up its winner's team hue (hueFor), same colour that team has in the
   Teams panel, as a top accent bar + icon glow. Cards rise in one after
   another (animation-delay set inline per card). */
.pv-award{
  position:relative; overflow:hidden; text-align:center;
  padding:24px 18px 20px; border-radius:var(--pv-r-in);
  background:linear-gradient(160deg, rgba(255,255,255,.10), rgba(255,255,255,.03));
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);
  --pv-award: var(--pv-orange);
  animation:pvAwardIn .5s cubic-bezier(.2,.8,.3,1) both;
}
.pv-award::before{content:''; position:absolute; left:0; right:0; top:0; height:3px; background:var(--pv-award);}
.pv-award.hue-blue  {--pv-award:var(--pv-blue);}
.pv-award.hue-green {--pv-award:var(--pv-green);}
.pv-award.hue-purple{--pv-award:var(--pv-purple);}
.pv-award.hue-orange{--pv-award:var(--pv-orange);}
.pv-award.hue-pink  {--pv-award:var(--pv-pink);}
.pv-award.hue-teal  {--pv-award:var(--pv-teal);}
.pv-award-icon{font-size:38px; line-height:1; margin-bottom:12px; filter:drop-shadow(0 6px 14px rgba(0,0,0,.5));}
.pv-award-title{
  font-size:11px; font-weight:680; letter-spacing:1.3px; text-transform:uppercase;
  color:var(--pv-ink-3); margin-bottom:8px;
}
.pv-award-winner{
  font-family:var(--font-display); text-transform:uppercase;
  font-size:clamp(22px,2.6vw,28px); font-weight:700; letter-spacing:-.2px; line-height:1.1;
  color:#fff; margin-bottom:6px; overflow-wrap:anywhere;
}
.pv-award-detail{font-size:13px; color:var(--pv-ink-2); line-height:1.45;}
@keyframes pvAwardIn{from{opacity:0; transform:translateY(14px) scale(.97);} to{opacity:1; transform:none;}}
@media(prefers-reduced-motion:reduce){ .pv-award{animation:none;} }

/* ---- sold takeover ----
   Fixed over everything except the fireworks canvas (z-index 9999), so the
   bursts land on top of the card. Counts down 5 → 0 (tickSoldTakeover), then
   fades out; tap or Escape closes it early. */
.pv-takeover{
  position:fixed; inset:0; z-index:9000; cursor:pointer;
  display:flex; align-items:center; justify-content:center; padding:24px;
  background:
    radial-gradient(60% 55% at 50% 38%, rgba(228,174,73,.18), transparent 70%),
    rgba(4,7,12,.92);
  -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px);
  animation:pvTakeoverIn .25s ease-out both;
}
.pv-takeover-card{width:100%; max-width:600px; text-align:center;}
.pv-takeover-stamp{
  font-family:var(--font-display); text-transform:uppercase;
  font-size:clamp(76px,17vw,160px); font-weight:700; line-height:.85; letter-spacing:6px;
  margin:0 0 26px; color:var(--pv-orange-l);
  transform:rotate(-4deg);
  animation:pvStamp .42s cubic-bezier(.2,1.35,.4,1) both;
}
/* "New Record!" is a much longer stamp than "Sold" — the huge clamp + wide
   tracking tuned for one short word would overflow the 600px card, so this
   variant gets its own smaller scale rather than reusing .pv-takeover-stamp's
   sizing outright. A richer, wider background glow on the overlay itself
   (not just the card) makes the whole screen feel like a bigger moment. */
.pv-takeover.is-record{
  background:
    radial-gradient(70% 62% at 50% 36%, rgba(228,174,73,.32), transparent 72%),
    rgba(4,7,12,.92);
}
.pv-takeover-card.is-record .pv-takeover-stamp{
  font-size:clamp(34px,7.2vw,68px); letter-spacing:2px; line-height:1.05;
  background:linear-gradient(180deg,#FFF3D6 10%,var(--pv-orange-l) 55%,var(--pv-orange));
  -webkit-background-clip:text; background-clip:text; color:transparent;
  filter:drop-shadow(0 0 36px rgba(228,174,73,.6));
}
.pv-takeover-photo{
  display:block; width:168px; height:168px; margin:0 auto 24px;
  object-fit:cover; object-position:center top;
  border-radius:20px; background:#0B0E16;
  box-shadow:0 0 0 2px rgba(228,174,73,.55), 0 26px 60px -20px rgba(0,0,0,.85);
}
.pv-takeover-name{
  font-family:var(--font-display); text-transform:uppercase;
  font-size:clamp(32px,5.4vw,56px); font-weight:700; letter-spacing:-.5px; line-height:1;
  color:#fff; margin-bottom:10px; overflow-wrap:anywhere;
}
.pv-takeover-to{font-size:clamp(16px,2.2vw,21px); color:var(--pv-ink-2);}
.pv-takeover-to strong{color:var(--pv-green-l); font-weight:700;}
.pv-takeover .pv-bid.pv-takeover-price{justify-content:center; margin:16px 0 0;}
.pv-takeover-hint{margin-top:30px; font-size:11.5px; color:var(--pv-ink-3);}
/* the countdown: a ring that drains over the same 5s the digit counts, pinned
   to the top-right of the SCREEN (the overlay is fixed, so this is the screen
   corner, not the card's) */
.pv-takeover-timer{
  position:absolute; top:22px; right:22px; width:64px; height:64px;
  display:flex; align-items:center; justify-content:center;
}
.pv-takeover-ring{position:absolute; inset:0; width:100%; height:100%; transform:rotate(-90deg);}
.pv-takeover-ring circle{fill:none; stroke-width:4; stroke-linecap:round;}
.pv-takeover-ring-bg{stroke:rgba(255,255,255,.14);}
.pv-takeover-ring-fg{
  stroke:var(--pv-orange-l);
  stroke-dasharray:150.8; stroke-dashoffset:0;   /* 2 * pi * r, r = 24 */
  animation:pvCountdown 5s linear forwards;      /* duration is set inline from TAKEOVER_SECONDS */
}
.pv-takeover-count{
  position:relative; font-family:var(--font-display); font-size:28px; font-weight:700;
  line-height:1; color:#fff; font-variant-numeric:tabular-nums;
}
.pv-takeover.is-leaving{animation:pvTakeoverOut .3s ease-in both; pointer-events:none;}
@keyframes pvTakeoverIn{from{opacity:0;} to{opacity:1;}}
@keyframes pvTakeoverOut{from{opacity:1;} to{opacity:0;}}
@keyframes pvCountdown{to{stroke-dashoffset:150.8;}}
@keyframes pvStamp{
  from{opacity:0; transform:scale(1.7) rotate(-9deg);}
  to{opacity:1; transform:scale(1) rotate(-4deg);}
}
@media(max-width:575.98px){
  .pv-takeover-photo{width:132px; height:132px; margin-bottom:20px;}
  .pv-takeover-stamp{margin-bottom:20px;}
  .pv-takeover-timer{top:14px; right:14px; width:52px; height:52px;}
  .pv-takeover-count{font-size:23px;}
}
/* Reduced motion: no slam, no fades, and the ring steps once a second instead
   of sweeping smoothly. The countdown still works — the digit is what carries
   it and the ring still shows how much is left — it just doesn't glide. */
@media(prefers-reduced-motion:reduce){
  .pv-takeover, .pv-takeover-stamp, .pv-takeover.is-leaving{animation:none;}
  .pv-takeover-ring-fg{animation-timing-function:steps(var(--pv-take-steps,5),end);}
}

/* ---- results table ---- */
.pv-table{--bs-table-bg:transparent; --bs-table-color:#F4F7FD; color:var(--pv-ink); margin:0;}
.pv-table > :not(caption) > * > *{background:transparent; box-shadow:none; padding:12px 12px;}
.pv-table thead th{
  font-size:11px; font-weight:620; letter-spacing:.3px; text-transform:none;
  color:var(--pv-ink-3); border-bottom:1px solid rgba(255,255,255,.14); white-space:nowrap; padding-bottom:9px;
}
.pv-table tbody td{border-bottom:1px solid rgba(255,255,255,.07); font-size:13.5px; vertical-align:middle;}
.pv-table tbody tr:last-child td{border-bottom:none;}
.pv-table tbody tr{transition:background .16s ease;}
.pv-table tbody tr:hover td{background:rgba(255,255,255,.05);}
.pv-player-cell{display:flex; align-items:center; gap:11px;}
.pv-thumb{
  width:38px; height:38px; border-radius:11px; object-fit:cover; object-position:center top;
  flex-shrink:0; background:#0B0E16; box-shadow:inset 0 0 0 1px rgba(255,255,255,.18);
}
.pv-player-name{font-weight:600; letter-spacing:-.1px; color:#fff;}
.pv-player-sub{font-size:11.5px; color:var(--pv-ink-3); margin-top:2px;}
.pv-player-sub .pv-pill{padding:1px 8px; font-size:10px;}
.pv-sub-team{margin-left:6px;}
.pv-price{font-weight:660; font-variant-numeric:tabular-nums; white-space:nowrap; color:var(--pv-orange-l);}
.pv-dash{color:var(--pv-ink-3);}
.pv-pill{
  display:inline-block; padding:3px 11px; border-radius:999px;
  font-size:11.5px; font-weight:620; white-space:nowrap;
}
.pv-pill.sold{
  background:rgba(48,209,88,.20); color:#8BF0AC;
  box-shadow:inset 0 0 0 1px rgba(110,231,160,.36), 0 0 16px -7px rgba(48,209,88,.95);
}
.pv-pill.unsold{
  background:rgba(255,69,58,.18); color:#FFA79F;
  box-shadow:inset 0 0 0 1px rgba(255,105,97,.34), 0 0 16px -7px rgba(255,69,58,.9);
}
@media(max-width:575.98px){
  .pv-table > :not(caption) > * > *{padding:11px 4px;}
  .pv-thumb{width:34px; height:34px; border-radius:10px;}
  .pv-player-name{font-size:13px;}
}


/* ---- empty states ---- */
.pv-empty{text-align:center; padding:40px 20px; color:var(--pv-ink-3); font-size:13.5px;}

/* ---- if the Bootstrap CDN is unreachable, lay the page out unaided ---- */
.pv-no-bs .pv-scope .row{display:flex; flex-wrap:wrap; gap:22px 0; align-items:center; margin:0;}
.pv-no-bs .pv-scope .row > *{flex:0 0 auto; width:100%; padding:0;}
.pv-no-bs .pv-scope .table-responsive{overflow-x:auto; -webkit-overflow-scrolling:touch;}
.pv-no-bs .pv-scope .text-end{text-align:right;}
.pv-no-bs .pv-scope .text-center{text-align:center;}
.pv-no-bs .pv-scope .justify-content-center{justify-content:center;}
.pv-no-bs .pv-scope .d-none{display:none;}
.pv-no-bs .pv-scope .mb-0{margin-bottom:0;}
@media(min-width:576px){
  .pv-no-bs .pv-scope .row.g-3 > *{width:50%; padding:0 6px;}
  .pv-no-bs .pv-scope .d-sm-table-cell{display:table-cell;}
}
@media(min-width:768px){ .pv-no-bs .pv-scope .d-md-table-cell{display:table-cell;} }
@media(min-width:992px){
  /* the lot itself needs nothing here — it uses its own grid in theme.css */
  .pv-no-bs .pv-scope .d-lg-table-cell{display:table-cell;}
}
@media(min-width:1200px){ .pv-no-bs .pv-scope .row.g-3 > *{width:33.333%;} }

/* ---- spectator reactions ----
   #pvReactionBar is injected once at load (injectReactionBar()) and lives
   outside .pv-scope/#tabContent entirely, fixed to the viewport, so it
   survives every renderPublic() re-render untouched. #pvReactionLayer is
   created lazily on the first tap. */
#pvReactionBar{
  /* bottom-RIGHT corner, not centered — and NOT at the same 16px/16px spot
     as #toastRoot (theme.css), which this page genuinely uses (the sound
     enable/error toasts). bottom:88px clears a single toast's height plus
     breathing room so the two never overlap; see the mobile override below
     for why that number changes when #toastRoot becomes a full-width band. */
  position:fixed; right:18px; bottom:88px; z-index:200;
  padding:8px; border-radius:999px;
  background:rgba(10,13,20,.72);
  -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.14), 0 18px 40px -16px rgba(0,0,0,.85);
}
/* the actual stack: #pvReactionBar's only child is this wrapper
   (reactionBarMarkup()), not the buttons directly — the layout has to live
   here, not on #pvReactionBar, since a flex container only arranges its
   OWN direct children. Deliberately column (buttons stacked vertically),
   by request. */
.pv-reactions{display:flex; flex-direction:column; gap:8px;}
.pv-reaction-btn{
  width:42px; height:42px; border-radius:50%; padding:0;
  display:flex; align-items:center; justify-content:center;
  font-size:19px; line-height:1; cursor:pointer;
  background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.14);
  transition:transform .15s ease, background .15s ease;
}
.pv-reaction-btn:hover{background:rgba(255,255,255,.14);}
.pv-reaction-btn:active{transform:scale(.88);}
#pvReactionLayer{position:fixed; inset:0; z-index:150; overflow:hidden; pointer-events:none;}
.pv-reaction-particle{
  position:absolute; bottom:70px; font-size:30px; line-height:1;
  animation:pvReactionRise 2.6s ease-out forwards;
}
@keyframes pvReactionRise{
  0%{opacity:0; transform:translate(0,0) scale(.6);}
  12%{opacity:1; transform:translate(0,-6vh) scale(1);}
  100%{opacity:0; transform:translate(var(--pv-drift,0),-62vh) scale(1);}
}
@media(max-width:575.98px){
  /* #toastRoot also becomes a full-width band here (left:12px; right:12px;
     bottom:12px; theme.css), not just a bottom-right corner box — still
     needs clearance above it, just a little less since the bar itself is
     smaller on this breakpoint too. right:12px matches that band's own
     inset so the corner still lines up. */
  #pvReactionBar{right:12px; bottom:78px; gap:6px; padding:6px;}
  .pv-reaction-btn{width:38px; height:38px; font-size:17px;}
}
@media(prefers-reduced-motion:reduce){
  .pv-reaction-particle{animation:pvReactionFade 1.4s ease-out forwards;}
}
@keyframes pvReactionFade{ from{opacity:1;} to{opacity:0;} }

/* ---- no backdrop-filter: fall back to an opaque tint, keep the rim ---- */
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
  .pv-panel{background:rgba(20,24,38,.94);}
  header.top{background:rgba(14,18,30,.97);}
}
@media(prefers-reduced-motion:reduce){
  .pv-live-dot, .pv-pulse{animation:none;}
  .pv-team:hover, .pv-btn:hover{transform:none;}
}
`; }
