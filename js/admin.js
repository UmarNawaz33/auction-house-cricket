/* ============================================================
   admin.js — organizer portal. Real Firebase email/password
   login (not a shareable "key"). Generates and revokes access
   keys, gives a full read-only view of the auction, exports the
   session data, and is the only place things can be deleted
   wholesale.
   ============================================================ */

let adminState = {
  session:null, settings:{}, teams:{}, players:{}, auction:{}, sales:[], keys:{}
};
let adminTab = 'keys';

const ADMIN_TABS = [
  {id:'keys',    label:'Access Keys'},
  {id:'teams',   label:'Teams'},
  {id:'players', label:'Players'},
  {id:'live',    label:'Live Auction'},
  {id:'data',    label:'Data & Reset'}
];

function renderTopActions(){
  const el = document.getElementById('topActions');
  if(!el) return;
  el.innerHTML = adminState.session
    ? `<span class="top-actions session-info">Signed in as ${escapeAttr(adminState.session.label)} · <span id="connBadge2"></span></span><button class="danger sm" onclick="doSignOut()">Sign Out</button>`
    : '';
}
async function doSignOut(){ await signOutAll(); adminState.session=null; render(); }

auth.onAuthStateChanged(async user=>{
  try{
    if(user && !user.isAnonymous && !adminState.session){
      const snap = await db.ref('admins/'+user.uid).once('value');
      if(snap.val()===true){
        adminState.session = {role:'admin', uid:user.uid, label:user.email};
        saveSession(adminState.session);
        attachAdminListeners();
      }
    } else if(adminState.session && (!user || user.isAnonymous)){
      /* Firebase has dropped or replaced the organizer's credential while
         this page stayed open. The usual cause is another tab of the same
         browser: a moderator/team key login calls ensureAnonymousAuth(),
         which must switch the shared Auth instance to SESSION persistence to
         scope itself to that tab — and switching persistence migrates the
         current user out of the shared storage the admin tab was relying on.

         This branch did not exist, and its absence is what made the panel
         feel broken: adminState.session is plain page state, so the console
         went on rendering as "signed in" while auth.uid was null or
         anonymous. Every write then failed the Database Rules
         (accessKeys/$key requires admins/<auth.uid> === true), so buttons
         like "Generate key" did nothing at all. Say so and show the login. */
      adminState.session = null;
      clearSession();
      toast('Your organizer sign-in ended in this browser — sign in again to continue.', 'error');
    }
  }catch(e){
    console.error('Admin auth check failed:', e);
  }
  render();
});

let adminListenersAttached = false;
function attachAdminListeners(){
  if(adminListenersAttached) return;
  adminListenersAttached = true;
  db.ref('settings').on('value', s=>{ adminState.settings = s.val() || {}; window.__settingsCache = adminState.settings; render(); });
  db.ref('teams').on('value', s=>{ adminState.teams = s.val() || {}; render(); });
  db.ref('squads').on('value', s=>{
    const squads = s.val() || {};
    Object.keys(adminState.teams).forEach(id=>{ if(adminState.teams[id]) adminState.teams[id].squad = squads[id]||{}; });
    render();
  });
  db.ref('players').on('value', s=>{ adminState.players = s.val() || {}; render(); });
  db.ref('auction').on('value', s=>{ adminState.auction = s.val() || {}; render(); });
  db.ref('recentSales').on('value', s=>{ adminState.sales = salesArray(s.val()); render(); });
  db.ref('accessKeys').on('value', s=>{ adminState.keys = s.val() || {}; render(); });
}

/* ---------------- helpers over live data ---------------- */
function aTeams(){ return Object.entries(adminState.teams).map(([id,t])=>({id, ...t})); }
function aPlayers(){ return Object.entries(adminState.players).map(([id,p])=>({id, ...p})); }
function aTeam(id){ return id && adminState.teams[id] ? {id, ...adminState.teams[id]} : null; }
function aPlayer(id){ return id && adminState.players[id] ? {id, ...adminState.players[id]} : null; }
function aKeys(){ return Object.entries(adminState.keys).map(([k,v])=>({key:k, ...v})).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)); }

function render(){
  renderTopActions();
  const nav = document.getElementById('tabNav');
  const c = document.getElementById('tabContent');
  if(!adminState.session){
    if(nav) nav.innerHTML = '';
    c.innerHTML = renderLogin();
    return;
  }
  if(nav) nav.innerHTML = renderTabNav(ADMIN_TABS, adminTab, 'setAdminTab');
  if(adminTab==='keys') c.innerHTML = renderKeys();
  else if(adminTab==='teams') c.innerHTML = renderTeamsTab();
  else if(adminTab==='players') c.innerHTML = renderPlayersTab();
  else if(adminTab==='live') c.innerHTML = renderLiveTab();
  else if(adminTab==='data') c.innerHTML = renderDataTab();
  watchConnection('connBadge2');
}
function setAdminTab(id){ adminTab=id; render(); window.scrollTo({top:0,behavior:'smooth'}); }

function renderLogin(){
  return `
  <div class="gate-wrap">
    <div class="gate-box">
      <div class="paddle-lg">A</div>
      <h2>Organizer Sign In</h2>
      <p class="sub">Real Firebase email &amp; password account — this is the one login that isn't a shareable key. See README → "Creating the first admin" if you haven't set one up yet.</p>
      <div class="field" style="text-align:left;"><label>Email</label><input type="text" id="admEmail" placeholder="you@example.com" style="text-transform:none;letter-spacing:normal;font-family:var(--font-body);"></div>
      <div class="field" style="text-align:left;"><label>Password</label><input type="password" placeholder="password" id="admPass" style="text-transform:none;letter-spacing:normal;font-family:var(--font-body);"></div>
      <button class="primary block" onclick="doAdminLogin()">Sign In</button>
      <div class="gate-error" id="admErr"></div>
    </div>
  </div>`;
}
async function doAdminLogin(){
  const email = document.getElementById('admEmail').value.trim();
  const pass = document.getElementById('admPass').value;
  const errEl = document.getElementById('admErr');
  const btn = document.querySelector('.gate-box button.primary');
  errEl.textContent='';
  btn.disabled = true; btn.textContent = 'Signing in…';
  try{
    adminState.session = await adminLogin(email, pass);
    attachAdminListeners();
    render();
  }catch(e){
    console.error('Admin login failed:', e);
    errEl.textContent = e.message.replace('Firebase: ','');
    btn.disabled = false; btn.textContent = 'Sign In';
  }
}

/* ============================ ACCESS KEYS TAB ============================ */
function renderKeys(){
  const teamsArr = aTeams();
  const keysArr = aKeys();

  return `
  <div class="grid cols-2">
    <div class="card">
      <h2>Create Moderator Key</h2>
      <p class="hint">Give this key to whoever will run the auction floor (add players, control the live lot, confirm sales). They'll enter it on the Moderator portal.</p>
      <div class="field"><label>Label (optional)</label><input type="text" id="modLabel" placeholder="e.g. Main Moderator"></div>
      <button class="primary block" onclick="createModeratorKey()">+ Generate Moderator Key</button>
    </div>

    <div class="card">
      <h2>Create Team Key</h2>
      <p class="hint">Give this key to a specific team's owner — it only lets them bid for that one team. Teams must already exist (created by the moderator in the Setup tab) before you can assign a key to one.</p>
      <div class="field"><label>Team</label>
        <select id="teamSelectForKey">
          ${teamsArr.length===0 ? '<option value="">No teams yet</option>' : teamsArr.map(t=>`<option value="${t.id}">${t.name}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Label (optional)</label><input type="text" id="teamKeyLabel" placeholder="e.g. Owner's name"></div>
      <button class="primary block" onclick="createTeamKey()" ${teamsArr.length===0?'disabled':''}>+ Generate Team Key</button>
    </div>
  </div>

  <div class="card">
    <h2>All Keys <span class="n">${keysArr.length}</span></h2>
    ${keysArr.length===0 ? `<div class="empty-state"><div class="icn">🔑</div>No keys generated yet.</div>` : keysArr.map(k=>`
      <div class="key-list-row">
        <div>
          <span class="key-code">${k.key}</span>
          <span class="badge cat" style="margin-left:8px;">${k.role}${k.teamId ? ' · '+(adminState.teams[k.teamId]?.name||k.teamId) : ''}</span>
          <div class="key-meta">${k.label ? k.label+' · ' : ''}created ${k.createdAt ? new Date(k.createdAt).toLocaleString() : '—'}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <span class="badge ${k.active?'active-key':'revoked'}">${k.active?'active':'revoked'}</span>
          ${k.active ? `<button class="sm danger" onclick="revokeKey('${k.key}')">Revoke</button>` : `<button class="sm" onclick="reactivateKey('${k.key}')">Reactivate</button>`}
          <button class="sm danger" onclick="confirmDeleteKey('${k.key}')">Delete</button>
        </div>
      </div>
    `).join('')}
  </div>
  `;
}

/* Every accessKeys write is gated server-side on admins/<auth.uid> === true.
   Without this, a rejected write just became an unhandled promise rejection:
   the success toast never ran and the click looked like it did nothing, which
   is far more confusing than an error. Name the actual remedy instead. */
function adminActionError(e){
  const msg = (e && e.message) || '';
  if(/permission[_ ]?denied/i.test(msg)){
    return 'Not saved — this browser is no longer signed in as the organizer. Sign in again, then retry.';
  }
  return 'Not saved: ' + (msg || 'unknown error');
}

async function createModeratorKey(){
  const label = document.getElementById('modLabel').value.trim();
  const key = genKeyString('moderator');
  try{
    await db.ref('accessKeys/'+key).set({role:'moderator', teamId:null, label, active:true, createdAt:Date.now()});
  }catch(e){ toast(adminActionError(e), 'error'); return; }
  toast('Moderator key created: '+key, 'success');
  document.getElementById('modLabel').value='';
}
async function createTeamKey(){
  const teamId = document.getElementById('teamSelectForKey').value;
  const label = document.getElementById('teamKeyLabel').value.trim();
  if(!teamId){ toast('Select a team first.', 'error'); return; }
  const key = genKeyString('team');
  try{
    await db.ref('accessKeys/'+key).set({role:'team', teamId, label, active:true, createdAt:Date.now()});
  }catch(e){ toast(adminActionError(e), 'error'); return; }
  toast('Team key created: '+key, 'success');
  document.getElementById('teamKeyLabel').value='';
}
async function revokeKey(key){
  try{ await db.ref('accessKeys/'+key+'/active').set(false); }
  catch(e){ toast(adminActionError(e), 'error'); return; }
  toast('Key revoked.');
}
async function reactivateKey(key){
  try{ await db.ref('accessKeys/'+key+'/active').set(true); }
  catch(e){ toast(adminActionError(e), 'error'); return; }
  toast('Key reactivated.', 'success');
}

function confirmDeleteKey(key){
  const k = adminState.keys[key] || {};
  askConfirm({
    title: 'Delete this key?',
    body: `<b>${key}</b> (${k.role||'key'}) will be removed for good. Anyone currently signed in with it is locked out as soon as they reload. Revoking instead keeps the record.`,
    confirmLabel: 'Delete Key',
    run: async ()=>{
      await db.ref('accessKeys/'+key).remove();
      toast('Key deleted.');
    }
  });
}

/* ============================ TEAMS TAB ============================ */
function renderTeamsTab(){
  const teams = aTeams();
  const totalBudget = teams.reduce((s,t)=>s+(t.budget||0),0);
  const totalSpent = teams.reduce((s,t)=>s+spentOf(t),0);
  if(teams.length===0){ return `<div class="card"><div class="empty-state"><div class="icn">👥</div>No teams yet. The moderator creates them in the Setup tab.</div></div>`; }
  return `
  <div class="chip-row">
    <div class="chip"><div class="val">${teams.length}</div><div class="lbl">Teams</div></div>
    <div class="chip"><div class="val">${fmtMoney(totalBudget)}</div><div class="lbl">Total Budget</div></div>
    <div class="chip"><div class="val">${fmtMoney(totalSpent)}</div><div class="lbl">Total Spent</div></div>
    <div class="chip"><div class="val">${teams.reduce((s,t)=>s+squadCountOf(t),0)}</div><div class="lbl">Players Bought</div></div>
  </div>
  <div class="grid cols-3">
    ${teams.map(t=>{
      const rem = remainingOf(t);
      const pctBar = t.budget ? Math.max(0,Math.min(100,(rem/t.budget)*100)) : 0;
      const squadEntries = t.squad ? Object.entries(t.squad) : [];
      return `
      <div class="team-card">
        <div class="head"><h3>${t.name}</h3><span class="badge cat">${squadEntries.length} players</span></div>
        <div class="stats-row"><span>Total Budget</span><span>${fmtMoney(t.budget)}</span></div>
        <div class="stats-row"><span>Spent</span><span>${fmtMoney(spentOf(t))}</span></div>
        <div class="stats-row"><span>Remaining</span><span>${fmtMoney(rem)}</span></div>
        <div class="budgetbar"><div class="fg" style="width:${pctBar}%;"></div></div>
        <div class="squad-list">
          ${squadEntries.length===0 ? '<p class="hint">No players yet.</p>' : squadEntries.map(([pid,sq])=>{
            const p = aPlayer(pid);
            return `<div class="squad-row"><div class="p-cell">${playerImg(p||{},'sm')}<div><div>${p?p.name:'—'}</div><div class="p-meta">${p?p.category:''}</div></div></div>
              <div style="text-align:right;font-family:var(--font-mono);">${fmtMoney(sq.price)}</div></div>`;
          }).join('')}
        </div>
        <button class="danger block sm" style="margin-top:12px;" onclick="confirmDeleteTeam('${t.id}')">Delete Team</button>
      </div>`;
    }).join('')}
  </div>`;
}

function confirmDeleteTeam(id){
  const t = aTeam(id);
  if(!t) return;
  const count = squadCountOf(t);
  const tiedKeys = aKeys().filter(k=>k.teamId===id);
  askConfirm({
    title: 'Delete '+t.name+'?',
    body: `${count>0 ? `Their <b>${count}</b> player${count===1?'':'s'} go back into the auction pool as pending. ` : ''}${tiedKeys.length ? `<b>${tiedKeys.length}</b> access key${tiedKeys.length===1?'':'s'} tied to this team will also be deleted. ` : ''}This cannot be undone.`,
    confirmLabel: 'Delete Team',
    run: async ()=>{
      const updates = {};
      Object.keys(t.squad||{}).forEach(pid=>{
        updates['players/'+pid+'/status'] = 'pending';
        updates['players/'+pid+'/soldTo'] = null;
        updates['players/'+pid+'/soldPrice'] = null;
        updates['recentSales/'+pid] = null; // back to pending — their sold row no longer applies
      });
      tiedKeys.forEach(k=>{ updates['accessKeys/'+k.key] = null; });
      updates['squads/'+id] = null;
      updates['teams/'+id] = null;
      await db.ref().update(updates);
      if(adminState.auction.leaderTeamId===id){
        await db.ref('auction').update({leaderTeamId:null, currentPrice:0});
      }
      toast(t.name+' deleted.');
    }
  });
}

/* ============================ PLAYERS TAB ============================ */
let adminPlayerFilter = {q:'', status:''};
function renderPlayersTab(){
  const all = aPlayers();
  const shown = all.filter(p=>{
    if(adminPlayerFilter.q && !(p.name||'').toLowerCase().includes(adminPlayerFilter.q.toLowerCase())) return false;
    if(adminPlayerFilter.status && p.status!==adminPlayerFilter.status) return false;
    return true;
  }).sort((a,b)=>(b.soldPrice||0)-(a.soldPrice||0));
  return `
  <div class="chip-row">
    <div class="chip"><div class="val">${all.length}</div><div class="lbl">Total</div></div>
    <div class="chip"><div class="val">${all.filter(p=>p.status==='pending').length}</div><div class="lbl">Pending</div></div>
    <div class="chip"><div class="val">${all.filter(p=>p.status==='sold').length}</div><div class="lbl">Sold</div></div>
    <div class="chip"><div class="val">${all.filter(p=>p.status==='unsold').length}</div><div class="lbl">Unsold</div></div>
  </div>
  <div class="card">
    <h2>All Players <span class="n">${shown.length} shown</span></h2>
    <div class="field-row" style="margin-bottom:12px;">
      <div class="field"><label>Search</label><input type="text" value="${escapeAttr(adminPlayerFilter.q)}" oninput="adminPlayerFilter.q=this.value; render();"></div>
      <div class="field"><label>Status</label><select onchange="adminPlayerFilter.status=this.value; render();">
        <option value="">All</option>
        <option value="pending" ${adminPlayerFilter.status==='pending'?'selected':''}>Pending</option>
        <option value="sold" ${adminPlayerFilter.status==='sold'?'selected':''}>Sold</option>
        <option value="unsold" ${adminPlayerFilter.status==='unsold'?'selected':''}>Unsold</option>
      </select></div>
    </div>
    ${all.length===0 ? `<div class="empty-state"><div class="icn">📋</div>No players yet. The moderator adds them in the Players tab.</div>`
     : shown.length===0 ? `<div class="empty-state"><div class="icn">🔍</div>No players match.</div>` : `
    <div class="table-wrap"><table>
      <thead><tr><th>Player</th><th>Category</th><th>Base</th><th>Status</th><th>Sold To</th><th>Price</th><th></th></tr></thead>
      <tbody>${shown.map(p=>`
        <tr>
          <td><div class="p-cell">${playerImg(p,'sm')}<span class="p-name">${p.name}</span></div></td>
          <td><span class="badge cat">${p.category||'—'}</span></td>
          <td>${fmtMoney(p.basePrice)}</td>
          <td><span class="badge ${p.status}">${p.status}</span></td>
          <td>${p.soldTo ? (aTeam(p.soldTo)?.name||'—') : '—'}</td>
          <td>${p.soldPrice!=null ? fmtMoney(p.soldPrice) : '—'}</td>
          <td><button class="sm danger" onclick="confirmDeleteAdminPlayer('${p.id}')">Delete</button></td>
        </tr>`).join('')}</tbody>
    </table></div>`}
  </div>`;
}

function confirmDeleteAdminPlayer(id){
  const p = aPlayer(id);
  if(!p) return;
  const team = p.soldTo ? aTeam(p.soldTo) : null;
  askConfirm({
    title: 'Delete '+p.name+'?',
    body: team ? `They were sold to <b>${team.name}</b> for <b>${fmtMoney(p.soldPrice)}</b>. Deleting removes them from that squad and refunds the purse.` : 'They will be removed from the player pool for good.',
    confirmLabel: 'Delete Player',
    run: async ()=>{
      const updates = {};
      if(p.soldTo) updates['squads/'+p.soldTo+'/'+id] = null;
      updates['players/'+id] = null;
      updates['recentSales/'+id] = null; // a deleted player shouldn't linger in the results log
      await db.ref().update(updates);
      if(adminState.auction.currentPlayerId===id){
        await db.ref('auction').update({currentPlayerId:null, currentPrice:0, leaderTeamId:null, biddingOpen:false});
      }
      toast(p.name+' deleted.');
    }
  });
}

/* ============================ LIVE AUCTION TAB ============================ */
function renderLiveTab(){
  const auc = adminState.auction || {};
  const player = auc.currentPlayerId ? aPlayer(auc.currentPlayerId) : null;
  const leader = auc.leaderTeamId ? aTeam(auc.leaderTeamId) : null;
  const teams = aTeams();
  const pending = aPlayers().filter(p=>p.status==='pending').length;

  const pauseNote = auc.pauseReason==='manual' ? 'The moderator paused it.'
    : auc.pauseReason==='disconnect' ? 'The console closed or lost its connection.'
    : 'The moderator signed out.';

  const state = isCompleted(auc) ? {cls:'done', icn:'🏁', ttl:'Bidding Complete', sub:`The moderator closed the auction${auc.completedAt ? ' at '+fmtTime(auc.completedAt) : ''}. The public view is on its home screen with the results one click away.`}
    : isPaused(auc) && sessionInProgress(auc) ? {cls:'paused', icn:'⏸', ttl:'Paused', sub:pauseNote+' Bidding is closed until they resume.'}
    : isAwaitingNext(auc) ? {cls:'waiting', icn:'⏳', ttl:'Between Lots', sub:'A result was just called. The moderator has not put up the next player yet.'}
    : player ? {cls:'done', icn:'🔨', ttl:'Bidding Live', sub:'Team owners can place bids right now.'}
    : {cls:'waiting', icn:'💤', ttl:'Not Started', sub:'No player is on the block.'};

  return `
  <div class="status-banner ${state.cls}">
    <div class="icn">${state.icn}</div>
    <div class="txt"><div class="ttl">${state.ttl}</div><div class="sub">${state.sub}</div></div>
  </div>

  <div class="grid cols-2">
    <div class="card">
      <h2>Current Lot</h2>
      ${player ? `
        <div style="text-align:center;">
          ${playerImg(player,'lg')}
          <div style="font-family:var(--font-display);text-transform:uppercase;letter-spacing:2px;font-size:24px;font-weight:800;">${player.name}</div>
          <div class="hint" style="margin-bottom:10px;"><span class="badge cat">${player.category||'—'}</span> · Base ${fmtMoney(player.basePrice)}</div>
          <div class="scoreboard"><div class="price">${fmtMoney(auc.currentPrice || player.basePrice)}</div><div class="plabel">Current Bid</div></div>
          <div class="leader-line">${leader ? `Leading: <span class="lname">${leader.name}</span>` : 'No bids yet'}</div>
        </div>`
      : auc.lastResult ? `<div class="empty-state"><div class="icn">⏭</div>Last called: <b>${auc.lastResult.name}</b> — ${auc.lastResult.result==='sold' ? `sold to ${auc.lastResult.team} for ${fmtMoney(auc.lastResult.price)}` : auc.lastResult.result}</div>`
      : `<div class="empty-state"><div class="icn">💤</div>Nothing on the block.</div>`}
      <div class="stats-row" style="margin-top:14px;"><span>Players still pending</span><span>${pending}</span></div>
      <div class="stats-row"><span>Bidding open</span><span>${biddingIsOpen(auc)?'Yes':'No'}</span></div>
      <div class="stats-row"><span>Last update</span><span>${auc.updatedAt ? fmtTime(auc.updatedAt) : '—'}</span></div>
    </div>

    <div class="card">
      <h2>Team Purses <span class="n">${teams.length}</span></h2>
      ${teams.length===0 ? '<p class="hint">No teams yet.</p>' : `
      <div class="team-grid">
        ${teams.map(t=>{
          const rem = remainingOf(t);
          const pctBar = t.budget ? Math.max(0,Math.min(100,(rem/t.budget)*100)) : 0;
          return `
          <div class="team-box readonly ${t.id===auc.leaderTeamId?'leader':''}">
            ${t.id===auc.leaderTeamId?'<span class="tag-leader">LEADING</span>':''}
            <div class="tname">${t.name}</div>
            <div class="tstat"><span>Purse</span><span>${fmtMoney(rem)}</span></div>
            <div class="tstat"><span>Squad</span><span>${squadCountOf(t)}</span></div>
            <div class="barbg"><div class="barfg" style="width:${pctBar}%;"></div></div>
          </div>`;
        }).join('')}
      </div>`}
    </div>
  </div>

  <div class="card">
    <h2>Live Results <span class="n">${adminState.sales.length}</span></h2>
    ${renderSalesTable(adminState.sales)}
  </div>`;
}

/* ============================ DATA & RESET TAB ============================ */
function renderDataTab(){
  const players = aPlayers();
  const teams = aTeams();
  const modKeys = aKeys().filter(k=>k.role==='moderator');
  const sold = players.filter(p=>p.status==='sold');

  return `
  <div class="card">
    <h2>Download Session Data</h2>
    <p class="hint" style="margin-bottom:14px;">Everything below is generated in your browser from the live data — nothing is uploaded anywhere.</p>
    <div class="grid cols-2">
      <div>
        <button class="block" onclick="exportResultsCSV()">⬇ Auction Results (CSV)</button>
        <p class="hint">Every player, who bought them and for how much — ${players.length} row${players.length===1?'':'s'}.</p>
      </div>
      <div>
        <button class="block" onclick="exportSalesLogCSV()">⬇ Live Results Log (CSV)</button>
        <p class="hint">Each lot in the order it was called — ${adminState.sales.length} row${adminState.sales.length===1?'':'s'}.</p>
      </div>
      <div>
        <button class="block" onclick="exportSquadsCSV()">⬇ Team Squads (CSV)</button>
        <p class="hint">One row per signing, grouped by team — ${sold.length} signing${sold.length===1?'':'s'}.</p>
      </div>
      <div>
        <button class="block" onclick="exportBackupJSON()">⬇ Full Backup (JSON)</button>
        <p class="hint">Complete snapshot: settings, teams, squads, players, keys and the results log.</p>
      </div>
    </div>
  </div>

  <div class="card danger-zone">
    <h2>⚠ Danger Zone</h2>
    <p class="hint" style="margin-bottom:6px;">These cannot be undone. Take a backup first.</p>

    <div class="danger-row">
      <div class="what">
        <b>Reset the bidding session</b>
        <p>Keeps every team and player, but puts all ${players.length} player${players.length===1?'':'s'} back to pending, empties all squads, restores full purses and clears the results log. Use this to run the same auction again from scratch.</p>
      </div>
      <button class="danger sm" onclick="confirmResetSession()" ${players.length===0&&adminState.sales.length===0?'disabled':''}>Reset Session</button>
    </div>

    <div class="danger-row">
      <div class="what">
        <b>Delete all players</b>
        <p>Removes all ${players.length} player${players.length===1?'':'s'} and empties every squad. Teams and their budgets stay.</p>
      </div>
      <button class="danger sm" onclick="confirmDeleteAllPlayers()" ${players.length===0?'disabled':''}>Delete Players</button>
    </div>

    <div class="danger-row">
      <div class="what">
        <b>Delete all teams</b>
        <p>Removes all ${teams.length} team${teams.length===1?'':'s'}, their squads and their access keys. Players they had bought go back to pending.</p>
      </div>
      <button class="danger sm" onclick="confirmDeleteAllTeams()" ${teams.length===0?'disabled':''}>Delete Teams</button>
    </div>

    <div class="danger-row">
      <div class="what">
        <b>Delete all moderator keys</b>
        <p>Removes all ${modKeys.length} moderator key${modKeys.length===1?'':'s'}. Anyone running the console is locked out on their next reload, and you'll need to issue a new key. Team keys are untouched.</p>
      </div>
      <button class="danger sm" onclick="confirmDeleteModerators()" ${modKeys.length===0?'disabled':''}>Delete Moderators</button>
    </div>

    <div class="danger-row">
      <div class="what">
        <b>Wipe everything</b>
        <p>Players, teams, squads, the live auction, the results log and every access key. Only your organizer login and the global settings survive.</p>
      </div>
      <button class="danger sm" onclick="confirmWipeAll()">Wipe Everything</button>
    </div>
  </div>`;
}

/* ---------------- exports ---------------- */
function exportResultsCSV(){
  const rows = [['Player','Category','Base Price','Photo','Status','Team','Sold Price']];
  aPlayers().forEach(p=>rows.push([
    p.name, p.category, p.basePrice, p.image||'', p.status,
    p.soldTo ? (aTeam(p.soldTo)?.name||'') : '', p.soldPrice!=null ? p.soldPrice : ''
  ]));
  downloadCSV(rows, stampedName('auction-results','csv'));
  toast('Results downloaded.', 'success');
}
function exportSalesLogCSV(){
  const rows = [['#','Time','Player','Category','Base Price','Result','Team','Sold Price']];
  // oldest first reads like a running order
  adminState.sales.slice().reverse().forEach((r,i)=>rows.push([
    i+1, r.time ? new Date(r.time).toLocaleString() : '', r.name, r.category,
    r.basePrice!=null ? r.basePrice : '', r.result, r.team||'', r.price!=null ? r.price : ''
  ]));
  downloadCSV(rows, stampedName('auction-sales-log','csv'));
  toast('Sales log downloaded.', 'success');
}
function exportSquadsCSV(){
  const rows = [['Team','Team Budget','Player','Category','Price']];
  aTeams().forEach(t=>{
    const entries = Object.entries(t.squad||{});
    if(entries.length===0){ rows.push([t.name, t.budget, '(no players)', '', '']); return; }
    entries.forEach(([pid,sq])=>{
      const p = aPlayer(pid);
      rows.push([t.name, t.budget, p?p.name:pid, p?p.category:'', sq.price]);
    });
  });
  downloadCSV(rows, stampedName('auction-squads','csv'));
  toast('Squads downloaded.', 'success');
}
function exportBackupJSON(){
  const squads = {};
  aTeams().forEach(t=>{ squads[t.id] = t.squad||{}; });
  downloadJSON({
    exportedAt: new Date().toISOString(),
    settings: adminState.settings,
    teams: adminState.teams,
    squads,
    players: adminState.players,
    auction: adminState.auction,
    salesLog: adminState.sales,
    accessKeys: adminState.keys
  }, stampedName('auction-backup','json'));
  toast('Backup downloaded.', 'success');
}

/* ---------------- destructive actions ----------------
   Rules are written per child (players/$id, squads/$teamId, …), so these
   delete by listing explicit child paths in one multi-path update rather
   than removing a whole top-level node. */

function confirmResetSession(){
  askConfirm({
    title: 'Reset the bidding session?',
    body: 'All players go back to <b>pending</b>, every squad is emptied, purses are restored and the results log is cleared. Teams, players and access keys are kept.',
    confirmLabel: 'Reset Session',
    run: async ()=>{
      const updates = {};
      aPlayers().forEach(p=>{
        updates['players/'+p.id+'/status'] = 'pending';
        updates['players/'+p.id+'/soldTo'] = null;
        updates['players/'+p.id+'/soldPrice'] = null;
      });
      aTeams().forEach(t=>{ updates['squads/'+t.id] = null; });
      await db.ref().update(updates);
      await db.ref('recentSales').remove();
      await db.ref('auction').remove();
      toast('Session reset — ready to run again.', 'success');
    }
  });
}

function confirmDeleteAllPlayers(){
  askConfirm({
    title: 'Delete all players?',
    body: `All <b>${aPlayers().length}</b> players are removed and every squad is emptied. Teams and budgets stay as they are.`,
    confirmLabel: 'Delete All Players',
    requireTyping: true,
    run: async ()=>{
      const updates = {};
      aPlayers().forEach(p=>{ updates['players/'+p.id] = null; });
      aTeams().forEach(t=>{ updates['squads/'+t.id] = null; });
      await db.ref().update(updates);
      await db.ref('recentSales').remove();
      await db.ref('auction').remove();
      toast('All players deleted.');
    }
  });
}

function confirmDeleteAllTeams(){
  askConfirm({
    title: 'Delete all teams?',
    body: `All <b>${aTeams().length}</b> teams, their squads and their access keys are removed. Any players they had bought go back to pending.`,
    confirmLabel: 'Delete All Teams',
    requireTyping: true,
    run: async ()=>{
      const updates = {};
      aPlayers().forEach(p=>{
        if(p.status==='sold'){
          updates['players/'+p.id+'/status'] = 'pending';
          updates['players/'+p.id+'/soldTo'] = null;
          updates['players/'+p.id+'/soldPrice'] = null;
          updates['recentSales/'+p.id] = null; // back to pending — their sold row no longer applies
        }
      });
      aTeams().forEach(t=>{ updates['squads/'+t.id] = null; updates['teams/'+t.id] = null; });
      aKeys().filter(k=>k.role==='team').forEach(k=>{ updates['accessKeys/'+k.key] = null; });
      await db.ref().update(updates);
      await db.ref('auction').remove();
      toast('All teams deleted.');
    }
  });
}

function confirmDeleteModerators(){
  const modKeys = aKeys().filter(k=>k.role==='moderator');
  askConfirm({
    title: 'Delete all moderator keys?',
    body: `<b>${modKeys.length}</b> moderator key${modKeys.length===1?'':'s'} will be removed. Whoever is running the console is locked out on their next reload — generate a new key to let someone back in. The auction data itself is untouched.`,
    confirmLabel: 'Delete Moderator Keys',
    run: async ()=>{
      const updates = {};
      modKeys.forEach(k=>{ updates['accessKeys/'+k.key] = null; });
      await db.ref().update(updates);
      toast('Moderator keys deleted.');
    }
  });
}

function confirmWipeAll(){
  askConfirm({
    title: 'Wipe everything?',
    body: 'Players, teams, squads, the live auction, the results log and <b>every access key</b> are deleted. Only your organizer login and the global settings survive. Download a backup first if you might want this back.',
    confirmLabel: 'Wipe Everything',
    requireTyping: true,
    run: async ()=>{
      const updates = {};
      aPlayers().forEach(p=>{ updates['players/'+p.id] = null; });
      aTeams().forEach(t=>{ updates['squads/'+t.id] = null; updates['teams/'+t.id] = null; });
      aKeys().forEach(k=>{ updates['accessKeys/'+k.key] = null; });
      await db.ref().update(updates);
      await db.ref('recentSales').remove();
      await db.ref('auction').remove();
      toast('Everything wiped.');
    }
  });
}

/**
 * Shared confirmation modal. `requireTyping` makes the operator type DELETE
 * before the button turns on — for the ones that throw away real work.
 */
let pendingConfirm = null;
function askConfirm({title, body, confirmLabel, requireTyping, run}){
  pendingConfirm = run;
  showModal(`
    <h3>${title}</h3>
    <p style="font-size:13px;color:var(--cream-dim);line-height:1.6;">${body}</p>
    ${requireTyping ? `
    <div class="field confirm-input">
      <label>Type DELETE to confirm</label>
      <input type="text" id="confirmWord" autocomplete="off" oninput="document.getElementById('confirmGo').disabled = this.value.trim().toUpperCase()!=='DELETE';">
    </div>` : ''}
    <div class="modal-actions">
      <button class="ghost sm" onclick="closeModal()">Cancel</button>
      <button class="danger sm" id="confirmGo" ${requireTyping?'disabled':''} onclick="runPendingConfirm(this)">${confirmLabel}</button>
    </div>
  `);
}
async function runPendingConfirm(btn){
  if(!pendingConfirm) return;
  btn.disabled = true; btn.textContent = 'Working…';
  try{
    await pendingConfirm();
    closeModal();
  }catch(e){
    console.error('Action failed:', e);
    toast('Failed: '+e.message, 'error');
    btn.disabled = false; btn.textContent = 'Retry';
  }finally{
    pendingConfirm = null;
  }
}

render();
