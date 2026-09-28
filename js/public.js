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

/* ---------------- State ---------------- */

let pv = { settings:{currencyUnit:'Cr'}, teams:{}, players:{}, auction:{}, sales:[] };

// Once bidding is complete the page falls back to a home screen; the previous
// results stay one click away rather than on show.
let showPastResults = false;
function togglePastResults(){ showPastResults = !showPastResults; renderPublic(); }

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

watchConnection('connBadge');

db.ref('settings').on('value', s=>{ pv.settings = s.val() || pv.settings; window.__settingsCache = pv.settings; renderPublic(); });
db.ref('teams').on('value', s=>{ pv.teams = s.val() || {}; renderPublic(); });
db.ref('squads').on('value', s=>{
  const squads = s.val() || {};
  Object.keys(pv.teams).forEach(id=>{ pv.teams[id] = pv.teams[id] || {}; pv.teams[id].squad = squads[id] || {}; });
  renderPublic();
});
db.ref('players').on('value', s=>{ pv.players = s.val() || {}; renderPublic(); });
db.ref('auction').on('value', s=>{ pv.auction = s.val() || {}; renderPublic(); });
db.ref('recentSales').on('value', s=>{
  pv.sales = salesArray(s.val());
  maybeCelebrateNewSale(pv.sales); // TEMP FIREWORKS hook (piece 2 of 3 — see below)
  renderPublic();
});

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

function maybeCelebrateNewSale(sales){
  const newestSale = sales[0];
  if(!__fwSeenFirstSnapshot){
    __fwSeenFirstSnapshot = true;
    __fwLastSaleKey = saleKey(newestSale);
    return;
  }
  if(newestSale && saleKey(newestSale) !== __fwLastSaleKey){
    __fwLastSaleKey = saleKey(newestSale);
    if(newestSale.result === 'sold' && newestSale.via !== 'assigned'){
      showSoldTakeover(newestSale);
      celebrateSaleFirework();
    }
  }
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
   plain string. Every value that came from the database is escaped. */
function soldTakeoverMarkup(sale){
  const s = sale || {};
  return `
  <div class="pv-takeover-timer" aria-hidden="true">
    <svg class="pv-takeover-ring" viewBox="0 0 56 56" focusable="false">
      <circle class="pv-takeover-ring-bg" cx="28" cy="28" r="24"/>
      <circle class="pv-takeover-ring-fg" cx="28" cy="28" r="24" style="animation-duration:${TAKEOVER_SECONDS}s; --pv-take-steps:${TAKEOVER_SECONDS}"/>
    </svg>
    <span class="pv-takeover-count" id="pvTakeoverCount">${TAKEOVER_SECONDS}</span>
  </div>
  <div class="pv-takeover-card">
    <div class="pv-takeover-stamp">Sold</div>
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

function showSoldTakeover(sale){
  if(typeof document === 'undefined') return;
  dismissSoldTakeover(); // a second sale right behind the first replaces it
  const el = document.createElement('div');
  el.className = 'pv-takeover';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('onclick', 'dismissSoldTakeover()');
  el.innerHTML = soldTakeoverMarkup(sale);
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

/* ---------------- Render ---------------- */

function renderPublic(){
  const c = document.getElementById('tabContent');
  const teamsArr = Object.entries(pv.teams).map(([id,t])=>({id, ...t}));
  const auc = pv.auction || {};
  const player = auc.currentPlayerId ? pv.players[auc.currentPlayerId] : null;
  const leader = auc.leaderTeamId ? pv.teams[auc.leaderTeamId] : null;
  const pendingLeft = Object.values(pv.players).filter(p=>p.status==='pending').length;

  // Bidding has been closed by the moderator: home screen, results on request.
  if(isCompleted(auc)){
    c.innerHTML = `
      <div class="pv-scope container-xl px-3 px-md-4">
        ${renderHomeScreen()}
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
      ${renderResultsPanel('Live Results', 'Every player as they go under the hammer, newest first.')}
      ${renderTeamsPanel(teamsArr, 'Teams')}
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

/** The live lot: photo on the left, the bid — the headline — on the right. */
function renderLiveLot(auc, player, leader){
  const lotNo = pv.sales.length + 1;
  const hue = hueFor(player.category);

  return `
  <section class="pv-panel pv-lot ${hue}">
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
      <button type="button" class="pv-btn" onclick="togglePastResults()">
        ${showPastResults ? 'Hide previous results' : 'View previous bidding results'}
      </button>`
    : `<p class="pv-hero-none">No results to show yet.</p>`}
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
                        <span class="pv-pill ${r.result==='sold'?'sold':'unsold'}">${r.result==='sold'?'Sold':'Unsold'}</span>
                        ${r.team ? `<span class="pv-sub-team">${r.team}</span>` : ''}
                      </div>
                    </div>
                  </div>
                </td>
                <td class="d-none d-md-table-cell">${r.category ? `<span class="pv-tag sm ${hueFor(r.category)}">${r.category}</span>` : '—'}</td>
                <td class="d-none d-lg-table-cell text-end pv-num pv-soft">${r.basePrice!=null ? fmtMoney(r.basePrice) : '—'}</td>
                <td class="d-none d-sm-table-cell"><span class="pv-pill ${r.result==='sold'?'sold':'unsold'}">${r.result==='sold'?'Sold':'Unsold'}</span></td>
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
      : `<div class="row g-3">
          ${teamsArr.map(t=>{
            const rem = remainingOf(t);
            const pct = t.budget ? Math.max(0,Math.min(100,(rem/t.budget)*100)) : 0;
            const hue = hueFor(t.name);
            return `
            <div class="col-12 col-sm-6 col-xl-4">
              <div class="pv-team h-100 ${hue}">
                <div class="pv-team-head">
                  <h3 class="pv-team-name"><span class="pv-dot ${hue}"></span>${t.name}</h3>
                  <span class="pv-team-squad">${squadCountOf(t)} player${squadCountOf(t)===1?'':'s'}</span>
                </div>
                <div class="pv-team-purse">${money(rem)}</div>
                <div class="pv-team-of">left of ${fmtMoney(t.budget)}</div>
                <div class="pv-bar"><div class="pv-bar-fill ${hue}" style="width:${pct}%;"></div></div>
              </div>
            </div>`;
          }).join('')}
        </div>`}
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
 */
function celebrateSaleFirework(){
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
    const count = 46 + Math.floor(Math.random()*18);
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
  const burstCount = 4 + Math.floor(Math.random()*3);
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

/* ---- team cards: inner glass, concentric with the panel ---- */
.pv-team{
  position:relative;
  padding:18px; border-radius:var(--pv-r-in);
  background:linear-gradient(152deg, rgba(255,255,255,.11), rgba(255,255,255,.04));
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.13), inset 0 1px 0 rgba(255,255,255,.22);
  transition:transform .2s ease, box-shadow .2s ease;
}
.pv-team:hover{transform:translateY(-2px); box-shadow:inset 0 0 0 1px rgba(255,255,255,.22), inset 0 1px 0 rgba(255,255,255,.3), 0 16px 32px -18px rgba(0,0,0,.9);}
.pv-team-head{display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin-bottom:14px;}
.pv-team-name{
  display:flex; align-items:center; gap:8px;
  font-size:14.5px; font-weight:640; letter-spacing:-.2px; margin:0; color:#fff;
}
.pv-team-squad{font-size:12px; color:var(--pv-ink-3); white-space:nowrap;}
.pv-dot{width:9px; height:9px; border-radius:50%; flex-shrink:0;}
.pv-dot.hue-blue  {background:var(--pv-blue);   box-shadow:0 0 12px rgba(10,132,255,.95);}
.pv-dot.hue-green {background:var(--pv-green);  box-shadow:0 0 12px rgba(48,209,88,.95);}
.pv-dot.hue-purple{background:var(--pv-purple); box-shadow:0 0 12px rgba(191,90,242,.95);}
.pv-dot.hue-orange{background:var(--pv-orange); box-shadow:0 0 12px rgba(255,159,10,.95);}
.pv-dot.hue-pink  {background:var(--pv-pink);   box-shadow:0 0 12px rgba(255,55,95,.95);}
.pv-dot.hue-teal  {background:var(--pv-teal);   box-shadow:0 0 12px rgba(64,200,224,.95);}
.pv-team-purse{
  font-size:27px; font-weight:660; letter-spacing:-1px; line-height:1;
  color:#fff; font-variant-numeric:tabular-nums;
}
.pv-team-purse .pv-unit{font-size:14px; font-weight:580; color:var(--pv-ink-3); margin-left:4px; letter-spacing:0;}
.pv-team-of{font-size:12px; color:var(--pv-ink-3); margin-top:5px;}
.pv-bar{height:5px; border-radius:999px; background:rgba(0,0,0,.4); overflow:hidden; margin-top:14px; box-shadow:inset 0 1px 2px rgba(0,0,0,.5);}
.pv-bar-fill{height:100%; border-radius:999px; transition:width .45s cubic-bezier(.4,0,.2,1); background:linear-gradient(90deg,var(--pv-blue-l),var(--pv-blue));}
.pv-bar-fill.hue-blue  {background:linear-gradient(90deg,var(--pv-blue-l),var(--pv-blue));     box-shadow:0 0 12px -2px rgba(10,132,255,.9);}
.pv-bar-fill.hue-green {background:linear-gradient(90deg,var(--pv-green-l),var(--pv-green));   box-shadow:0 0 12px -2px rgba(48,209,88,.9);}
.pv-bar-fill.hue-purple{background:linear-gradient(90deg,var(--pv-purple-l),var(--pv-purple)); box-shadow:0 0 12px -2px rgba(191,90,242,.9);}
.pv-bar-fill.hue-orange{background:linear-gradient(90deg,var(--pv-orange-l),var(--pv-orange)); box-shadow:0 0 12px -2px rgba(255,159,10,.9);}
.pv-bar-fill.hue-pink  {background:linear-gradient(90deg,var(--pv-pink-l),var(--pv-pink));     box-shadow:0 0 12px -2px rgba(255,55,95,.9);}
.pv-bar-fill.hue-teal  {background:linear-gradient(90deg,var(--pv-teal-l),var(--pv-teal));     box-shadow:0 0 12px -2px rgba(64,200,224,.9);}

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
