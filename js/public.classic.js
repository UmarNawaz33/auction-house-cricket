/* ============================================================
   public.js — read-only live view. No auth, no writes.
   ============================================================ */

let pv = { settings:{currencyUnit:'Cr'}, teams:{}, players:{}, auction:{}, sales:[] };

// Once bidding is complete the page falls back to a home screen; the previous
// results stay one click away rather than on show.
let showPastResults = false;
function togglePastResults(){ showPastResults = !showPastResults; renderPublic(); }

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
db.ref('recentSales').on('value', s=>{ pv.sales = salesArray(s.val()); renderPublic(); });

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
      ${renderHomeScreen()}
      ${showPastResults ? `
        <div class="card">
          <h2>Previous Bidding Results <span class="n">${pv.sales.length}</span></h2>
          <p class="hint" style="margin-bottom:12px;">Every player that went under the hammer, newest first.</p>
          ${renderSalesTable(pv.sales)}
        </div>
        ${renderTeamsCard(teamsArr, 'Final Squads')}
      ` : ''}`;
    return;
  }

  c.innerHTML = `
    ${renderStage(auc, player, leader, pendingLeft)}

    <div class="card">
      <h2>Live Results <span class="n">${pv.sales.length}</span></h2>
      <p class="hint" style="margin-bottom:12px;">Every player as they go under the hammer, newest first.</p>
      ${renderSalesTable(pv.sales)}
    </div>

    ${renderTeamsCard(teamsArr, 'Teams')}
  `;
}

/** The resting state: no auction running, with a way into the past results. */
function renderHomeScreen(){
  const sold = pv.sales.filter(r=>r.result==='sold');
  const hasHistory = pv.sales.length > 0;
  return `
  <div class="home-hero">
    <div class="paddle-lg">A</div>
    <h2>No Live Auction</h2>
    <p class="sub">There's no bidding going on at the moment. Check back when the next auction starts.</p>
    ${hasHistory ? `
      <div class="chip-row" style="justify-content:center;">
        <div class="chip"><div class="val">${sold.length}</div><div class="lbl">Players Sold</div></div>
        <div class="chip"><div class="val">${fmtMoney(sold.reduce((s,r)=>s+(r.price||0),0))}</div><div class="lbl">Total Spend</div></div>
      </div>
      <button class="primary xl" onclick="togglePastResults()">
        ${showPastResults ? '✕ Hide Previous Results' : '📋 View Previous Bidding Results'}
      </button>`
    : `<p class="hint">No results to show yet.</p>`}
  </div>`;
}

function renderTeamsCard(teamsArr, heading){
  return `
  <div class="card">
    <h2>${heading} <span class="n">${teamsArr.length}</span></h2>
    <div class="grid cols-3">
      ${teamsArr.map(t=>{
        const rem = remainingOf(t);
        const pct = t.budget ? Math.max(0,Math.min(100,(rem/t.budget)*100)) : 0;
        return `
        <div class="team-card">
          <div class="head">
            <h3>${t.name}</h3>
          </div>
          <div class="stats-row"><span>Purse</span><span>${fmtMoney(rem)} / ${fmtMoney(t.budget)}</span></div>
          <div class="stats-row"><span>Squad</span><span>${squadCountOf(t)} players</span></div>
          <div class="budgetbar"><div class="fg" style="width:${pct}%;"></div></div>
        </div>`;
      }).join('') || '<p class="hint">No teams yet.</p>'}
    </div>
  </div>`;
}

/** The big area at the top: the live lot, or whatever is happening instead. */
function renderStage(auc, player, leader, pendingLeft){
  // Moderator stepped away — everything is on hold.
  if(isPaused(auc) && (auc.currentPlayerId || auc.awaitingNext)){
    return `
    <div class="status-banner paused">
      <div class="icn">⏸</div>
      <div class="txt">
        <div class="ttl">Auction Paused</div>
        <div class="sub">The moderator has stepped away. Bidding is on hold and the auction will pick up right where it left off.</div>
      </div>
    </div>`;
  }

  // A result was just called and the moderator hasn't put up the next lot yet.
  if(isAwaitingNext(auc)){
    const last = auc.lastResult;
    if(pendingLeft===0){
      return `
      <div class="status-banner done">
        <div class="icn">🏆</div>
        <div class="txt">
          <div class="ttl">That's A Wrap</div>
          <div class="sub">Every player has been auctioned. Final squads and purses are below.</div>
        </div>
      </div>`;
    }
    return `
    ${last ? `
    <div class="status-banner ${last.result==='sold'?'done':'waiting'}">
      <div class="icn">${last.result==='sold'?'✅':last.result==='unsold'?'❌':'⏭'}</div>
      <div class="txt">
        <div class="ttl">${last.name} — ${last.result==='sold'?'SOLD':last.result==='unsold'?'UNSOLD':'SKIPPED'}</div>
        <div class="sub">${last.result==='sold' ? `Bought by <b>${last.team}</b> for <b>${fmtMoney(last.price)}</b>.` : last.result==='unsold' ? 'No bids were placed.' : 'Back in the pool for later.'}</div>
      </div>
    </div>` : ''}
    <div class="card" style="text-align:center;">
      <div class="empty-state">
        <div class="icn">⏳</div>
        <div style="font-family:var(--font-display);text-transform:uppercase;letter-spacing:2px;font-size:20px;color:var(--gold);margin-bottom:6px;">
          <span class="pulse-dot"></span>Next Player Coming Up
        </div>
        <div style="font-size:13px;">The moderator is about to put up the next lot — ${pendingLeft} player${pendingLeft===1?'':'s'} still to go.</div>
      </div>
    </div>`;
  }

  if(!player){
    return `<div class="card"><div class="empty-state"><div class="icn">🏏</div>No player currently up for auction.</div></div>`;
  }

  return `
  <div class="player-card" style="margin-bottom:18px;">
    ${playerImg(player,'lg')}
    <div class="cat"><span class="badge cat">${player.category}</span></div>
    <div class="player-name">${player.name}</div>
    <div class="base-price">Base Price: ${fmtMoney(player.basePrice)}</div>
    <div class="scoreboard"><div class="price">${fmtMoney(auc.currentPrice || player.basePrice)}</div><div class="plabel">Current Bid</div></div>
    <div class="leader-line">${leader ? `Leading: <span class="lname">${leader.name}</span>` : 'No bids yet — base price active'}</div>
  </div>`;
}
