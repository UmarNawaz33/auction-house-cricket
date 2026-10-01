/* ============================================================
   team.js — gated by a team key. Can only see + bid for the one
   team their key is tied to. All other teams' internal detail
   (exact remaining purse etc.) is visible too since that's public
   info in this app, but writes are restricted server-side to
   their own team by the Database Rules.
   ============================================================ */

let tSession = getSession();
let tstate = { settings:{}, teams:{}, players:{}, auction:{} };

/* ---------------- Waiting out the big screen's slot-machine pick ----------------
   When a NEW player comes on the block, the big screen spins a slot-machine
   reel for slotPickDurationMs() (shared.js) before landing on them. Without
   this, an owner saw the player — and could bid — while the room was still
   watching the reel. So for that same span this page shows "Picking the
   next player…" in place of the lot, with no bid buttons, then reveals.

   Same trigger rules as public.js: never on the first auction snapshot
   (opening the page mid-lot shows the lot straight away), never for a bid
   on the same player, and not when there's nobody else for the big screen
   to spin through (it skips the spin then). Purely client-side — biddingOpen
   in Firebase is untouched; this page just doesn't offer the buttons yet.
   Cleared by its own timer (the flag, not a wall-clock comparison), and
   re-armed if yet another new player arrives mid-hold. Declared up here,
   before attachListeners() can ever run. */
let __teamAuctionSeen = false;
let __pickHoldPlayer = null;   // the player id being held back, or null
let __pickHoldTimer = null;

function notePickTransition(prev, next){
  const prevId = (prev && prev.currentPlayerId) || null;
  const nextId = (next && next.currentPlayerId) || null;
  if(nextId !== __pickHoldPlayer) clearPickHold(); // lot changed or ended mid-hold
  const others = Object.entries(tstate.players || {}).filter(([id, p]) => p && p.name && id !== nextId).length;
  if(__teamAuctionSeen && nextId && nextId !== prevId && others > 0){
    __pickHoldPlayer = nextId;
    __pickHoldTimer = setTimeout(() => { __pickHoldTimer = null; __pickHoldPlayer = null; render(); }, slotPickDurationMs());
  }
  __teamAuctionSeen = true;
}
function clearPickHold(){
  if(__pickHoldTimer){ clearTimeout(__pickHoldTimer); __pickHoldTimer = null; }
  __pickHoldPlayer = null;
}
function isPickHeld(auc){ return !!(auc && auc.currentPlayerId && auc.currentPlayerId === __pickHoldPlayer); }

function renderTopActions(){
  const el = document.getElementById('topActions');
  el.innerHTML = tSession
    ? `<span class="top-actions session-info">${escapeAttr(tSession.label||'Team Owner')} · <span id="connBadge2"></span></span><button class="danger sm" onclick="doSignOut()">Sign Out</button>`
    : '';
}
async function doSignOut(){ await signOutAll(); tSession=null; render(); }

function render(){
  renderTopActions();
  const c = document.getElementById('tabContent');
  if(!tSession || tSession.role!=='team'){ c.innerHTML = renderGate(); return; }
  c.innerHTML = renderDashboard();
  watchConnection('connBadge2');
}

function renderGate(){
  return `
  <div class="gate-wrap">
    <div class="gate-box">
      <div class="paddle-lg">T</div>
      <h2>Team Owner Access</h2>
      <p class="sub">Enter the key given to you by the organizer for your team.</p>
      <input type="text" id="teamKeyInput" placeholder="TEAM-XXXXXX" maxlength="20">
      <button class="primary block" style="margin-top:12px;" onclick="enterTeamKey()">Unlock My Team</button>
      <div class="gate-error" id="gateErr"></div>
    </div>
  </div>`;
}
async function enterTeamKey(){
  const errEl = document.getElementById('gateErr');
  errEl.textContent='';
  try{
    const s = await claimKey(document.getElementById('teamKeyInput').value);
    if(s.role!=='team'){ throw new Error('That key is not a team key.'); }
    tSession = s;
    attachListeners();
    render();
  }catch(e){ errEl.textContent = e.message; }
}

if(tSession && tSession.role==='team'){ ensureAnonymousAuth().then(attachListeners); }

function attachListeners(){
  db.ref('settings').on('value', s=>{ tstate.settings = s.val()||{}; window.__settingsCache=tstate.settings; render(); });
  db.ref('teams').on('value', s=>{ tstate.teams = s.val()||{}; render(); });
  db.ref('squads').on('value', s=>{
    const squads = s.val()||{};
    Object.keys(tstate.teams).forEach(id=>{ if(tstate.teams[id]) tstate.teams[id].squad = squads[id]||{}; });
    render();
  });
  db.ref('players').on('value', s=>{ tstate.players = s.val()||{}; render(); });
  db.ref('auction').on('value', s=>{
    const next = s.val()||{};
    notePickTransition(tstate.auction, next);
    tstate.auction = next;
    render();
  });
}

function myTeam(){ return tstate.teams[tSession.teamId] ? {id:tSession.teamId, ...tstate.teams[tSession.teamId]} : null; }
function getPlayer(id){ return id && tstate.players[id] ? {id, ...tstate.players[id]} : null; }
function getTeam(id){ return id && tstate.teams[id] ? {id, ...tstate.teams[id]} : null; }

/* ---------------- Target list ----------------
   The owner stars the players they want; when a starred player comes on the
   block, the dashboard flashes "Your target is up!". Stored ONLY in this
   browser's localStorage, keyed per team: no Firebase write, no
   database.rules.json change, never visible to other teams (a team's
   wishlist is private by nature). localStorage can be missing or throw
   (private mode, blocked storage, the Node test harness has none at all),
   so every read/write is wrapped — the list then just lives in memory for
   this tab. Loaded lazily on first use, not at file load, and reloaded if
   the signed-in team changes. */
let __targets = null;
let __targetsKey = null;
function targetsKey(){ return 'pv_targets_' + ((tSession && tSession.teamId) || ''); }
function loadTargets(){
  const key = targetsKey();
  if(__targets && __targetsKey === key) return __targets;
  __targetsKey = key;
  __targets = [];
  try{
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    if(Array.isArray(arr)) __targets = arr.filter(x => typeof x === 'string');
  }catch(e){ /* unavailable or corrupt — start empty */ }
  return __targets;
}
function isTarget(pid){ return !!pid && loadTargets().includes(pid); }
function toggleTarget(pid){
  const list = loadTargets();
  const i = list.indexOf(pid);
  if(i === -1) list.push(pid); else list.splice(i, 1);
  try{ localStorage.setItem(targetsKey(), JSON.stringify(list)); }catch(e){ /* keep it in memory */ }
  render();
}

/** Every still-pending player, starred ones first, as tappable star chips.
 *  Hidden once the auction is complete or nobody is left to target. The
 *  player currently on the block is still 'pending' (status only changes
 *  when sold/unsold), so it stays in the list, tagged "on the block". */
function renderTargetList(auc){
  if(isCompleted(auc)) return '';
  const targets = loadTargets();
  const pending = Object.entries(tstate.players)
    .map(([id,p]) => ({id, ...p}))
    .filter(p => p.status === 'pending')
    .sort((a,b) => (targets.includes(b.id) - targets.includes(a.id)) || String(a.name||'').localeCompare(String(b.name||'')));
  if(!pending.length) return '';
  const starred = pending.filter(p => targets.includes(p.id)).length;
  return `
  <div class="card">
    <h2>🎯 Target List <span class="n">${starred} starred</span></h2>
    <p class="hint" style="margin-bottom:12px;">Tap a player to star them. When one of your targets comes up for auction, this page flashes to tell you. Saved only on this device — no other team can see it.</p>
    <div class="pv-target-list">
      ${pending.map(p => {
        const on = targets.includes(p.id);
        const live = auc.currentPlayerId === p.id;
        return `
      <button type="button" class="pv-target${on ? ' is-on' : ''}${live ? ' is-live' : ''}" onclick="toggleTarget('${p.id}')" aria-pressed="${on}">
        <span class="pv-target-star" aria-hidden="true">${on ? '★' : '☆'}</span>
        <span class="pv-target-name">${escapeHtml(p.name)}</span>
        <span class="pv-target-meta">${escapeHtml(p.category || '')}${p.category ? ' · ' : ''}Base ${fmtMoney(p.basePrice)}</span>
      </button>`;
      }).join('')}
    </div>
  </div>`;
}

function renderDashboard(){
  const team = myTeam();
  if(!team){ return `<div class="card"><div class="empty-state"><div class="icn">⏳</div>Waiting for the moderator to set up teams…</div></div>`; }
  const auc = tstate.auction || {};
  // While the big screen is still spinning its slot-machine reel, nothing
  // below may reveal (or offer a bid on) the player — see notePickTransition.
  const held = isPickHeld(auc);
  const player = (!held && auc.currentPlayerId) ? getPlayer(auc.currentPlayerId) : null;
  const leader = auc.leaderTeamId ? getTeam(auc.leaderTeamId) : null;
  const iAmLeading = auc.leaderTeamId === team.id;
  const rem = remainingOf(team);
  const open = biddingIsOpen(auc);
  // Two raises: the standard one increment, and a double jump to shut out a
  // slow bidder. Each is priced and checked for affordability on its own.
  const steps = player ? [1,2].map(n=>{
    const price = bidPriceFor(auc, player, tstate.settings, n);
    return {
      n, price,
      raise: price - (auc.currentPrice || 0),
      ok: open && !iAmLeading && teamCanAffordBid(team, tstate.settings, price)
    };
  }) : [];
  const canBid = steps.some(s=>s.ok);

  const squadEntries = team.squad ? Object.entries(team.squad) : [];
  const targetUp = !!player && isTarget(player.id);
  // The highest bid that's legal for this team right now (maxAffordableBid,
  // shared.js) — same .chip design as its neighbours, by request.
  const squadFull = squadCountOf(team) >= (tstate.settings.maxPlayersPerTeam || Infinity);
  const maxBid = maxAffordableBid(team, tstate.settings);

  return `
  <div class="chip-row">
    <div class="chip"><div class="val">${team.name}</div><div class="lbl">My Team</div></div>
    <div class="chip"><div class="val">${fmtMoney(rem)}</div><div class="lbl">Purse Remaining</div></div>
    <div class="chip"><div class="val">${squadFull ? 'Squad full' : fmtMoney(maxBid)}</div><div class="lbl">Max You Can Bid</div></div>
    <div class="chip"><div class="val">${squadEntries.length}</div><div class="lbl">Squad Size</div></div>
  </div>

  ${renderTeamStatusBanner(auc)}
  ${callBannerMarkup(auc)}

  ${player ? `
  <div class="card pv-lot${targetUp ? ' is-target' : ''}">
    ${targetUp ? `<div class="pv-target-chip" role="status" aria-live="assertive"><span aria-hidden="true">🎯</span> Your target is up</div>` : ''}
    ${lotMarkup(player, {
      eyebrow: `<span class="pv-live-dot"></span>On the block &middot; bidding for ${team.name}`,
      price: auc.currentPrice || player.basePrice,
      leader: leader,
      leaderNote: iAmLeading ? 'You' : '',
      extra: `
        <div class="pv-bid-actions">
          <div class="pv-bid-buttons">
            ${steps.map(s=>`
              <button class="primary pv-bid-btn" onclick="placeMyBid(${s.n})" ${!s.ok?'disabled':''}>
                <span class="pv-bid-btn-raise">+${fmtMoney(s.raise)}</span>
                <span class="pv-bid-btn-total">Bid ${fmtMoney(s.price)}</span>
              </button>`).join('')}
          </div>
          ${iAmLeading ? `<p class="pv-bid-note good">You're the highest bidder.</p>`
            : !open ? `<p class="pv-bid-note">Bidding is closed right now.</p>`
            : !canBid ? `<p class="pv-bid-note">You can't bid right now — check your purse, the reserve for your minimum squad, or your squad size limit.</p>`
            : !steps[1].ok ? `<p class="pv-bid-note">The bigger raise is out of reach for your purse.</p>` : ''}
        </div>`
    })}
  </div>`
  : held ? `
  <div class="card pv-pick-wait" role="status" aria-live="polite">
    <div class="pv-pick-wait-dots" aria-hidden="true"><span></span><span></span><span></span></div>
    <h2>Picking the next player&hellip;</h2>
    <p class="hint">Watch the big screen — the player appears here, ready to bid on, the moment they're revealed.</p>
  </div>`
  : (isAwaitingNext(auc) || isCompleted(auc)) ? '' : `
  <div class="card" style="text-align:center;">
    <h2 style="justify-content:center;">${team.name}</h2>
    <div class="empty-state"><div class="icn">⏸</div>No player currently up for auction. Waiting for the moderator…</div>
  </div>`}

  ${renderTargetList(held ? {...auc, currentPlayerId:null} : auc)}

  <div class="card">
    <h2>My Squad <span class="n">${squadEntries.length}</span></h2>
    ${squadEntries.length===0 ? '<p class="hint">No players yet.</p>' : `
    <div class="table-wrap"><table>
      <thead><tr><th>Player</th><th>Category</th><th>Price</th></tr></thead>
      <tbody>${squadEntries.map(([pid,sq])=>{ const p=getPlayer(pid); return `<tr><td><div class="p-cell">${playerImg(p||{},'sm')}<span class="p-name">${p?p.name:'—'}</span></div></td><td><span class="badge cat">${p?p.category:''}</span></td><td>${fmtMoney(sq.price)}</td></tr>`; }).join('')}</tbody>
    </table></div>`}
  </div>
  `;
}

/** Paused / next-lot-coming messages, mirroring the public view. */
function renderTeamStatusBanner(auc){
  if(isCompleted(auc)){
    return `
    <div class="status-banner done">
      <div class="icn">🏁</div>
      <div class="txt">
        <div class="ttl">Bidding Complete</div>
        <div class="sub">The moderator has closed the auction. Your final squad is below.</div>
      </div>
    </div>`;
  }
  if(isPaused(auc) && sessionInProgress(auc)){
    return `
    <div class="status-banner paused">
      <div class="icn">⏸</div>
      <div class="txt">
        <div class="ttl">Auction Paused</div>
        <div class="sub">The moderator has stepped away. Bidding is on hold — nothing is lost, it resumes from here.</div>
      </div>
    </div>`;
  }
  if(isAwaitingNext(auc)){
    const last = auc.lastResult;
    return `
    <div class="status-banner waiting">
      <div class="icn">⏳</div>
      <div class="txt">
        <div class="ttl"><span class="pulse-dot"></span>Next Player Coming Up</div>
        <div class="sub">${last ? `${last.name} — ${last.result==='sold' ? `sold to <b>${last.team}</b> for <b>${fmtMoney(last.price)}</b>` : last.result==='unsold' ? 'went unsold' : 'was skipped'}. ` : ''}Waiting for the moderator to put up the next lot.</div>
      </div>
    </div>`;
  }
  return '';
}

/** `steps` is how many increments to raise by — 1 or 2 from the two buttons. */
async function placeMyBid(steps){
  const team = myTeam();
  const auc = tstate.auction;
  const player = getPlayer(auc.currentPlayerId);
  if(!player || !team) return;
  if(isPickHeld(auc)){ toast('Hold on — the next player is still being revealed on the big screen.', 'error'); return; }
  if(!biddingIsOpen(auc)){ toast('Bidding is closed — the moderator has paused the auction.', 'error'); return; }
  const nextPrice = bidPriceFor(auc, player, tstate.settings, steps);
  if(!teamCanAffordBid(team, tstate.settings, nextPrice)){ toast('You cannot afford this bid.', 'error'); return; }
  try{
    // callState:null — a fresh bid means whatever the moderator was calling
    // ("going once…") no longer applies; see moderator.js's callOnce()/
    // callTwice() comment for the full list of writes that cancel a call.
    await db.ref('auction').update({currentPrice:nextPrice, leaderTeamId:team.id, callState:null, updatedAt:Date.now()});
    toast('Bid placed: '+fmtMoney(nextPrice), 'success');
  }catch(e){
    toast('Bid failed — someone may have just outbid you.', 'error');
  }
}

render();
