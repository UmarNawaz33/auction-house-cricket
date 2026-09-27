/* ============================================================
   tests/lib/fixtures.js — one canonical set of sample data (settings, teams,
   players, sales log, auction states) shared by every test file, evaluated
   as JS source inside the VM context so it binds as real top-level consts
   there (`SETTINGS`, `TEAMS`, `PLAYERS`, `SALES`, `LIVE`, `AWAITING`, ...).

   Keep this the single source of truth for sample data. A test that needs a
   variant should build it from these with Object.assign in its own code
   rather than hand-rolling a parallel fixture — that drift is exactly what
   made the six original scratchpad test files hard to compare.
   ============================================================ */

const FIXTURES = `
const SETTINGS = {numTeams:2, defaultBudget:100, defaultBasePrice:5, bidIncrement:1,
                  maxPlayersPerTeam:18, minPlayersPerTeam:2, currencyUnit:'Cr'};
const TEAMS = ()=>({t1:{name:'Lions', budget:100, squad:{p2:{price:12}}}, t2:{name:'Tigers', budget:100, squad:{}}});
const PLAYERS = {
  p1:{name:'Virat Kohli', category:'Batsman', basePrice:15, image:'images/kohli.jpg', status:'pending', soldTo:null, soldPrice:null},
  p2:{name:'Jasprit Bumrah', category:'Bowler', basePrice:12, image:'', status:'sold', soldTo:'t1', soldPrice:12},
  p3:{name:'Ravindra Jadeja', category:'All-Rounder', basePrice:8, image:'', status:'unsold', soldTo:null, soldPrice:null}
};
const SALES = {s1:{name:'Jasprit Bumrah', category:'Bowler', image:'', basePrice:12,
                   result:'sold', teamId:'t1', team:'Lions', price:12, time:1727400000000},
               s2:{name:'Ravindra Jadeja', category:'All-Rounder', image:'', basePrice:8,
                   result:'unsold', teamId:null, team:null, price:null, time:1727400100000}};

/* auction-node states, one per shape the app actually branches on
   (see CLAUDE.md "auction node contract" for what each field means) */
const LIVE     = {currentPlayerId:'p1', currentPrice:16, leaderTeamId:'t1', biddingOpen:true, paused:false, awaitingNext:false, updatedAt:1727400200000};
const NOBIDS   = {currentPlayerId:'p1', currentPrice:0, leaderTeamId:null, biddingOpen:true, paused:false, awaitingNext:false};
const AWAITING = {currentPlayerId:null, currentPrice:0, leaderTeamId:null, biddingOpen:false, paused:false, awaitingNext:true,
                  lastResult:{name:'Jasprit Bumrah', result:'sold', team:'Lions', price:12, image:''}};
const PAUSED        = Object.assign({}, LIVE, {paused:true, biddingOpen:false, pausedAt:1727400300000, pauseReason:'manual'});
const PAUSED_SIGNOUT= Object.assign({}, PAUSED, {pauseReason:'signout'});
const PAUSED_DROP   = Object.assign({}, PAUSED, {pauseReason:'disconnect'});
const SKIPPED  = Object.assign({}, AWAITING, {excludeId:'p1', lastResult:{name:'Virat Kohli', result:'skipped', team:null, price:null, image:''}});
const DONE     = {currentPlayerId:null, currentPrice:0, leaderTeamId:null, biddingOpen:false, paused:false,
                  awaitingNext:false, completed:true, completedAt:1727400400000, lastResult:null};
const EMPTY    = {};

window.__settingsCache = SETTINGS;
`;

module.exports = { FIXTURES };
