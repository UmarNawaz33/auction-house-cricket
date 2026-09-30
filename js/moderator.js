/* ============================================================
   moderator.js — gated by a moderator key. Runs the auction:
   teams, players, the live lot, releases and the results log.
   The moderator does NOT bid — only team owners place bids from
   their own portals. Writes go straight to Firebase; Database
   Rules re-check the moderator role server-side on every write.
   ============================================================ */

let session = getSession();
let activeTab = 'setup';
let playerFilter = {q:'', cat:'', status:''};

let mstate = { settings:{}, teams:{}, players:{}, auction:{}, recentSales:{} };

const TABS = [
  {id:'setup', label:'Setup'},
  {id:'players', label:'Players'},
  {id:'auction', label:'Auction Floor'},
  {id:'results', label:'Live Results'},
  {id:'teams', label:'Teams'},
  {id:'summary', label:'Summary'}
];

/* ---------------- Gate ---------------- */
function renderTopActions(){
  const el = document.getElementById('topActions');
  if(!el) return;
  el.innerHTML = session
    ? `<span class="top-actions session-info">${escapeAttr(session.label||'Moderator')} · <span id="connBadge2"></span></span><button class="danger sm" onclick="doSignOut()">Sign Out</button>`
    : '';
}

/**
 * Signing out pauses the auction so nobody can bid while the console is
 * unattended. The session itself stays in Firebase, so signing back in with
 * the same moderator key picks up exactly where it left off.
 */
async function doSignOut(){
  try{
    await pauseSession('signout');
  }catch(e){
    console.error('Could not pause the auction before signing out:', e);
  }
  await signOutAll();
  session = null;
  renderRoot();
}

/** Close bidding and remember why. `reason` is 'manual' | 'signout' | 'disconnect'. */
async function pauseSession(reason){
  if(!sessionInProgress(mstate.auction)) return; // nothing running
  await db.ref('auction').update({
    paused:true, biddingOpen:false, pausedAt:Date.now(), pauseReason:reason||'manual', callState:null
  });
}

/** The moderator's own Pause button. */
async function pauseBidding(){
  await pauseSession('manual');
  toast('Bidding paused — team owners can\'t bid until you resume.');
}

async function resumeSession(){
  const auc = mstate.auction || {};
  await db.ref('auction').update({
    paused:false,
    pausedAt:null,
    pauseReason:null,
    biddingOpen: !!auc.currentPlayerId
  });
  toast('Auction resumed — team owners can bid again.', 'success');
}

/* ---------------- Ending and restarting the session ---------------- */

function confirmCompleteBidding(){
  const auc = mstate.auction || {};
  const player = auc.currentPlayerId ? getPlayer(auc.currentPlayerId) : null;
  const pending = playersArr().filter(p=>p.status==='pending').length;
  showModal(`
    <h3>Complete the bidding session?</h3>
    <p style="font-size:13px;color:var(--cream-dim);line-height:1.6;">
      The live view goes back to its home screen and shows that no auction is running — spectators can still open the previous results from there.
      ${player ? `<br><br><b>${player.name}</b> is on the block right now and will be left unsold.` : ''}
      ${pending ? `<br><br><b>${pending}</b> player${pending===1?'':'s'} ${pending===1?'is':'are'} still pending and won't be auctioned.` : ''}
      <br><br>All results are kept, and you can reopen the auction afterwards.
    </p>
    <div class="modal-actions">
      <button class="ghost sm" onclick="closeModal()">Cancel</button>
      <button class="primary sm" onclick="completeBidding()">Complete Session</button>
    </div>`);
}

async function completeBidding(){
  closeModal();
  await db.ref('auction').update({
    currentPlayerId:null, currentPrice:0, leaderTeamId:null,
    biddingOpen:false, paused:false, pausedAt:null, pauseReason:null,
    awaitingNext:false, excludeId:null, lastResult:null, callState:null,
    completed:true, completedAt:Date.now(), updatedAt:Date.now()
  });
  toast('Bidding complete. The live view is back on its home screen.', 'success');
}

async function reopenAuction(){
  await db.ref('auction').update({
    completed:false, completedAt:null,
    awaitingNext:false, paused:false, pausedAt:null, pauseReason:null,
    biddingOpen:false, callState:null, updatedAt:Date.now()
  });
  toast('Auction reopened — put up a player to start bidding again.', 'success');
}

function renderRoot(){
  renderTopActions();
  const nav = document.getElementById('tabNav');
  const c = document.getElementById('tabContent');
  if(!session || session.role!=='moderator'){
    nav.innerHTML='';
    c.innerHTML = renderGate();
    return;
  }
  nav.innerHTML = renderTabNav(TABS, activeTab, 'setTab');
  if(activeTab==='setup') c.innerHTML = renderSetup();
  else if(activeTab==='players') c.innerHTML = renderPlayers();
  else if(activeTab==='auction') c.innerHTML = renderAuction();
  else if(activeTab==='results') c.innerHTML = renderResults();
  else if(activeTab==='teams') c.innerHTML = renderTeams();
  else if(activeTab==='summary') c.innerHTML = renderSummary();
  watchConnection('connBadge2');
}
function setTab(id){ activeTab=id; renderRoot(); window.scrollTo({top:0,behavior:'smooth'}); }

function renderGate(){
  return `
  <div class="gate-wrap">
    <div class="gate-box">
      <div class="paddle-lg">M</div>
      <h2>Moderator Access</h2>
      <p class="sub">Enter the moderator key given to you by the organizer. If an auction was already running under this key, you'll be able to resume it.</p>
      <input type="text" id="modKeyInput" placeholder="MOD-XXXXXX" maxlength="20">
      <button class="primary block" style="margin-top:12px;" onclick="enterModKey()">Unlock Console</button>
      <div class="gate-error" id="gateErr"></div>
    </div>
  </div>`;
}
async function enterModKey(){
  const errEl = document.getElementById('gateErr');
  errEl.textContent='';
  try{
    const s = await claimKey(document.getElementById('modKeyInput').value);
    if(s.role!=='moderator'){ throw new Error('That key is not a moderator key.'); }
    session = s;
    attachListeners();
    armDisconnectPause(); // new anonymous uid, so re-register it
    renderRoot();
  }catch(e){ errEl.textContent = e.message; }
}

if(session && session.role==='moderator'){ ensureAnonymousAuth().then(attachListeners); }

let listenersAttached = false;
function attachListeners(){
  if(listenersAttached) return;
  listenersAttached = true;
  db.ref('settings').on('value', s=>{ mstate.settings = s.val() || defaultSettings(); window.__settingsCache=mstate.settings; renderRoot(); });
  db.ref('teams').on('value', s=>{ mstate.teams = s.val() || {}; renderRoot(); });
  db.ref('squads').on('value', s=>{
    const squads = s.val() || {};
    Object.keys(mstate.teams).forEach(id=>{ if(mstate.teams[id]) mstate.teams[id].squad = squads[id]||{}; });
    renderRoot();
  });
  db.ref('players').on('value', s=>{ mstate.players = s.val() || {}; renderRoot(); });
  db.ref('auction').on('value', s=>{ mstate.auction = s.val() || {}; renderRoot(); });
  db.ref('recentSales').on('value', s=>{ mstate.recentSales = s.val() || {}; renderRoot(); });
  armDisconnectPause();
}

/**
 * If the console closes or drops off the network, pause the auction
 * server-side so bidding can't carry on unsupervised. Firebase re-sends this
 * on reconnect, but it has to be re-armed after a fresh sign-in because that
 * creates a new anonymous uid.
 */
function armDisconnectPause(){
  db.ref('auction').onDisconnect().update({paused:true, biddingOpen:false, pauseReason:'disconnect', callState:null});
}
function defaultSettings(){
  return {numTeams:8, defaultBudget:100, defaultBasePrice:5, bidIncrement:1, maxPlayersPerTeam:18, minPlayersPerTeam:14, currencyUnit:'Cr'};
}

/* ---------------- helpers over live data ---------------- */
function teamsArr(){ return Object.entries(mstate.teams).map(([id,t])=>({id, ...t})); }
function playersArr(){ return Object.entries(mstate.players).map(([id,p])=>({id, ...p})); }
function getTeam(id){ return id && mstate.teams[id] ? {id, ...mstate.teams[id]} : null; }
function getPlayer(id){ return id && mstate.players[id] ? {id, ...mstate.players[id]} : null; }
function categories(){
  const set = new Set(playersArr().map(p=>p.category).filter(Boolean));
  ['Batsman','Bowler','All-Rounder','Wicket-Keeper'].forEach(c=>set.add(c));
  return Array.from(set);
}

/* ---------------- photo picker (shared by add + edit) ----------------
   The browser can't write into the repo's images/ folder, so picking a
   file only fills in the path and shows a preview — the file itself has
   to be dropped into images/ and committed. */
function onPhotoPick(input, pathFieldId, previewId){
  const file = input.files && input.files[0];
  if(!file) return;
  const path = imagePathFromFileName(file.name);
  const field = document.getElementById(pathFieldId);
  if(field) field.value = path;
  const prev = document.getElementById(previewId);
  if(prev) prev.src = URL.createObjectURL(file);
  toast('Now copy "'+file.name+'" into the images/ folder and commit it.', 'success');
}
function onPhotoPathInput(value, previewId){
  const prev = document.getElementById(previewId);
  if(prev) prev.src = playerImageSrc({image:value});
}
function photoPickerHtml(ids, currentPath){
  return `
  <div class="field">
    <label>Player Photo</label>
    <div class="photo-picker">
      <img class="preview" id="${ids.preview}" src="${escapeAttr(playerImageSrc({image:currentPath}))}" alt=""
        onerror="this.onerror=null;this.src='${DEFAULT_PLAYER_IMAGE}';">
      <div class="fields">
        <input type="file" accept="image/*" id="${ids.file}" onchange="onPhotoPick(this,'${ids.path}','${ids.preview}')">
        <input type="text" id="${ids.path}" value="${escapeAttr(currentPath||'')}" placeholder="images/default.png"
          style="margin-top:6px;text-transform:none;letter-spacing:normal;"
          oninput="onPhotoPathInput(this.value,'${ids.preview}')">
      </div>
    </div>
    <p class="hint">Put the image file in the <b>images/</b> folder of the project and commit it — only this path is saved to Firebase, so photos keep working on GitHub Pages. Leave blank to use <b>images/default.png</b>.</p>
  </div>`;
}

/* ============================ SETUP TAB ============================ */
function renderSetup(){
  const s = mstate.settings;
  const teams = teamsArr();
  return `
  <div class="grid cols-2">
    <div class="card">
      <h2>Global Settings</h2>
      <div class="grid cols-2">
        <div class="field"><label>Number of Teams</label><input type="number" min="1" id="cfgNumTeams" value="${s.numTeams}"></div>
        <div class="field"><label>Default Budget / Team</label><input type="number" min="0" id="cfgBudget" value="${s.defaultBudget}"></div>
        <div class="field"><label>Default Base Price</label><input type="number" min="0" step="0.5" id="cfgBasePrice" value="${s.defaultBasePrice}"></div>
        <div class="field"><label>Bid Increment</label><input type="number" min="0.5" step="0.5" id="cfgIncrement" value="${s.bidIncrement}"></div>
        <div class="field"><label>Max Players / Team</label><input type="number" min="1" id="cfgMaxP" value="${s.maxPlayersPerTeam}"></div>
        <div class="field"><label>Min Players / Team</label><input type="number" min="0" id="cfgMinP" value="${s.minPlayersPerTeam}"></div>
        <div class="field"><label>Currency Unit</label><input type="text" id="cfgCurrency" value="${s.currencyUnit}" placeholder="Cr / Lakh / $"></div>
      </div>
      <button class="primary block" onclick="saveSettings()">Save Settings</button>
      <p class="hint">Reserve rule: a team must always keep enough budget to buy its remaining minimum-required players at the default base price.</p>
    </div>
    <div class="card">
      <h2>Generate Teams</h2>
      <p class="hint">Creates <b>${s.numTeams}</b> teams, each with a budget of <b>${fmtMoney(s.defaultBudget)}</b>.</p>
      <button class="primary block" onclick="generateTeams()">Generate / Refresh Teams</button>
      <div style="margin-top:14px;"><button class="block" onclick="addSingleTeam()">+ Add One Team</button></div>
    </div>
  </div>

  <div class="card">
    <h2>Teams <span class="n">${teams.length}</span></h2>
    ${teams.length===0 ? `<div class="empty-state"><div class="icn">🏏</div>No teams yet.</div>` : `
    <div class="table-wrap">
    <table>
      <thead><tr><th>Team Name</th><th>Budget</th><th>Squad</th><th></th></tr></thead>
      <tbody>
        ${teams.map(t=>`
          <tr>
            <td><input type="text" value="${escapeAttr(t.name)}" onchange="renameTeam('${t.id}', this.value)" style="min-width:160px;"></td>
            <td><input type="number" value="${t.budget}" min="0" onchange="rebudgetTeam('${t.id}', this.value)" style="width:110px;"></td>
            <td>${squadCountOf(t)} player${squadCountOf(t)===1?'':'s'}</td>
            <td><button class="danger sm" onclick="removeTeam('${t.id}')">Remove</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    </div>`}
  </div>
  `;
}
async function saveSettings(){
  const s = {
    numTeams: Math.max(1, parseInt(document.getElementById('cfgNumTeams').value)||mstate.settings.numTeams),
    defaultBudget: parseFloat(document.getElementById('cfgBudget').value)||0,
    defaultBasePrice: parseFloat(document.getElementById('cfgBasePrice').value)||0,
    bidIncrement: parseFloat(document.getElementById('cfgIncrement').value)||1,
    maxPlayersPerTeam: parseInt(document.getElementById('cfgMaxP').value)||1,
    minPlayersPerTeam: parseInt(document.getElementById('cfgMinP').value)||0,
    currencyUnit: document.getElementById('cfgCurrency').value.trim()||'Cr'
  };
  await db.ref('settings').set(s);
  toast('Settings saved.', 'success');
}
async function generateTeams(){
  const want = mstate.settings.numTeams;
  const cur = teamsArr();
  const updates = {};
  if(want > cur.length){
    for(let i=cur.length;i<want;i++){
      const id = db.ref('teams').push().key;
      updates['teams/'+id] = {name:'Team '+(i+1), budget:mstate.settings.defaultBudget};
    }
    await db.ref().update(updates);
  } else if(want < cur.length){
    const toRemove = cur.slice(want);
    for(const t of toRemove){ await db.ref('teams/'+t.id).remove(); await db.ref('squads/'+t.id).remove(); }
  }
  toast('Teams generated.', 'success');
}
async function addSingleTeam(){
  const id = db.ref('teams').push().key;
  await db.ref('teams/'+id).set({name:'Team '+(teamsArr().length+1), budget:mstate.settings.defaultBudget});
}
async function renameTeam(id, val){ if(val.trim()) await db.ref('teams/'+id+'/name').set(val.trim()); }
async function rebudgetTeam(id, val){
  const t = getTeam(id);
  const v = parseFloat(val);
  if(isNaN(v) || v<0){ toast('Invalid budget','error'); renderRoot(); return; }
  if(v < spentOf(t)){ toast('Budget cannot be less than amount already spent.', 'error'); renderRoot(); return; }
  await db.ref('teams/'+id+'/budget').set(v);
}
async function removeTeam(id){
  const t = getTeam(id);
  if(t && squadCountOf(t)>0){ toast('Release all players from this team before removing it.', 'error'); return; }
  await db.ref('teams/'+id).remove();
  await db.ref('squads/'+id).remove();
}

/* ============================ PLAYERS TAB ============================ */
function renderPlayers(){
  const s = mstate.settings;
  const all = playersArr();
  const pending = all.filter(p=>p.status==='pending').length;
  const sold = all.filter(p=>p.status==='sold').length;
  const unsold = all.filter(p=>p.status==='unsold').length;
  let list = all.filter(p=>{
    if(playerFilter.q && !p.name.toLowerCase().includes(playerFilter.q.toLowerCase())) return false;
    if(playerFilter.cat && p.category!==playerFilter.cat) return false;
    if(playerFilter.status && p.status!==playerFilter.status) return false;
    return true;
  });
  return `
  <div class="chip-row">
    <div class="chip"><div class="val">${all.length}</div><div class="lbl">Total Players</div></div>
    <div class="chip"><div class="val">${pending}</div><div class="lbl">Pending</div></div>
    <div class="chip"><div class="val">${sold}</div><div class="lbl">Sold</div></div>
    <div class="chip"><div class="val">${unsold}</div><div class="lbl">Unsold</div></div>
  </div>
  <div class="grid cols-2">
    <div class="card">
      <h2>Add Player</h2>
      <div class="field"><label>Name</label><input type="text" id="npName" placeholder="Player full name"></div>
      <div class="field-row">
        <div class="field"><label>Category</label><select id="npCategory">${categories().map(c=>`<option>${c}</option>`).join('')}</select></div>
        <div class="field"><label>Base Price</label><input type="number" id="npBase" value="${s.defaultBasePrice}" min="0" step="0.5"></div>
      </div>
      ${photoPickerHtml({file:'npPhotoFile', path:'npImage', preview:'npPreview'}, '')}
      <button class="primary block" onclick="addSinglePlayer()">+ Add Player</button>
    </div>
    <div class="card">
      <h2>Bulk Add Players</h2>
      <div class="field"><label>One player per line: Name, Category, Base Price, Photo file</label>
        <textarea id="bulkText" rows="6" placeholder="Virat Kohli, Batsman, 15, kohli.jpg
Jasprit Bumrah, Bowler, 12, bumrah.jpg
Ravindra Jadeja, All-Rounder"></textarea>
      </div>
      <p class="hint">Base price and photo are optional. A bare file name like <b>kohli.jpg</b> is stored as <b>images/kohli.jpg</b>; players without one use the default photo.</p>
      <button class="primary block" onclick="bulkAddPlayers()">+ Add All From List</button>
    </div>
  </div>
  <div class="card">
    <h2>Player Pool <span class="n">${list.length} shown</span></h2>
    <div class="field-row" style="margin-bottom:12px;">
      <div class="field"><label>Search</label><input type="text" value="${playerFilter.q}" oninput="playerFilter.q=this.value; renderRoot();"></div>
      <div class="field"><label>Category</label><select onchange="playerFilter.cat=this.value; renderRoot();"><option value="">All</option>${categories().map(c=>`<option ${playerFilter.cat===c?'selected':''}>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Status</label><select onchange="playerFilter.status=this.value; renderRoot();">
        <option value="">All</option><option value="pending" ${playerFilter.status==='pending'?'selected':''}>Pending</option>
        <option value="sold" ${playerFilter.status==='sold'?'selected':''}>Sold</option><option value="unsold" ${playerFilter.status==='unsold'?'selected':''}>Unsold</option>
      </select></div>
    </div>
    ${list.length===0 ? `<div class="empty-state"><div class="icn">📋</div>No players match.</div>` : `
    <div class="table-wrap"><table>
      <thead><tr><th>Player</th><th>Category</th><th>Base Price</th><th>Status</th><th>Sold To</th><th>Price</th><th></th></tr></thead>
      <tbody>
        ${list.map(p=>`
          <tr>
            <td><div class="p-cell">${playerImg(p,'sm')}<span class="p-name">${p.name}</span></div></td>
            <td><span class="badge cat">${p.category}</span></td><td>${fmtMoney(p.basePrice)}</td>
            <td><span class="badge ${p.status}">${p.status==='sold' ? soldLabel(mstate.recentSales[p.id]) : p.status}</span></td>
            <td>${p.status==='sold' ? (getTeam(p.soldTo)?.name||'—') : '—'}</td>
            <td>${p.status==='sold' ? fmtMoney(p.soldPrice) : '—'}</td>
            <td>
              ${p.status==='pending' ? `<button class="sm primary" onclick="assignPlayerPrompt('${p.id}')">Assign</button> ` : ''}
              <button class="sm" onclick="editPlayerPrompt('${p.id}')">Edit</button> <button class="sm danger" onclick="confirmDeletePlayer('${p.id}')">Del</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table></div>`}
  </div>`;
}
async function addSinglePlayer(){
  const name = document.getElementById('npName').value.trim();
  const category = document.getElementById('npCategory').value;
  const basePrice = parseFloat(document.getElementById('npBase').value) || mstate.settings.defaultBasePrice;
  const image = document.getElementById('npImage').value.trim();
  if(!name){ toast('Enter a player name.', 'error'); return; }
  const id = db.ref('players').push().key;
  await db.ref('players/'+id).set({name, category, basePrice, image, status:'pending', soldTo:null, soldPrice:null});
  document.getElementById('npName').value='';
  document.getElementById('npImage').value='';
  document.getElementById('npPhotoFile').value='';
  document.getElementById('npPreview').src = DEFAULT_PLAYER_IMAGE;
  toast(name+' added.', 'success');
}
async function bulkAddPlayers(){
  const raw = document.getElementById('bulkText').value;
  const lines = raw.split('\n').map(l=>l.trim()).filter(Boolean);
  if(lines.length===0){ toast('Paste at least one player line.', 'error'); return; }
  const updates = {};
  let count=0;
  lines.forEach(line=>{
    const parts = line.split(',').map(x=>x.trim());
    const name = parts[0];
    if(!name) return;
    const category = parts[1] || 'Other';
    const basePrice = parts[2] ? (parseFloat(parts[2])||mstate.settings.defaultBasePrice) : mstate.settings.defaultBasePrice;
    const image = parts[3] ? imagePathFromFileName(parts[3]) : '';
    const id = db.ref('players').push().key;
    updates['players/'+id] = {name, category, basePrice, image, status:'pending', soldTo:null, soldPrice:null};
    count++;
  });
  await db.ref().update(updates);
  document.getElementById('bulkText').value='';
  toast(count+' players added.', 'success');
}
function confirmDeletePlayer(id){
  const p = getPlayer(id);
  if(p && p.status==='sold'){
    const retained = soldLabel(mstate.recentSales[id]) === 'retained';
    showModal(`
      <h3>Delete ${retained?'retained':'sold'} player?</h3>
      <p style="font-size:13px;color:var(--cream-dim);line-height:1.5;">${p.name} is ${retained?'retained by':'sold to'} ${getTeam(p.soldTo)?.name||'a team'} for ${fmtMoney(p.soldPrice)}. Deleting refunds that team. Use "Return to Pool" in Edit instead if you want them re-auctioned.</p>
      <div class="modal-actions"><button class="ghost sm" onclick="closeModal()">Cancel</button><button class="danger sm" onclick="deletePlayer('${id}'); closeModal();">Confirm</button></div>
    `);
  } else { deletePlayer(id); }
}
async function deletePlayer(id){
  const p = getPlayer(id);
  if(p && p.status==='sold' && p.soldTo){ await db.ref('squads/'+p.soldTo+'/'+id).remove(); }
  await db.ref('players/'+id).remove();
  await db.ref('recentSales/'+id).remove(); // a deleted player shouldn't linger in the results log
  if(mstate.auction.currentPlayerId===id){ await db.ref('auction').update({currentPlayerId:null, currentPrice:0, leaderTeamId:null, biddingOpen:false}); }
}
function editPlayerPrompt(id){
  const p = getPlayer(id);
  const statusInfo = p.status==='sold' ? `<p class="hint">Currently <b>${soldLabel(mstate.recentSales[id])}</b> ${soldLabel(mstate.recentSales[id])==='retained'?'by':'to'} <b>${getTeam(p.soldTo)?.name||'—'}</b> for ${fmtMoney(p.soldPrice)}.</p>`
    : p.status==='unsold' ? `<p class="hint">Currently marked <b>unsold</b>.</p>` : '';
  showModal(`
    <h3>Edit Player</h3>
    <div class="field"><label>Name</label><input type="text" id="epName" value="${escapeAttr(p.name)}"></div>
    <div class="field"><label>Category</label><select id="epCat">${categories().map(c=>`<option ${c===p.category?'selected':''}>${c}</option>`).join('')}</select></div>
    <div class="field"><label>Base Price</label><input type="number" id="epBase" value="${p.basePrice}" min="0" step="0.5"></div>
    ${photoPickerHtml({file:'epPhotoFile', path:'epImage', preview:'epPreview'}, p.image||'')}
    ${statusInfo}
    <div class="modal-actions" style="justify-content:${p.status!=='pending'?'space-between':'flex-end'};">
      ${p.status!=='pending' ? `<button class="sm danger" onclick="returnToPool('${id}')">↺ Return to Auction Pool</button>` : ''}
      <div style="display:flex;gap:10px;"><button class="ghost sm" onclick="closeModal()">Cancel</button><button class="primary sm" onclick="saveEditPlayer('${id}')">Save</button></div>
    </div>
  `);
}
async function saveEditPlayer(id){
  const name = document.getElementById('epName').value.trim();
  const category = document.getElementById('epCat').value;
  const basePrice = parseFloat(document.getElementById('epBase').value);
  const image = document.getElementById('epImage').value.trim();
  const updates = {};
  if(name) updates['players/'+id+'/name'] = name;
  updates['players/'+id+'/category'] = category;
  updates['players/'+id+'/image'] = image;
  if(!isNaN(basePrice)) updates['players/'+id+'/basePrice'] = basePrice;
  await db.ref().update(updates);
  closeModal();
}
async function returnToPool(id){
  const p = getPlayer(id);
  if(p.status==='sold' && p.soldTo){ await db.ref('squads/'+p.soldTo+'/'+id).remove(); }
  await db.ref('players/'+id).update({status:'pending', soldTo:null, soldPrice:null});
  await db.ref('recentSales/'+id).remove(); // back to pending — their old sold/unsold row no longer applies
  closeModal();
  toast(p.name+' returned to the pool for re-auction.', 'success');
}

/**
 * Assign a still-pending player straight to a team at a chosen price,
 * without putting them up on the live floor — for pre-auction retentions,
 * or any other manual sign-off the moderator wants to record before bidding
 * starts. Ends up in exactly the same state a normal SOLD does (squad,
 * player status, the results log), so it shows up everywhere a real sale
 * would: the Teams tab, Live Results, Summary, and every export.
 */
function assignPlayerPrompt(id){
  const p = getPlayer(id);
  if(!p || p.status!=='pending'){ return; }
  if(mstate.auction.currentPlayerId===id){
    toast('This player is currently on the auction floor — finish that lot first.', 'error');
    return;
  }
  const teams = teamsArr();
  if(teams.length===0){ toast('Create teams first, in the Setup tab.', 'error'); return; }
  showModal(`
    <h3>Assign ${escapeAttr(p.name)}</h3>
    <p class="hint" style="margin-bottom:14px;">For a retained player, or any pre-auction assignment — this records it immediately, without going through the live floor.</p>
    <div class="field"><label>Team</label>
      <select id="asTeam">${teams.map(t=>`<option value="${t.id}">${escapeAttr(t.name)} — ${fmtMoney(remainingOf(t))} left</option>`).join('')}</select>
    </div>
    <div class="field"><label>Price</label><input type="number" id="asPrice" min="0" step="0.5" value="${p.basePrice}"></div>
    <div class="gate-error" id="asErr"></div>
    <div class="modal-actions">
      <button class="ghost sm" onclick="closeModal()">Cancel</button>
      <button class="primary sm" onclick="confirmAssignPlayer('${id}')">Assign</button>
    </div>
  `);
}
async function confirmAssignPlayer(id){
  const p = getPlayer(id);
  const teamId = document.getElementById('asTeam').value;
  const price = parseFloat(document.getElementById('asPrice').value);
  const errEl = document.getElementById('asErr');
  const team = getTeam(teamId);
  if(!team){ errEl.textContent = 'Pick a team.'; return; }
  if(isNaN(price) || price<0){ errEl.textContent = 'Enter a valid price.'; return; }
  if(!teamCanAffordBid(team, mstate.settings, price)){
    errEl.textContent = team.name+" can't take this player — check their purse, the reserve for their minimum squad, or their squad size limit.";
    return;
  }
  const updates = {};
  updates['players/'+p.id+'/status'] = 'sold';
  updates['players/'+p.id+'/soldTo'] = team.id;
  updates['players/'+p.id+'/soldPrice'] = price;
  updates['squads/'+team.id+'/'+p.id] = {price};
  updates['recentSales/'+p.id] = saleRecord(p, team, price, 'sold', 'assigned');
  await db.ref().update(updates);
  closeModal();
  toast(p.name+' assigned to '+team.name+' for '+fmtMoney(price), 'success');
}

/* ============================ AUCTION TAB ============================ */
function renderAuction(){
  const teams = teamsArr();
  if(teams.length===0){ return `<div class="card"><div class="empty-state"><div class="icn">👥</div>Create teams in Setup first.</div></div>`; }

  const auc = mstate.auction || {};
  const pending = playersArr().filter(p=>p.status==='pending');
  const paused = isPaused(auc) && sessionInProgress(auc);

  // The moderator called time on the session.
  if(isCompleted(auc)){
    const sales = salesArray(mstate.recentSales);
    return `
    <div class="status-banner done">
      <div class="icn">🏁</div>
      <div class="txt">
        <div class="ttl">Bidding Complete</div>
        <div class="sub">Closed${auc.completedAt ? ' at '+fmtTime(auc.completedAt) : ''}. The live view is on its home screen — spectators can still open the previous results from there. ${pending.length ? `<b>${pending.length}</b> player${pending.length===1?'':'s'} left unauctioned.` : 'Every player was auctioned.'}</div>
      </div>
      <button class="primary xl" onclick="reopenAuction()">↺ Reopen Auction</button>
    </div>
    <div class="chip-row">
      <div class="chip"><div class="val">${sales.filter(r=>r.result==='sold').length}</div><div class="lbl">Sold</div></div>
      <div class="chip"><div class="val">${sales.filter(r=>r.result==='unsold').length}</div><div class="lbl">Unsold</div></div>
      <div class="chip"><div class="val">${pending.length}</div><div class="lbl">Never Called</div></div>
      <div class="chip"><div class="val">${fmtMoney(sales.reduce((s,r)=>s+(r.price||0),0))}</div><div class="lbl">Total Spend</div></div>
    </div>
    ${renderResultsCard()}`;
  }

  const pauseNote = auc.pauseReason==='signout' ? 'The console was signed out.'
    : auc.pauseReason==='disconnect' ? 'The console closed or lost its connection.'
    : 'You paused the bidding.';
  const pausedBanner = paused ? `
    <div class="status-banner paused">
      <div class="icn">⏸</div>
      <div class="txt">
        <div class="ttl">Bidding Paused</div>
        <div class="sub">${pauseNote} Team owners can't bid${auc.pausedAt ? ' since '+fmtTime(auc.pausedAt) : ''}. Everything is saved — resume to carry on from exactly where you left off.</div>
      </div>
      <button class="primary xl" onclick="resumeSession()">▶ Resume Session</button>
    </div>` : '';

  // A result was just recorded — nothing is on the block until "Next Player".
  if(auc.awaitingNext){
    const last = auc.lastResult || null;
    // The one skipped player is all that's left, so Next will re-offer them.
    const onlySkippedLeft = pending.length===1 && pending[0].id===auc.excludeId;
    return `
    ${pausedBanner}
    ${last ? `
    <div class="status-banner ${last.result==='sold'?'done':'waiting'}">
      <div class="icn">${last.result==='sold'?'✅':'❌'}</div>
      <div class="txt">
        <div class="ttl">${last.name} — ${last.result==='sold' ? 'SOLD' : last.result==='unsold' ? 'UNSOLD' : 'SKIPPED'}</div>
        <div class="sub">${last.result==='sold' ? `Bought by <b>${last.team}</b> for <b>${fmtMoney(last.price)}</b>.` : last.result==='unsold' ? 'No bids were placed for this player.' : 'Put back in the pool for later.'}</div>
      </div>
    </div>` : ''}
    ${pending.length===0 ? renderAllDonePanel() : `
    <div class="card" style="text-align:center;">
      <h2 style="justify-content:center;">Ready For The Next Lot</h2>
      <p class="hint" style="margin-bottom:16px;">${pending.length} player${pending.length===1?'':'s'} still in the pool. Everyone watching sees a "next player coming up" message until you press this.</p>
      <button class="primary xl" onclick="nextPlayer()" ${paused?'disabled':''}>▶ Next Player</button>
      ${paused ? `<p class="hint" style="margin-top:10px;">Resume the session first.</p>` : ''}
      ${onlySkippedLeft ? `<p class="hint" style="margin-top:10px;">Only the skipped player is left — pressing Next will put them back up.</p>` : ''}
      <div class="floor-controls" style="margin-top:16px;">
        <button onclick="confirmCompleteBidding()">🏁 Complete Bidding Session</button>
      </div>
    </div>`}
    ${renderResultsCard(6)}`;
  }

  // Nothing running at all.
  if(!auc.currentPlayerId){
    if(pending.length===0){
      const anyPlayers = playersArr().length>0;
      return `${pausedBanner}${anyPlayers
        ? renderAllDonePanel()
        : `<div class="card"><div class="empty-state"><div class="icn">📋</div>No players in the pool yet — add some in the <b>Players</b> tab.</div></div>`}`;
    }
    return `
    ${pausedBanner}
    <div class="card">
      <h2>Start Auction</h2>
      <p class="hint">${pending.length} pending player${pending.length===1?'':'s'} available. A random one is put up each time. Team owners place all bids from their own portals — you confirm the result.</p>
      <button class="primary xl" onclick="nextPlayer()">▶ Put Up First Player</button>
    </div>
    ${renderResultsCard(6)}`;
  }

  const player = getPlayer(auc.currentPlayerId);
  if(!player){ return `${pausedBanner}<div class="card"><div class="empty-state"><div class="icn">⚠</div>The player on the block was deleted. <button class="primary sm" onclick="nextPlayer()">Put up another</button></div></div>`; }

  const totalOriginal = playersArr().length;
  const doneCount = playersArr().filter(p=>p.status!=='pending').length;
  const remainingCount = Math.max(0, pending.length - 1);
  const pct = totalOriginal ? Math.round((doneCount/totalOriginal)*100) : 0;
  const leader = auc.leaderTeamId ? getTeam(auc.leaderTeamId) : null;

  const teamsHtml = teams.map(t=>{
    const isLeader = t.id===auc.leaderTeamId;
    const nextPrice = (auc.currentPrice||0) === 0 ? player.basePrice : (auc.currentPrice + mstate.settings.bidIncrement);
    const canAfford = teamCanAffordBid(t, mstate.settings, nextPrice);
    const rem = remainingOf(t);
    const pctBar = Math.max(0,Math.min(100,(rem/t.budget)*100));
    return `
    <div class="team-box readonly ${isLeader?'leader':''} ${!canAfford && !isLeader?'disabled':''}">
      ${isLeader?'<span class="tag-leader">LEADING</span>':''}
      <div class="tname">${t.name}</div>
      <div class="tstat"><span>Purse</span><span>${fmtMoney(rem)}</span></div>
      <div class="tstat"><span>Squad</span><span>${squadCountOf(t)}/${mstate.settings.maxPlayersPerTeam}</span></div>
      <div class="barbg"><div class="barfg" style="width:${pctBar}%;"></div></div>
    </div>`;
  }).join('');

  return `
  ${pausedBanner}
  <div class="progress-outer"><div class="progress-inner" style="width:${pct}%;"></div></div>
  <p class="hint" style="margin-top:-8px;margin-bottom:16px;">${doneCount} of ${totalOriginal} players processed (${pct}%)</p>
  <div class="floor">
    <div class="card pv-lot">
      ${lotMarkup(player, {
        eyebrow: paused
          ? `Player ${doneCount+1} / ${totalOriginal} &middot; bidding paused`
          : `<span class="pv-live-dot"></span>Player ${doneCount+1} / ${totalOriginal} &middot; On the block`,
        price: auc.currentPrice || player.basePrice,
        leader: leader,
        extra: `
          <div class="pv-bid-actions">
            <div class="floor-controls">
              <button class="primary" style="background:linear-gradient(180deg,#6EE7A0,#17A34A);color:#04270F;" onclick="markSold()" ${!leader?'disabled':''}>✅ SOLD</button>
              <button class="danger" onclick="markUnsold()">❌ UNSOLD</button>
              <button onclick="skipPlayer()">⏭ Skip For Now</button>
              <button onclick="resetBid()" ${!leader?'disabled':''}>↺ Reset Bid</button>
            </div>
            <div class="floor-controls" style="margin-top:10px;align-items:center;">
              <button onclick="callOnce()" ${!leader||paused?'disabled':''}>🔨 Going Once</button>
              <button onclick="callTwice()" ${!leader||paused?'disabled':''}>🔨 Going Twice</button>
              ${auc.callState ? `<button class="ghost" onclick="cancelCall()">✖ Cancel Call</button>
                <span class="hint" style="font-weight:700;color:var(--pv-orange-l);">Calling: ${auc.callState==='twice'?'GOING TWICE':'GOING ONCE'} — shown on the big screen and team portals</span>` : ''}
            </div>
            <div class="floor-controls" style="margin-top:10px;">
              ${paused
                ? `<button class="primary" onclick="resumeSession()">▶ Resume Bidding</button>`
                : `<button onclick="pauseBidding()">⏸ Pause Bidding</button>`}
              <button onclick="confirmCompleteBidding()">🏁 Complete Bidding Session</button>
            </div>
            <p class="pv-bid-note">${paused
              ? 'Bidding is paused — team owners cannot bid until you resume.'
              : 'Bids come only from the team portals — this console records the outcome.'}</p>
          </div>`
      })}
    </div>
    <div class="card">
      <h2>Team Purses <span class="n">live</span></h2>
      <p class="hint" style="margin-bottom:10px;">Read-only. Dimmed teams can't afford the next bid or are full.</p>
      <div class="team-grid">${teamsHtml}</div>
    </div>
    ${renderResultsCard(6)}
    <div class="card"><h2>Remaining Pool <span class="n">${remainingCount}</span></h2><p class="hint">${remainingCount>0 ? `${remainingCount} player${remainingCount===1?'':'s'} still waiting.` : 'This is the last player left in the pool.'}</p></div>
  </div>`;
}

/**
 * Every player has been through the hammer. This is the end of the auction,
 * so completing the session is the main thing left to do.
 */
function renderAllDonePanel(){
  const sales = salesArray(mstate.recentSales);
  const sold = sales.filter(r=>r.result==='sold');
  const spend = sold.reduce((s,r)=>s+(r.price||0),0);
  return `
  <div class="card" style="text-align:center;">
    <div style="font-size:46px;line-height:1;margin-bottom:8px;">🏆</div>
    <h2 style="justify-content:center;">All Players Auctioned</h2>
    <p class="hint" style="margin-bottom:18px;max-width:520px;margin-left:auto;margin-right:auto;">
      Nothing left in the pool. Complete the session to close the auction — the live view drops back to its
      home screen and spectators get a button to look back over these results.
    </p>
    <div class="chip-row" style="justify-content:center;">
      <div class="chip"><div class="val">${sold.length}</div><div class="lbl">Sold</div></div>
      <div class="chip"><div class="val">${sales.length-sold.length}</div><div class="lbl">Unsold</div></div>
      <div class="chip"><div class="val">${fmtMoney(spend)}</div><div class="lbl">Total Spend</div></div>
    </div>
    <button class="primary xl" onclick="confirmCompleteBidding()">🏁 Complete Bidding Session</button>
    <p class="hint" style="margin-top:12px;">Nothing is deleted, and you can reopen the auction afterwards.</p>
  </div>`;
}

/** Pick a random pending player and open bidding on them. */
async function nextPlayer(){
  const auc = mstate.auction || {};
  const exclude = auc.excludeId || null;
  let pending = playersArr().filter(p=>p.status==='pending');
  if(pending.length===0){
    await db.ref('auction').set({currentPlayerId:null, currentPrice:0, leaderTeamId:null, biddingOpen:false, paused:false, awaitingNext:true, lastResult:auc.lastResult||null, updatedAt:Date.now()});
    toast('No players left in the pool.');
    return;
  }
  // Don't immediately re-offer a skipped player unless they're all that's left.
  const withoutSkipped = pending.filter(p=>p.id!==exclude);
  if(withoutSkipped.length) pending = withoutSkipped;
  const pick = pending[Math.floor(Math.random()*pending.length)];
  await db.ref('auction').set({
    currentPlayerId:pick.id, currentPrice:0, leaderTeamId:null,
    biddingOpen:true, paused:false, awaitingNext:false,
    excludeId:null, lastResult:null, updatedAt:Date.now()
  });
}

/** Record a result and hold the floor until the moderator calls the next lot. */
async function holdForNext(record, extra){
  await db.ref('auction').update(Object.assign({
    currentPlayerId:null, currentPrice:0, leaderTeamId:null,
    biddingOpen:false, awaitingNext:true, lastResult:record, callState:null, updatedAt:Date.now()
  }, extra||{}));
}

async function resetBid(){ await db.ref('auction').update({currentPrice:0, leaderTeamId:null, callState:null}); }

/* ---------------- "Going once… going twice…" ----------------
   A dramatic call ahead of SOLD — callBannerMarkup() (shared.js) renders it
   on public.js and team.js, reading auction.callState ('once'|'twice'|null).
   These three functions are the ONLY writers of that field; every other
   write to `auction` elsewhere in this file (and team.js's placeMyBid())
   clears it back to null, so a call can never linger past the moment it
   applies to — a new bid, a pause, ending the lot, or ending the session
   all silently cancel it. See CLAUDE.md §3 for the full list. */
async function callOnce(){
  if(!mstate.auction || !mstate.auction.leaderTeamId) return; // nothing to call on — no bid yet
  await db.ref('auction').update({callState:'once'});
}
async function callTwice(){
  if(!mstate.auction || !mstate.auction.leaderTeamId) return;
  await db.ref('auction').update({callState:'twice'});
}
async function cancelCall(){
  await db.ref('auction').update({callState:null});
}

/* The hammer sound for a completed sale.
   Two things decide how this is written:
   1. Browsers only allow audio after a user gesture. The moderator's click
      IS that gesture, so play() has to be reached synchronously from the
      handler — after an `await` the activation may be gone and play()
      rejects silently. That's why markSold() fires this before its writes.
   2. One reused Audio element, rewound each time, so back-to-back sales
      retrigger the sound instead of stacking up new downloads.
   A blocked or missing sound must never take the sale down with it, hence
   the catch on both the constructor and the play() promise. */
let soldSound = null;
function playSoldSound(){
  if(typeof Audio === 'undefined') return; // headless test context
  try{
    if(!soldSound) soldSound = new Audio('sound/sell.mp3');
    soldSound.currentTime = 0;
    const p = soldSound.play();
    if(p && p.catch) p.catch(()=>{});
  }catch(e){ /* audio is decoration; never block the sale on it */ }
}

async function markSold(){
  const auc = mstate.auction;
  const player = getPlayer(auc.currentPlayerId);
  const team = getTeam(auc.leaderTeamId);
  if(!player || !team) return;
  // after the guards (the sale is definitely happening) but before the first
  // await, so the click still counts as the gesture that unlocks audio
  playSoldSound();
  const price = auc.currentPrice || player.basePrice;
  const updates = {};
  updates['players/'+player.id+'/status'] = 'sold';
  updates['players/'+player.id+'/soldTo'] = team.id;
  updates['players/'+player.id+'/soldPrice'] = price;
  updates['squads/'+team.id+'/'+player.id] = {price};
  // Keyed by the player's own id, not a random push key: if this player was
  // sold before, released, and is being sold again, this REPLACES their one
  // row in the log instead of adding a second — see "Live Results" in
  // CLAUDE.md for why a push key here caused ghost duplicate rows and
  // double-counted spend.
  updates['recentSales/'+player.id] = saleRecord(player, team, price, 'sold');
  await db.ref().update(updates);
  await holdForNext({name:player.name, result:'sold', team:team.name, price, image:player.image||''});
  toast(player.name+' SOLD to '+team.name+' for '+fmtMoney(price), 'success');
}

async function markUnsold(){
  const player = getPlayer(mstate.auction.currentPlayerId);
  if(!player) return;
  const updates = {};
  updates['players/'+player.id+'/status'] = 'unsold';
  updates['recentSales/'+player.id] = saleRecord(player, null, null, 'unsold');
  await db.ref().update(updates);
  await holdForNext({name:player.name, result:'unsold', team:null, price:null, image:player.image||''});
  toast(player.name+' went UNSOLD.');
}

async function skipPlayer(){
  const auc = mstate.auction;
  const player = getPlayer(auc.currentPlayerId);
  if(!player) return;
  await holdForNext({name:player.name, result:'skipped', team:null, price:null, image:player.image||''}, {excludeId:player.id});
  toast(player.name+' skipped — still in the pool.');
}

/* ============================ LIVE RESULTS TAB ============================ */
function renderResultsCard(limit){
  const sales = salesArray(mstate.recentSales);
  const shown = limit ? Math.min(limit, sales.length) : sales.length;
  return `
  <div class="card">
    <h2>Live Results <span class="n">${sales.length}</span></h2>
    ${renderSalesTable(sales, {limit})}
    ${limit && sales.length>shown ? `<p class="hint" style="margin-top:10px;">Showing the latest ${shown}. <a href="#" onclick="setTab('results');return false;">See all ${sales.length} →</a></p>` : ''}
  </div>`;
}
function renderResults(){
  const sales = salesArray(mstate.recentSales);
  const sold = sales.filter(r=>r.result==='sold');
  const spend = sold.reduce((s,r)=>s+(r.price||0),0);
  return `
  <div class="chip-row">
    <div class="chip"><div class="val">${sales.length}</div><div class="lbl">Lots Called</div></div>
    <div class="chip"><div class="val">${sold.length}</div><div class="lbl">Sold</div></div>
    <div class="chip"><div class="val">${sales.length-sold.length}</div><div class="lbl">Unsold</div></div>
    <div class="chip"><div class="val">${fmtMoney(spend)}</div><div class="lbl">Total Spend</div></div>
  </div>
  <div class="card">
    <h2>Live Results <span class="n">${sales.length}</span></h2>
    <p class="hint" style="margin-bottom:12px;">Every lot as it was called, newest first. The same table is on the public view.</p>
    ${renderSalesTable(sales)}
  </div>`;
}

/* ============================ TEAMS TAB ============================ */
function renderTeams(){
  const teams = teamsArr();
  if(teams.length===0){ return `<div class="card"><div class="empty-state"><div class="icn">👥</div>No teams yet.</div></div>`; }
  return `<div class="grid cols-3">
    ${teams.map(t=>{
      const rem = remainingOf(t);
      const need = Math.max(0, mstate.settings.minPlayersPerTeam - squadCountOf(t));
      const shortBudget = rem < (need * mstate.settings.defaultBasePrice);
      const pctBar = Math.max(0,Math.min(100,(rem/t.budget)*100));
      const squadEntries = t.squad ? Object.entries(t.squad) : [];
      return `
      <div class="team-card ${shortBudget?'warn':''}">
        <div class="head"><h3>${t.name}</h3><span class="badge ${squadCountOf(t)>=mstate.settings.minPlayersPerTeam?'sold':'pending'}">${squadCountOf(t)}/${mstate.settings.minPlayersPerTeam}-${mstate.settings.maxPlayersPerTeam}</span></div>
        <div class="stats-row"><span>Total Budget</span><span>${fmtMoney(t.budget)}</span></div>
        <div class="stats-row"><span>Spent</span><span>${fmtMoney(spentOf(t))}</span></div>
        <div class="stats-row"><span>Remaining</span><span>${fmtMoney(rem)}</span></div>
        <div class="budgetbar"><div class="fg" style="width:${pctBar}%;"></div></div>
        ${shortBudget ? `<div class="warn-banner">⚠ Not enough purse to reach minimum squad size. Release a player to free up budget.</div>` : ''}
        <div class="squad-list">
          ${squadEntries.length===0 ? '<p class="hint">No players yet.</p>' : squadEntries.map(([pid,sq])=>{
            const p = getPlayer(pid);
            return `<div class="squad-row"><div class="p-cell">${playerImg(p||{},'sm')}<div><div>${p?p.name:'—'}</div><div class="p-meta">${p?p.category:''}</div></div></div>
              <div style="text-align:right;"><div>${fmtMoney(sq.price)}</div><button class="sm danger" style="margin-top:3px;" onclick="releasePlayer('${t.id}','${pid}')">Release</button></div></div>`;
          }).join('')}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}
function releasePlayer(teamId, playerId){
  showModal(`<h3>Release player?</h3><p style="font-size:13px;color:var(--cream-dim);">Returns the player to the pending pool and refunds their price to the team's budget.</p>
    <div class="modal-actions"><button class="ghost sm" onclick="closeModal()">Cancel</button><button class="danger sm" onclick="doRelease('${teamId}','${playerId}'); closeModal();">Confirm</button></div>`);
}
async function doRelease(teamId, playerId){
  await db.ref('squads/'+teamId+'/'+playerId).remove();
  await db.ref('players/'+playerId).update({status:'pending', soldTo:null, soldPrice:null});
  // Otherwise a released-then-resold player would show TWICE in Live
  // Results (once for each sale) and get double-counted in every spend
  // total that reads the results log.
  await db.ref('recentSales/'+playerId).remove();
  toast('Player released back to the pool.', 'success');
}

/* ============================ SUMMARY TAB ============================ */
function renderSummary(){
  const all = playersArr();
  const sold = all.filter(p=>p.status==='sold');
  const unsold = all.filter(p=>p.status==='unsold');
  const totalSpent = sold.reduce((s,p)=>s+p.soldPrice,0);
  const avg = sold.length ? totalSpent/sold.length : 0;
  const highest = sold.slice().sort((a,b)=>b.soldPrice-a.soldPrice)[0];
  const teams = teamsArr();
  const maxSpend = Math.max(1, ...teams.map(t=>spentOf(t)));
  return `
  <div class="chip-row">
    <div class="chip"><div class="val">${sold.length}</div><div class="lbl">Players Sold</div></div>
    <div class="chip"><div class="val">${unsold.length}</div><div class="lbl">Unsold</div></div>
    <div class="chip"><div class="val">${fmtMoney(totalSpent)}</div><div class="lbl">Total Spent</div></div>
    <div class="chip"><div class="val">${fmtMoney(avg)}</div><div class="lbl">Avg Sale</div></div>
    <div class="chip"><div class="val">${highest?fmtMoney(highest.soldPrice):'—'}</div><div class="lbl">${highest?highest.name:'Highest Sale'}</div></div>
  </div>
  <div class="card"><h2>Team-wise Spend</h2>
    ${teams.map(t=>{ const sp=spentOf(t); const pct=(sp/maxSpend)*100;
      return `<div class="bar-row"><div class="name">${t.name}</div><div class="track"><div class="fill" style="width:${pct}%;"></div></div><div class="amt">${fmtMoney(sp)}</div></div>`;
    }).join('') || '<p class="hint">No teams yet.</p>'}
  </div>
  <div class="card"><h2>Full Results <span class="n">${all.length}</span></h2>
    <div class="field-row" style="margin-bottom:10px;"><button class="sm" onclick="exportCSV()">⬇ Export Results CSV</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Player</th><th>Category</th><th>Base</th><th>Status</th><th>Team</th><th>Sold Price</th></tr></thead>
      <tbody>${all.slice().sort((a,b)=>(b.soldPrice||0)-(a.soldPrice||0)).map(p=>`
        <tr><td><div class="p-cell">${playerImg(p,'sm')}<span class="p-name">${p.name}</span></div></td>
        <td><span class="badge cat">${p.category}</span></td><td>${fmtMoney(p.basePrice)}</td>
        <td><span class="badge ${p.status}">${p.status==='sold' ? soldLabel(mstate.recentSales[p.id]) : p.status}</span></td><td>${p.soldTo?(getTeam(p.soldTo)?.name||'—'):'—'}</td>
        <td>${p.soldPrice!=null?fmtMoney(p.soldPrice):'—'}</td></tr>`).join('')}</tbody>
    </table></div>
  </div>`;
}
function exportCSV(){
  const rows = [['Name','Category','Base Price','Photo','Status','Team','Sold Price']];
  playersArr().forEach(p=>{ rows.push([p.name,p.category,p.basePrice,p.image||'',p.status,p.soldTo?(getTeam(p.soldTo)?.name||''):'',p.soldPrice!=null?p.soldPrice:'']); });
  downloadCSV(rows, 'auction-results.csv');
}

renderRoot();
