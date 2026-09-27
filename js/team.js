/* ============================================================
   team.js — gated by a team key. Can only see + bid for the one
   team their key is tied to. All other teams' internal detail
   (exact remaining purse etc.) is visible too since that's public
   info in this app, but writes are restricted server-side to
   their own team by the Database Rules.
   ============================================================ */

let tSession = getSession();
let tstate = { settings:{}, teams:{}, players:{}, auction:{} };

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
  db.ref('auction').on('value', s=>{ tstate.auction = s.val()||{}; render(); });
}

function myTeam(){ return tstate.teams[tSession.teamId] ? {id:tSession.teamId, ...tstate.teams[tSession.teamId]} : null; }
function getPlayer(id){ return id && tstate.players[id] ? {id, ...tstate.players[id]} : null; }
function getTeam(id){ return id && tstate.teams[id] ? {id, ...tstate.teams[id]} : null; }

function renderDashboard(){
  const team = myTeam();
  if(!team){ return `<div class="card"><div class="empty-state"><div class="icn">⏳</div>Waiting for the moderator to set up teams…</div></div>`; }
  const auc = tstate.auction || {};
  const player = auc.currentPlayerId ? getPlayer(auc.currentPlayerId) : null;
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

  return `
  <div class="chip-row">
    <div class="chip"><div class="val">${fmtMoney(rem)}</div><div class="lbl">Purse Remaining</div></div>
    <div class="chip"><div class="val">${squadEntries.length}</div><div class="lbl">Squad Size</div></div>
  </div>

  ${renderTeamStatusBanner(auc)}

  ${player ? `
  <div class="card pv-lot">
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
  : (isAwaitingNext(auc) || isCompleted(auc)) ? '' : `
  <div class="card" style="text-align:center;">
    <h2 style="justify-content:center;">${team.name}</h2>
    <div class="empty-state"><div class="icn">⏸</div>No player currently up for auction. Waiting for the moderator…</div>
  </div>`}

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
  if(!biddingIsOpen(auc)){ toast('Bidding is closed — the moderator has paused the auction.', 'error'); return; }
  const nextPrice = bidPriceFor(auc, player, tstate.settings, steps);
  if(!teamCanAffordBid(team, tstate.settings, nextPrice)){ toast('You cannot afford this bid.', 'error'); return; }
  try{
    await db.ref('auction').update({currentPrice:nextPrice, leaderTeamId:team.id, updatedAt:Date.now()});
    toast('Bid placed: '+fmtMoney(nextPrice), 'success');
  }catch(e){
    toast('Bid failed — someone may have just outbid you.', 'error');
  }
}

render();
