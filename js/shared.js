/* ============================================================
   shared.js — Firebase init, session/key handling, data helpers,
   and small UI utilities reused across index.html, admin.html,
   moderator.html and team.html.
   Loaded AFTER: firebase SDK scripts + firebase-config.js
   ============================================================ */

/* Which Firebase app instance this page gets.

   A page can opt into its OWN named instance with data-pv-app on <html>;
   admin.html is the only one that does. Everything else shares the default.

   Why that matters, from Firebase's auth-state-persistence docs: "if one tab
   switches from local to session persistence, other tabs using local
   persistence will have that user signed out." adminLogin() relies on the
   default LOCAL persistence, while ensureAnonymousAuth() MUST switch to
   SESSION so a moderator/team key stays scoped to its own tab — so opening
   moderator.html or team.html used to sign the organizer out of admin.html
   mid-session, and every key write then failed the Database Rules.

   Firebase namespaces auth storage per instance
   (firebase:authUser:<apiKey>:<appName>) and applies that one-persistence-
   type-at-a-time rule WITHIN an instance, so giving admin its own instance
   lets the two sessions coexist. This is purely a client-side SDK split:
   same project, same config, same rules — nothing changes server-side.

   `auth` and `db` keep their names, so no other file needs to know. Anything
   that reaches for firebase.auth()/firebase.database() directly instead of
   these two would silently land back on the default app — don't. */
const PV_APP_NAME = document.documentElement.getAttribute('data-pv-app') || '';
const pvApp = PV_APP_NAME
  ? firebase.initializeApp(window.FIREBASE_CONFIG, PV_APP_NAME)
  : firebase.initializeApp(window.FIREBASE_CONFIG);
const auth = firebase.auth(pvApp);
const db = firebase.database(pvApp);

const SESSION_KEY = 'auction_session_v1';

/* ---------------- Session / key handling ---------------- */

function getSession(){
  try{
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}
function saveSession(s){ sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
function clearSession(){ sessionStorage.removeItem(SESSION_KEY); }

/**
 * Sign in anonymously if not already signed in (used by moderator/team
 * portals). Always resolves with a genuinely anonymous user — never reuses
 * a real (non-anonymous) session, e.g. an admin still signed in on this
 * same browser from another tab, since that would tie a moderator/team
 * session to the admin's uid instead of its own. SESSION persistence keeps
 * this identity scoped to this one browser tab, so a real admin session
 * open elsewhere can't collide with — or get silently replaced by — it. A
 * reload of *this* tab still resumes fine: claimKey() re-authorizes
 * whatever uid is current the moment a key is entered, so nothing depends
 * on the anonymous uid itself staying the same across a full sign-out.
 */
function ensureAnonymousAuth(){
  return new Promise((resolve, reject)=>{
    const unsub = auth.onAuthStateChanged(user=>{
      unsub();
      if(user && user.isAnonymous){ resolve(user); return; }
      auth.setPersistence(firebase.auth.Auth.Persistence.SESSION)
        .then(()=>auth.signInAnonymously())
        .then(cred=>resolve(cred.user))
        .catch(err=>{
          // Firebase's own text for this ("This operation is restricted to
          // administrators only") reads like a permissions bug in the app.
          // It's actually one missing console setting — say that instead.
          if(err && err.code === 'auth/admin-restricted-operation'){
            reject(new Error('Anonymous sign-in isn\'t turned on for this Firebase project yet. In the Firebase Console: Authentication → Sign-in method → enable "Anonymous" (see README → "Enable the Firebase products you need"), then try again.'));
          } else {
            reject(err);
          }
        });
    });
  });
}

/**
 * Validate a key the person typed in, then record a session for this
 * browser's anonymous auth user so the Realtime Database Rules can check
 * "is this uid allowed to write here" server-side.
 */
async function claimKey(rawKey){
  const key = (rawKey||'').trim().toUpperCase();
  if(!key) throw new Error('Enter a key.');
  const user = await ensureAnonymousAuth();
  const snap = await db.ref('accessKeys/'+key).once('value');
  const data = snap.val();
  if(!data || !data.active){ throw new Error('That key is invalid or has been revoked.'); }
  const session = {role:data.role, teamId:data.teamId||null, key, uid:user.uid, label:data.label||''};
  await db.ref('sessions/'+user.uid).set({role:data.role, teamId:data.teamId||null, key, claimedAt:Date.now()});
  saveSession(session);
  return session;
}

/** Reject with `message` if `promise` hasn't settled within `ms`. */
function withTimeout(promise, ms, message){
  return Promise.race([promise, new Promise((_, reject)=>setTimeout(()=>reject(new Error(message)), ms))]);
}

/** Admin (organizer) login with a real Firebase email/password account. */
async function adminLogin(email, password){
  const cred = await auth.signInWithEmailAndPassword(email, password);
  const snap = await withTimeout(db.ref('admins/'+cred.user.uid).once('value'), 10000,
    'Signed in, but the Realtime Database did not respond. Check that the database exists and that databaseURL in firebase-config.js matches the URL shown in Firebase Console → Realtime Database.');
  if(snap.val() !== true){
    await auth.signOut();
    throw new Error('This account is not registered as an admin (see README: "Creating the first admin").');
  }
  const session = {role:'admin', teamId:null, uid:cred.user.uid, label:email};
  saveSession(session);
  return session;
}

/**
 * Signed out only counts once Firebase has actually finished tearing down
 * the session — callers must await this before allowing a new sign-in
 * attempt. Firing `auth.signOut()` without waiting for it let a fast
 * sign-out-then-sign-in-again race Firebase's own state transition, which
 * could resolve the *next* login against stale auth state.
 */
async function signOutAll(){
  clearSession();
  await auth.signOut();
}

/* ---------------- Small UI utilities ---------------- */

function fmtMoney(v, currencyUnit){
  const unit = currencyUnit || (window.__settingsCache && window.__settingsCache.currencyUnit) || 'Cr';
  const sign = v<0 ? '-' : '';
  return sign + Math.abs(v||0).toFixed(2).replace(/\.00$/,'') + ' ' + unit;
}
function toast(msg, type){
  let root = document.getElementById('toastRoot');
  if(!root){ root = document.createElement('div'); root.id='toastRoot'; document.body.appendChild(root); }
  const el = document.createElement('div');
  // NOT "toast": Bootstrap owns that class and hides anything without .show
  el.className = 'pv-toast' + (type === 'error' || type === 'success' ? ' ' + type : '');
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(()=>{ el.style.transition='opacity .3s'; el.style.opacity='0'; setTimeout(()=>el.remove(),300); }, 2600);
}
function showModal(html){
  let root = document.getElementById('modalRoot');
  if(!root){ root = document.createElement('div'); root.id='modalRoot'; document.body.appendChild(root); }
  root.innerHTML = `<div class="modal-overlay" onclick="if(event.target===this) closeModal()"><div class="modal-box">${html}</div></div>`;
}
function closeModal(){ const r=document.getElementById('modalRoot'); if(r) r.innerHTML=''; }
function escapeAttr(s){ return (s||'').replace(/"/g,'&quot;'); }

/** Escape text for use as HTML content. escapeAttr above only handles the
 *  double quote, which is not enough for text placed between tags. */
function escapeHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ---------------- Player photos ----------------
   Photos are ordinary files committed to the repo's images/ folder, and
   Firebase only stores the relative path (e.g. "images/kohli.jpg"). That
   keeps them working unchanged on GitHub Pages. A full http(s) URL is also
   accepted and used as-is. */

const DEFAULT_PLAYER_IMAGE = 'images/default.png';

/** Resolve whatever is stored on a player into a usable src. */
function playerImageSrc(player){
  const raw = (player && player.image || '').trim();
  if(!raw) return DEFAULT_PLAYER_IMAGE;
  if(/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw;
  return raw.replace(/^\.?\//,'');
}

/**
 * <img> for a player, clipped to a fixed square by CSS so every photo lines
 * up at the same size whatever its real dimensions. `size` is 'sm' | 'md' | 'lg'.
 * A missing file silently falls back to the default photo.
 */
function playerImg(player, size){
  const src = playerImageSrc(player);
  const alt = escapeAttr((player && player.name) || 'Player');
  return `<img class="p-photo ${size||'sm'}" src="${escapeAttr(src)}" alt="${alt}" loading="lazy"
    onerror="this.onerror=null;this.src='${DEFAULT_PLAYER_IMAGE}';">`;
}

/** Turn a picked filename into the repo-relative path we store. */
function imagePathFromFileName(fileName){
  const clean = (fileName||'').trim().replace(/^.*[\\/]/,'');
  return clean ? 'images/'+clean : '';
}

/* ---------------- Vibrant accents ----------------
   Categories and team names are free text the moderator types, so the colour
   is derived from the string itself: the same category always lands on the
   same hue, on every device and every reload, with nothing to configure. */

const PV_HUES = ['hue-blue','hue-green','hue-purple','hue-orange','hue-pink','hue-teal'];

function hueFor(text){
  const s = (text||'').trim().toLowerCase();
  if(!s) return '';
  let h = 0;
  for(let i=0;i<s.length;i++){ h = (h*31 + s.charCodeAt(i)) >>> 0; }
  return PV_HUES[h % PV_HUES.length];
}

/* ---------------- Collapsible tab navigation ----------------
   Bootstrap's navbar CSS does the responsive half: below the lg breakpoint
   `.collapse:not(.show)` hides the list and the toggler is visible; at lg and
   up the list is forced visible and the toggler hidden. Only the click needs
   wiring, so this uses seven lines of our own rather than pulling in
   Bootstrap's ~80KB JS bundle (one less CDN that can fail). */

function renderTabNav(tabs, activeId, handlerName){
  const current = tabs.find(t => t.id === activeId);
  return `
  <button class="navbar-toggler pv-burger" type="button"
          aria-controls="tabMenu" aria-expanded="false" aria-label="Toggle menu"
          onclick="toggleTabMenu(this)">
    <span class="pv-burger-bars" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="pv-burger-text">${current ? current.label : 'Menu'}</span>
  </button>
  <div class="collapse navbar-collapse" id="tabMenu">
    <div class="navbar-nav">
      ${tabs.map(t => `<button class="${t.id===activeId?'active':''}" onclick="${handlerName}('${t.id}')">${t.label}</button>`).join('')}
    </div>
  </div>`;
}

function toggleTabMenu(btn){
  const menu = document.getElementById('tabMenu');
  if(!menu) return;
  const open = menu.classList.toggle('show');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/* ---------------- Money, set typographically ---------------- */

/** Split "19 Cr" so the amount can be set large and the unit small beside it. */
function splitMoney(v){
  const s = fmtMoney(v);
  const i = s.lastIndexOf(' ');
  return i === -1 ? {num:s, unit:''} : {num:s.slice(0,i), unit:s.slice(i+1)};
}
function money(v){
  const m = splitMoney(v);
  return `<span class="pv-amt">${m.num}</span>${m.unit ? `<span class="pv-unit">${m.unit}</span>` : ''}`;
}

/* ---------------- The live lot ----------------
   One renderer for the player on the block, shared by the public view and
   the team owner portal so both show the lot identically: photo on the left,
   the bid — the headline — on the right.

   opts: { eyebrow, price, leader, leaderNote, extra } — all optional.
     eyebrow     html for the small line above the name
     price       the number to headline
     leader      the team object currently winning, or null
     leaderNote  appended inside the leading capsule (e.g. "You!")
     extra       html dropped in below the bid (e.g. the bid button)
*/
function lotMarkup(player, opts){
  const o = opts || {};
  const hue = hueFor(player.category);
  return `
  <div class="pv-lot-grid">
    <div class="pv-lot-media">
      <div class="pv-photo-frame">
        <img class="pv-photo" src="${escapeAttr(playerImageSrc(player))}"
             alt="${escapeAttr(player.name||'Player')}"
             onerror="this.onerror=null;this.src='${DEFAULT_PLAYER_IMAGE}';">
      </div>
    </div>
    <div class="pv-lot-detail">
      ${o.eyebrow ? `<div class="pv-eyebrow">${o.eyebrow}</div>` : ''}
      <h1 class="pv-name">${player.name}</h1>
      <div class="pv-meta">
        ${player.category ? `<span class="pv-tag ${hue}">${player.category}</span>` : ''}
        <span class="pv-tag ghost">Base ${fmtMoney(player.basePrice)}</span>
      </div>
      <div class="pv-bidblock">
        <div class="pv-bidmain">
          <div class="pv-bidlabel">Current bid</div>
          <div class="pv-bid">${money(o.price)}</div>
        </div>
        ${o.leader
          ? `<div class="pv-leader is-leading">
               <span class="pv-leader-dot"></span>
               <div class="pv-leader-txt">
                 <div class="pv-leader-label">Leading${o.leaderNote ? ' &middot; '+o.leaderNote : ''}</div>
                 <div class="pv-leader-name">${o.leader.name}</div>
               </div>
             </div>`
          : `<div class="pv-leader">
               <span class="pv-leader-none">No bids yet — base price active</span>
             </div>`}
      </div>
      ${o.extra || ''}
    </div>
  </div>`;
}

/* ---------------- Live sales log ---------------- */

/**
 * One row of the live results table, written when a player is sold or goes
 * unsold. `via` distinguishes how a "sold" row happened — 'auction' (the
 * default, a real live-bidding sale) or 'assigned' (the moderator's
 * pre-auction retain/assign action) — public.js's fireworks only celebrate
 * the former; see its "TEMP FIREWORKS hook".
 */
function saleRecord(player, team, price, result, via){
  return {
    playerId: player.id,
    name: player.name,
    category: player.category || '',
    image: player.image || '',
    basePrice: player.basePrice != null ? player.basePrice : 0,
    result: result,
    via: via || 'auction',
    teamId: team ? team.id : null,
    team: team ? team.name : null,
    price: price != null ? price : null,
    time: Date.now()
  };
}

/** Newest-first array out of the raw recentSales map. */
function salesArray(raw){
  return Object.entries(raw||{})
    .map(([id,v])=>({id, ...v}))
    .sort((a,b)=>(b.time||0)-(a.time||0));
}

/**
 * The word for a 'sold' status/result: 'retained' for the moderator's
 * pre-auction Assign action, 'sold' for a real live-auction sale. `sale` is
 * the matching recentSales row carrying `via` (a saleRecord(), or an entry
 * from salesArray()/mstate.recentSales/adminState.sales) — pass null/undefined
 * if there isn't one (a legacy row from before `via` existed, or a lookup
 * that found nothing) and it reads as 'sold', the original meaning.
 * Lowercase, to match the existing sold/unsold/pending badge text — every
 * caller of this except public.js's own results table re-cases it themselves
 * if they need Title Case; theme.css's `.badge` is `text-transform:none`, so
 * whatever a caller shows is exactly what's shown.
 */
function soldLabel(sale){ return (sale && sale.via === 'assigned') ? 'retained' : 'sold'; }

function fmtTime(ts){
  if(!ts) return '—';
  return new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}

/* ---------------- Downloads ---------------- */

function triggerDownload(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function downloadCSV(rows, filename){
  const csv = rows.map(r=>r.map(x=>`"${String(x==null?'':x).replace(/"/g,'""')}"`).join(',')).join('\n');
  triggerDownload(new Blob(['﻿'+csv], {type:'text/csv;charset=utf-8'}), filename);
}
function downloadJSON(obj, filename){
  triggerDownload(new Blob([JSON.stringify(obj, null, 2)], {type:'application/json'}), filename);
}
/** e.g. "auction-results-2026-09-27.csv" */
function stampedName(base, ext){
  return base+'-'+new Date().toISOString().slice(0,10)+'.'+ext;
}

/* ---------------- Auction session state ----------------
   `biddingOpen` gates team bids (also enforced in Database Rules).
   `paused` is set when the moderator signs out or disconnects.
   `awaitingNext` means a result was just recorded and the moderator has
   not yet pressed "Next Player". */

/**
 * The live results table — every player as they're sold (or go unsold),
 * newest first. Shared by the public view and the moderator console.
 */
function renderSalesTable(sales, opts){
  const o = opts || {};
  if(!sales.length){
    return `<div class="empty-state"><div class="icn">📃</div>No players have gone under the hammer yet.</div>`;
  }
  const rows = (o.limit ? sales.slice(0, o.limit) : sales);
  const newestTime = rows.length ? rows[0].time : 0;
  return `
  <div class="table-wrap"><table class="sales-table">
    <thead><tr>
      <th>Player</th><th>Category</th><th>Base</th><th>Result</th><th>Sold To</th><th>Price</th><th>Time</th>
    </tr></thead>
    <tbody>
      ${rows.map(r=>`
      <tr class="${r.time===newestTime ? 'just-in' : ''}">
        <td><div class="p-cell">${playerImg(r,'sm')}<span class="p-name">${r.name}</span></div></td>
        <td>${r.category ? `<span class="badge cat">${r.category}</span>` : '—'}</td>
        <td>${r.basePrice != null ? fmtMoney(r.basePrice) : '—'}</td>
        <td><span class="badge ${r.result==='sold'?'sold':'unsold'}">${r.result==='sold'?soldLabel(r):'unsold'}</span></td>
        <td class="tname">${r.team || '—'}</td>
        <td class="amt">${r.result==='sold' && r.price!=null ? fmtMoney(r.price) : '—'}</td>
        <td class="when">${fmtTime(r.time)}</td>
      </tr>`).join('')}
    </tbody>
  </table></div>`;
}

function isPaused(auc){ return !!(auc && auc.paused); }
function isAwaitingNext(auc){ return !!(auc && auc.awaitingNext); }
function isCompleted(auc){ return !!(auc && auc.completed); }
function biddingIsOpen(auc){ return !!(auc && auc.biddingOpen && !auc.paused && !auc.completed); }
/** True when the auction is mid-flight — a lot is up, or one is about to be. */
function sessionInProgress(auc){ return !!(auc && !auc.completed && (auc.currentPlayerId || auc.awaitingNext)); }
function genKeyString(role){
  const prefix = role==='moderator' ? 'MOD' : role==='admin' ? 'ADM' : 'TEAM';
  const rand = Math.random().toString(36).slice(2,8).toUpperCase();
  return prefix+'-'+rand;
}

/* ---------------- Shared auction business rules ----------------
   Same eligibility rules as the original single-file app: a team
   can't exceed its budget, can't exceed max squad size, and must
   always keep enough purse to reach its minimum squad size at the
   default base price. */

function spentOf(team){
  if(!team || !team.squad) return 0;
  return Object.values(team.squad).reduce((s,x)=>s+(x.price||0), 0);
}
function squadCountOf(team){ return team.squad ? Object.keys(team.squad).length : 0; }
function remainingOf(team){ return (team.budget||0) - spentOf(team); }
function reserveNeeded(team, settings, extraSlotFilled){
  const after = squadCountOf(team) + (extraSlotFilled?1:0);
  const need = Math.max(0, (settings.minPlayersPerTeam||0) - after);
  return need * (settings.defaultBasePrice||0);
}
/**
 * What a bid costs if you raise by `steps` increments. The first bid of a lot
 * opens at the base price, so step 1 is the base and step 2 is one increment
 * above it; after that each step is one increment on the current bid.
 */
function bidPriceFor(auction, player, settings, steps){
  const n = Math.max(1, steps || 1);
  const inc = settings.bidIncrement || 1;
  const current = (auction && auction.currentPrice) || 0;
  return current === 0 ? player.basePrice + (n - 1) * inc
                       : current + n * inc;
}

function teamCanAffordBid(team, settings, price){
  if(squadCountOf(team) >= (settings.maxPlayersPerTeam||Infinity)) return false;
  if(price > remainingOf(team)) return false;
  const reserve = reserveNeeded(team, settings, true);
  if((remainingOf(team) - price) < reserve) return false;
  return true;
}

/* ---------------- Connection status badge (optional, used on portals) ---------------- */
function watchConnection(elId){
  db.ref('.info/connected').on('value', snap=>{
    const el = document.getElementById(elId);
    if(!el) return;
    const on = snap.val()===true;
    el.innerHTML = `<span class="conn-dot ${on?'on':'off'}"></span>${on?'Live':'Reconnecting…'}`;
  });
}
