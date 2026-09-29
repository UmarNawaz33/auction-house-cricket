# Project map — read this before editing

This file is for me (Claude), not the user — it exists so a small change
doesn't require re-deriving the whole codebase or re-running every test.
`README.md` is the user-facing setup/operator guide; this file is the
dependency map and the test-selection guide. Keep both current when they'd
otherwise drift.

**Workflow for every prompt in this project:**
1. Read the relevant row(s) in the two tables below (file map, then impact
   map) before touching anything, to know what else the change reaches.
2. Make the change.
3. Run only the test suite(s) the impact map names — not all six — unless
   the change touches `js/shared.js`, `css/theme.css`, or spans multiple
   pages, in which case run the full suite (`node tests/run.js`).
4. If this file's facts turn out stale (a function moved, a class got
   renamed, a new collision surfaced), update this file in the same turn.
   A wrong map is worse than no map.

---

## 1. What this is

A static (no build step, no bundler) Firebase-backed live cricket-auction
app: four HTML pages, each gated to a role, all reading/writing the same
Realtime Database in real time. See `README.md` for what the app *does*;
this section is only what's relevant to editing it safely.

## 2. File map

```
index.html        public read-only live view                  -> js/public.js
admin.html         organizer: keys, teams/players admin, data   -> js/admin.js
moderator.html      runs the live auction floor                 -> js/moderator.js
team.html             one team owner, bids for their team        -> js/team.js

js/shared.js       loaded by ALL FOUR pages before the page-specific file.
                   Session/key handling, Firebase auth helpers, money
                   formatting, the shared `lotMarkup()` player-on-the-block
                   component, sales-log helpers, auction-state predicates
                   (isPaused/isCompleted/biddingIsOpen/...), bid pricing
                   and affordability rules, the tab-nav/hamburger renderer.
                   See §4 for the exact symbol list.

js/public.classic.js   a byte-identical snapshot of public.js from BEFORE
                       the Liquid Glass redesign (sha256 6c3e9dd3d3297a5f).
                       Revert path: `copy js\public.classic.js js\public.js`.
                       Not loaded by any page; don't delete it without
                       asking — it's the user's insurance policy on the redesign.

css/styles.css     structure/layout, shared by all four pages. Legacy dark
                   theme colors here are overridden by theme.css but the
                   layout rules (grid, flex, spacing) are load-bearing.
css/theme.css      the "Pro Dark" look (2026-09-28, replaced the earlier
                   "Liquid Glass" glassmorphism theme — see below), loaded
                   AFTER styles.css and AFTER Bootstrap on every page.
                   Re-points styles.css's CSS variables, then re-styles real
                   surfaces as flat, near-opaque elevated panels (solid slate
                   card + hairline border + drop shadow, no frosted
                   transparency/rim glow) and owns the shared
                   `.pv-lot*`/`.pv-bid*`/`.pv-leader*` player-on-the-block
                   component used by public.js, moderator.js AND team.js.
                   Brand accent is a single gold (`--pv-orange`/`--gold`
                   re-pointed together) plus emerald green for "winning bid"
                   state; headings/scoreboard numerals use Barlow Condensed,
                   body text Inter — both loaded via a Google Fonts `<link>`
                   added to all four HTML `<head>`s, right before
                   `css/styles.css`. `js/public.classic.js`'s revert snapshot
                   predates the Liquid Glass redesign, not this one — this
                   change touched no JS, so there's nothing to revert there.

images/default.png  fallback player photo (actually a JPEG despite the name;
                    browsers render it fine).

sound/sell.mp3      the hammer sound played on a completed sale, on TWO
                    pages by TWO different mechanisms because of the
                    autoplay constraint in §6a:
                      - moderator.js: `playSoldSound()`, played directly
                        inside markSold()'s own click (that click IS the
                        gesture) — no unlock needed.
                      - public.js: `playPublicSoldSound()`, gated on
                        `publicSoundEnabled` and fired from the same
                        `maybeCelebrateNewSale()` gate as the sold takeover
                        and fireworks. Needs the one-time click on
                        index.html's `#soundToggle` button
                        (`enablePublicSound()`) first — nobody normally
                        clicks the big screen. See §6a for why the unlock
                        has to be a real click on this exact `<audio>`
                        element, and why the element is reused rather than
                        rebuilt on every play.

database.rules.json  Firebase Realtime Database security rules — the real
                     access-control boundary. Must be re-pasted into the
                     Firebase console by the user after any change; we
                     cannot deploy it for them.

tests/             durable Node test suite (no npm install; plain Node +
                   the `vm` module). See §5. THESE FILES REPLACE ANYTHING
                   PREVIOUSLY BUILT IN AN OS TEMP SCRATCHPAD DIRECTORY —
                   scratchpad is session-specific and does not survive to
                   the next conversation, this folder does.
```

**Stylesheet load order, identical on all four pages:**
a Google Fonts `<link>` (Barlow Condensed + Inter) → `css/styles.css` →
Bootstrap 5.3.3 (CDN, with an `onerror` fallback that adds `.pv-no-bs` to
`<html>`) → `css/theme.css`. Each layer wins over the one before it, so an
override belongs in the *last* layer that needs to change — don't add a
`!important` war between styles.css and theme.css.

**Script load order, identical on all four pages:**
Firebase SDKs (CDN) → `js/firebase-config.js` (real credentials; committed so
GitHub Pages can serve it) → `js/shared.js` → the one page-specific file.

**Which Firebase app instance a page gets:** `shared.js` reads `data-pv-app`
off `<html>`. **`admin.html` sets `data-pv-app="admin"` and so runs in its own
named instance; the other three share the default.** That is not cosmetic —
Firebase signs out other tabs holding a LOCAL-persisted user on the *same*
instance when one switches to SESSION persistence, which is exactly what a
moderator/team key login does, so without the split the organizer gets signed
out of admin mid-session (see §6a). Same project, same config, same rules —
the split is purely client-side. Anything reaching for `firebase.auth()` or
`firebase.database()` directly instead of shared.js's `auth`/`db` would land
back on the default app and undo this. Guarded by `auth.test.js`, which
asserts both halves: that shared.js honours the attribute, and that
admin.html actually carries it.

## 3. The `auction` node — the one shared mutable state everything branches on

Single Firebase Realtime Database node at `auction`, read by every page,
written only by `js/moderator.js` (bid price/leader also written by
`js/team.js`, constrained server-side by `database.rules.json`). This is the
highest-leverage thing to get right — a field added here without updating
every reader silently breaks a page that still works from `undefined`.

| field | type | meaning |
|---|---|---|
| `currentPlayerId` | string \| null | player currently on the block |
| `currentPrice` | number | current bid amount (0 = base price active) |
| `leaderTeamId` | string \| null | team currently winning the lot |
| `biddingOpen` | boolean | can team owners bid right now |
| `paused` | boolean | moderator console is unattended |
| `pauseReason` | `'manual'\|'signout'\|'disconnect'` | why it's paused (cosmetic, drives the banner copy) |
| `pausedAt` | number \| null | timestamp, for the "paused since" copy |
| `awaitingNext` | boolean | a result was just called; floor is empty until the moderator presses Next |
| `excludeId` | string \| null | player just skipped — don't immediately re-offer them |
| `lastResult` | object \| null | `{name, result, team, price, image}` shown in the "between lots" banner |
| `completed` | boolean | moderator ended the session; pages fall back to a home/summary view |
| `completedAt` | number \| null | timestamp |
| `updatedAt` | number | last-write timestamp (not otherwise read) |

Read/derive this shape only through `shared.js`'s predicates
(`isPaused`, `isAwaitingNext`, `isCompleted`, `biddingIsOpen`,
`sessionInProgress`) — never re-check a raw field in a new page; that's how
the moderator/public/team pages stayed in lockstep through six redesign
rounds.

Other top-level nodes (see `database.rules.json` for exact rules):
`settings`, `teams`, `squads`, `players`, `recentSales`, `accessKeys`,
`sessions`, `admins`. None of these have the branching complexity of
`auction` — they're read more literally, with one exception: `players/<id>
/status` is `'sold'` for BOTH a real live-auction sale and the moderator's
pre-auction Assign/retain — it cannot tell them apart on its own. Whether a
given sold player was auctioned or retained lives only on the matching
`recentSales/<id>.via`, read through `soldLabel()` (§4) — never infer it
from `players` alone.

## 4. `js/shared.js` — who calls what

Every page-specific file's dependency on `shared.js`, so a change there can
be sanity-checked against every caller before it ships:

| shared.js symbol | used by |
|---|---|
| `getSession`, `saveSession`, `clearSession`, `signOutAll`, `claimKey`, `adminLogin`, `ensureAnonymousAuth` | session/auth — moderator, team, admin (admin also self-checks via Firebase auth state) |
| `lotMarkup` | **public.js, moderator.js, team.js** — the player-on-the-block panel. One template, three callers; changing its signature means checking all three call sites, not just one. |
| `escapeHtml` | public.js's sold takeover. **Use it for text between tags; `escapeAttr` only escapes `"` and is for attribute values.** Names in the takeover come from `recentSales` (moderator/admin-written), but they're escaped anyway. |
| `hueFor`, `money`, `splitMoney` | public.js (category/team color hashing, headline bid typography) |
| `playerImg`, `playerImageSrc` | moderator.js, team.js, admin.js (public.js uses `playerImageSrc` directly inside `lotMarkup`/its own table) |
| `renderTabNav`, `toggleTabMenu` | moderator.js, admin.js (the collapsible hamburger nav) |
| `renderSalesTable` | moderator.js, admin.js. **Not public.js** — despite living right next to `saleRecord`/`salesArray` (which public.js does use), public.js has its own independent results-table markup (two `.pv-pill` spots) rather than calling this. A wording/column change here does not reach `index.html`; check both places. |
| `saleRecord`, `salesArray` | moderator.js, admin.js, public.js |
| `soldLabel` | `renderSalesTable` (shared.js itself); moderator.js's Players tab, Summary tab, `editPlayerPrompt`, `confirmDeletePlayer`; admin.js's Players tab. Reads `sale.via` (`'assigned'` → `'retained'`, anything else → `'sold'`) — **not** `player.status`, which is `'sold'` for both a real auction sale and a moderator Assign and can't tell them apart on its own. Lowercase; a caller re-cases it if it needs Title Case. **public.js does NOT call this** — its own two results-table spots (see `renderSalesTable` row above) inline the identical `via==='assigned'` check themselves, capitalized, because it never calls the shared table renderer. Touch both if the wording changes again. |
| `isPaused`, `isAwaitingNext`, `isCompleted`, `biddingIsOpen`, `sessionInProgress` | all four auction-state-aware pages (not admin's login gate) |
| `bidPriceFor`, `teamCanAffordBid`, `spentOf`, `squadCountOf`, `remainingOf`, `reserveNeeded` | team.js (bid buttons), moderator.js (floor eligibility) |
| `toast`, `showModal`, `closeModal`, `escapeAttr` | all four |
| `downloadCSV`, `downloadJSON`, `stampedName`, `triggerDownload` | admin.js (Data & Reset exports), moderator.js (`exportCSV`) |
| `fmtMoney`, `fmtTime`, `watchConnection`, `genKeyString` | all four / admin+moderator |

No page currently redefines a `shared.js` name (verified by grep; re-check
if this ever looks close — a silent shadow is worse than a crash).

## 5. CSS: theme.css vs. public.js's own injected sheet

Two separate `.pv-*` namespaces exist and **do not overlap except by
design**:

- **`css/theme.css`** (linked, applies to all four pages) owns the *shared
  lot component*: `.pv-lot`, `.pv-lot-grid`, `.pv-name`, `.pv-eyebrow`,
  `.pv-meta`, `.pv-tag`, `.pv-bid*`, `.pv-leader*`, `.pv-photo*`,
  `.pv-toast`, `.pv-burger*`. If you change how the player-on-the-block
  looks, this is almost always the file to edit — a change here reaches
  public.js, moderator.js, and team.js at once.
- **`js/public.js`'s `pvCss()`** (injected into `<head>` at runtime, public
  page only) owns sections that only exist on the public page: the home
  screen (`.pv-hero*`), the results table (`.pv-table`, `.pv-pill`,
  `.pv-thumb`, ...), the teams grid (`.pv-team*`), status banners
  (`.pv-banner*`), the "next player coming up" panel (`.pv-next*`), and the
  full-screen sold takeover (`.pv-takeover*`, z-index 9000 — under the
  fireworks canvas at 9999 so bursts land on top of the card). It stays up
  `TAKEOVER_SECONDS` (5) with a circular countdown pinned to the top-right of
  the screen. **The digit and the close are driven by one chain of 1-second
  `setTimeout`s (`tickSoldTakeover`); the ring is a CSS animation of the same
  length and is purely visual.** Change the duration in `TAKEOVER_SECONDS`
  only — the ring's `animation-duration` and the reduced-motion step count are
  passed inline from it. Like the fireworks it avoids `setInterval`/wall-clock
  stop conditions (§7a), and its constants sit above the `recentSales` listener
  for the same TDZ reason as the `__fw` state.
  Editing one of these classes only ever affects `index.html`.
- Deliberately shared across both (utility classes, not a bug):
  `.pv-live-dot`, `.pv-no-bs`, `.pv-unit`.

To re-derive this split after a big CSS change (or to find a new collision
before it ships), run:

```js
// classes theme.css defines vs classes public.js's pvCss() defines
const re = /\.(pv-[\w-]+)/g;
```
extract matches from both, diff them — see git history around
`public-js-glass-redesign.md` (memory) for the one-liner used to build the
table above, and the Bootstrap-collision audit script (§6).

## 6. Known collisions — check before naming a new class

Three real bugs shipped from name collisions with Bootstrap, now fixed and
guarded. **Before adding any class that isn't `pv-`-prefixed, check it
against Bootstrap's own component names** — Bootstrap 5.3.3 is loaded on
every page now.

| collision | what broke | fix in place |
|---|---|---|
| `.row` | `styles.css` had its own `.row{display:flex;gap:10px}` form helper; it leaked into Bootstrap's grid and wrapped every 12-column row | renamed to `.field-row` in styles.css + its 4 call sites |
| `.toast` | Bootstrap's `.toast:not(.show){display:none}` hid every popup outright | renamed to `.pv-toast` everywhere (shared.js sets the class, styles.css/theme.css style it) |
| `.card` | Bootstrap's `.card{display:flex;flex-direction:column}` silently changed every card's layout | `theme.css`'s `.card` rule forces `display:block` |
| grid `1fr` tracks | `.floor{grid-template-columns:1fr}` — a `1fr` track's implicit min-width is `auto` (= min-content), so a wide row of buttons pushed the whole card past a phone's viewport instead of wrapping | `theme.css` floors every such track at `minmax(0,1fr)` and sets `min-width:0` on `.pv-lot-grid` children |
| CSS vars on the wrong scope | custom properties declared on `.pv-scope` (not `:root`) resolved to nothing for the header, which sits outside it — a gradient-filled brand mark and a `background-clip:text` bid number both went invisible with no console error | all tokens live on `:root` in `theme.css`, prefixed `--pv-*` so they can't collide with styles.css's `--ink`/`--line`/etc. |

Full narrative and the audit script that finds new collisions: memory file
`public-js-glass-redesign.md` (`[[public-js-glass-redesign]]`).

## 6a. Other fixed bugs worth knowing about

Not Bootstrap collisions, but the same "silent, no-console-error" character
as the ones above — easy to reintroduce without realizing it.

| bug | what broke | fix in place |
|---|---|---|
| `recentSales` keyed by a random push id | Selling, releasing, then re-selling the same player left TWO rows in Live Results — one stale (old team/price), one current — and every total that reads the results log (Live Results chips, the all-done summary, public's home-screen stats) double-counted the released sale | `markSold`/`markUnsold`/`confirmAssignPlayer` in moderator.js now write to `recentSales/<playerId>`, not a push key, so a re-sale overwrites the same row instead of adding one. `doRelease`, `returnToPool`, `deletePlayer` (moderator.js) and `confirmDeleteAdminPlayer`, `confirmDeleteTeam`, `confirmDeleteAllTeams` (admin.js) all now also delete that player's `recentSales/<id>` row when undoing their sale — **any new code path that returns a sold player to pending, or deletes one, must do the same** or a stale row reappears. |
| `ensureAnonymousAuth()` reused ANY signed-in user | Firebase Auth's default persistence is shared across every tab of the same origin. If an admin was signed in (even in another tab) and someone then opened moderator.html/team.html and entered a key, `ensureAnonymousAuth()` silently reused the **admin's real uid** instead of creating a fresh anonymous one, tying `sessions/<uid>` to the wrong identity — the likely cause of "sometimes login misbehaves after signing out." | It now checks `user.isAnonymous` and signs in fresh (with `SESSION` persistence, scoping the identity to that one tab) whenever the current user is missing or non-anonymous. Nothing here depends on the anonymous uid staying stable across a sign-out — `claimKey()` re-authorizes whatever uid is current the moment a key is typed. |
| `signOutAll()` didn't await `auth.signOut()` | A fast sign-out-then-sign-in-again could race Firebase's own async teardown, since the caller (`doSignOut()` on all three gated pages) cleared local session state and re-rendered before Firebase had actually finished | `signOutAll()` is now `async` and awaits `auth.signOut()`; all three `doSignOut()`s await it before clearing `session`/`tSession`/`adminState.session`. Covered by `tests/auth.test.js`, which proves ordering with a controllable held-open sign-out — don't remove those `await`s. |
| `styles.css`'s base input rule omitted `input[type=password]` | The admin login's password field never got `width:100%`/`padding`/`font-size` from styles.css (only `input[type=text], input[type=number], select, textarea` were listed), so it rendered browser-default-sized next to a full-width email field — `theme.css`'s override includes password but only sets color/border, assuming the base sizing was already there | `input[type=password]` added to styles.css's base selector. If you ever add a new `input[type=...]` anywhere, add it to **both** styles.css's base rule and theme.css's override, not just one. |
| `signInAnonymously()` rejects with `auth/admin-restricted-operation` | Not a code bug — Firebase throws this specific code only when the **Anonymous** sign-in provider is disabled in that Firebase project's console (README §2 says to enable it, but a new/rebuilt project can easily skip it). Moderator/team logins would fail with Firebase's raw text, `"This operation is restricted to administrators only."`, which reads like an app permissions bug, not a one-console-toggle fix. | `ensureAnonymousAuth()` catches that specific error `code` and rethrows a message naming the actual fix (Console → Authentication → Sign-in method → enable Anonymous). **If a user reports this error, the fix is telling them to flip that console setting — there is no code-only fix**, since this project has no server-side deploy step that could do it for them. |
| a moderator/team login in another tab signs the organizer out, and admin.js didn't notice | Reported as "most of the time I have to sign out and sign in again before I can generate keys." Two defects compounding. **(a)** Firebase docs, auth-state-persistence: *"if one tab switches from `local` to `session` persistence, other tabs using `local` persistence will have that user signed out."* `adminLogin()` uses the default LOCAL persistence; `ensureAnonymousAuth()` (moderator/team) **must** switch to SESSION to scope itself to its own tab — so opening moderator.html or team.html in the same browser signs the organizer out of admin.html. **(b)** `admin.js`'s `onAuthStateChanged` only ever *set* `adminState.session`; it had no branch for the user going away. Since that's plain page state, the console kept rendering as signed in while `auth.uid` was null, and every write failed `accessKeys/$key`'s `admins/<auth.uid> === true` rule. The writes had no `catch`, so a rejection became an unhandled promise rejection: no error, no key, button appears dead. | `onAuthStateChanged` now clears the session (+ `clearSession()`, + a toast naming the remedy) whenever a session exists but the user is missing or anonymous, so the UI tells the truth and shows the login. `createModeratorKey`/`createTeamKey`/`revokeKey`/`reactivateKey` wrap their writes and report via `adminActionError()`, which turns PERMISSION_DENIED into "sign in again, then retry". Covered by `admin-isolation.test.js` (uses the new `ctx.__auth.emitUser()`). **Root cause then fixed too:** `admin.html` now carries `data-pv-app="admin"` and `shared.js` gives it its own named Firebase app, so its auth storage is namespaced (`firebase:authUser:<apiKey>:admin`) and the other pages' persistence switch can't reach it — the two sessions coexist. The (a) defences above are kept deliberately: they still catch a genuinely expired or revoked credential. |
| browser autoplay policy silently kills a sound played after an `await` | Audio only plays if it can be traced to a user gesture. `markSold()` is `async`, so anything after its first `await db.ref().update(...)` may have lost that activation — `play()` then returns a **rejected promise and no sound**, with nothing in the console unless you catch it. | `playSoldSound()` is called in `markSold()` **after the `if(!player \|\| !team) return;` guards but before the first `await`**, so it still runs synchronously inside the click. Don't move it below the writes. It also guards `typeof Audio === 'undefined'` (the test VM has no `Audio`) and swallows both constructor and `play()` errors — a missing or blocked sound must never take the sale down with it. |
| the same constraint, for the sold sound on the PUBLIC big screen | Nobody ever clicks `index.html` — it's the unattended projector page — so it has no gesture at all to spend, not even a mistimed one. Confirmed in a real (non-headless-stub) Chrome: calling the unlock from a plain `<script>` tag with no real click gets its `play()` genuinely rejected by the browser, not by any code here. | `index.html`'s header has a static `#soundToggle` button, `onclick="enablePublicSound()"` (public.js). That click is real activation, so `enablePublicSound()`'s `play()` succeeds; it then immediately `.pause()`s + rewinds so nothing is heard, sets `publicSoundEnabled`, and disables the button. `playPublicSoldSound()` (called from `maybeCelebrateNewSale()`, same gate as the takeover/fireworks) is a no-op until that flag is true. **Safari's autoplay policy is element-specific** — the unlock only carries forward to *that exact* `<audio>` element, not to a fresh `new Audio(...)` — so `publicSoldSound` is one module-level instance, reused (rewound via `currentTime = 0`) for both the unlock and every later play, same as moderator.js's `soldSound`. Declared above the `recentSales` listener for the same TDZ reason as the `__fw`/takeover state (§7a). |
| fireworks/takeover stayed silent when the SAME player was released and re-sold | Sales are keyed by player id (`recentSales/<playerId>`, see the first row), so a re-sale OVERWRITES the player's one row rather than adding another. The gate in `maybeCelebrateNewSale()` decided "is this a new sale" by comparing the newest row's **id** alone, and an overwritten row has the same id, so the re-sale looked unchanged and nothing fired. | The gate compares `saleKey()` = `id + ':' + time`. `saleRecord()` stamps a fresh `time: Date.now()` on every write, so id + time identifies one specific sale *event*. `fireworks.test.js` builds each fixture sale with a FIXED time per id (a real re-render returns the stored row byte-for-byte); it previously used a fresh `Date.now()` per call, which made "same sale" differ by a millisecond ~1 run in 9 once the gate looked at time. **Any new code that decides whether a sale is "new" must key on id + time, not id.** |
| `nav.tabs button` never reset the generic `button{}` rule's `box-shadow`/`backdrop-filter`, or `button:hover`'s `transform` | Same shape of bug as the ones above, in the same file: `nav.tabs button{}` was written as a flat, transparent pill (`background:transparent; border:none`) but never touched those three properties, so they fell through from the less-specific generic `button` rule anyway — CSS only overrides a property a more-specific rule actually *declares*. Every nav tab carried an always-on inset ring plus its own 12px blur stacked on the header's own much stronger one, and lifted 1px on hover — looked exactly like a stray highlight/glow bleeding onto the page content just below the header. | `nav.tabs button` now explicitly sets `box-shadow:none` and `backdrop-filter:none`; `nav.tabs button:hover` sets `transform:none`. `.pv-burger` (the hamburger) had the same `backdrop-filter` leak, fixed the same way. **Whenever a rule is written to override a generic element style down to "flat/plain," explicitly zero out every property the generic rule sets — a property that's simply never mentioned still applies.** |

## 7. Test suite — which one to run

All in `tests/`, pure Node (`vm` module + jsdom-free string assertions on
real rendered HTML), **no npm install, no browser**. They stub Firebase and
the DOM, load the real `js/*.js` files unmodified into a VM context, and
assert on what gets rendered or written.

```
node tests/run.js                    # everything (379 checks, well under 1s)
node tests/run.js render markup      # only the named suites
node tests/run.js --list             # see suite names
```

| suite | file | asserts | run it when you touch |
|---|---|---|---|
| `render` | render.test.js | every tab/state on all 4 pages renders without throwing or leaking `undefined`/`NaN`/`[object Object]` | any render function's template string, on any page — the cheap first check |
| `markup` | markup.test.js | the same states produce tag-balanced HTML (no unclosed `<div>`) | same as above, when the edit reshuffles nested tags rather than just text |
| `flow` | flow.test.js | `js/moderator.js`'s action functions write the *correct* Firebase payload (sold/unsold/skip/next/pause/resume/complete/reopen/disconnect); that `recentSales` stays one row per player through release/return/delete and a resale overwrites rather than duplicates; the retain/assign feature (`assignPlayerPrompt`/`confirmAssignPlayer`), **including that it writes `via:'assigned'`** (the one fact `soldLabel()`/the fireworks gate/the takeover gate all branch on); and that the SOLD hammer sound fires on a real sale but **not** on unsold or assign (`ctx.__audio`, via the `Audio` stub in `tests/lib/dom-stub.js`) | `markSold`, `markUnsold`, `skipPlayer`, `nextPlayer`, `pauseSession`, `pauseBidding`, `resumeSession`, `resetBid`, `completeBidding`, `reopenAuction`, `attachListeners`, `doRelease`, `returnToPool`, `deletePlayer`, `assignPlayerPrompt`/`confirmAssignPlayer` — or anything else that touches `recentSales` |
| `bidsteps` | bidsteps.test.js | the team owner's +1/+2 buttons: pricing (`bidPriceFor`), per-button affordability, and what `placeMyBid` writes | `shared.js`'s `bidPriceFor`/`teamCanAffordBid`, or `team.js`'s bid buttons/`placeMyBid` |
| `endgame` | endgame.test.js | the real end-of-auction journey: last player sold → moderator's "All Players Auctioned" panel → Complete Bidding → public home screen → results-on-request | moderator's all-done panel or `completeBidding()`; public's `renderHomeScreen()`/`togglePastResults()` |
| `admin-isolation` | admin-isolation.test.js | admin sign-out writes nothing and never pauses the auction; admin UI still works while paused+completed; moderator-only functions don't leak into admin.js; **a credential lost underneath an open admin tab (null or anonymous) clears the session, says so, and falls back to the login screen — and a rejected key write reports the remedy instead of silently doing nothing** | `admin.js` sign-out/session handling or its `onAuthStateChanged`, the `accessKeys` write paths, or before assuming a moderator helper is moderator-only |
| `retained-label` | retained-label.test.js | `soldLabel()` itself (assigned/auction/legacy-no-`via`/no-sale-found, always lowercase); `renderSalesTable()`'s badge text AND that its CSS class stays `sold` (green) for a retained row — only the word changes; moderator.js's Players tab, Summary tab, `editPlayerPrompt`'s status hint and `confirmDeletePlayer`'s title+body, each checked for BOTH a retained and a real-sale player so neither wording regresses into the other; admin.js's Players tab; and public.js's own independently-implemented results table (it doesn't call `renderSalesTable` — see §4) | `soldLabel`/`renderSalesTable` (shared.js), moderator.js's Players/Summary tabs or its edit/delete-player modals, admin.js's Players tab, or public.js's own results-table markup |
| `auth` | auth.test.js | **admin.html gets its own named Firebase app while the other three stay on the default — asserted from both ends (shared.js honours `data-pv-app`, and the HTML actually sets it);** `ensureAnonymousAuth()` never reuses a non-anonymous session and scopes new ones to the tab; `signOutAll()` and every page's `doSignOut()` genuinely await Firebase's sign-out before clearing local session state; a disabled-Anonymous-provider rejection gets translated into an actionable message that reaches the login screen | `shared.js`'s app init / `ensureAnonymousAuth` / `signOutAll`, any page's `doSignOut()`, or the `<html>` tag of any page |
| `fireworks` | fireworks.test.js | `maybeCelebrateNewSale()` (public.js): never fires on first load or a re-render of the same sale, fires for a real auction sale (tagged or untagged `via`), never fires for 'unsold' or for `via:'assigned'`; **fires again when the same player is released and re-sold (same id, new time), not again on a re-render of that re-sale, and stays silent if that re-sale turns out unsold or assigned** | public.js's sale gate (`maybeCelebrateNewSale`/`saleKey`), or shared.js's `saleRecord()`/`via` tagging |
| `takeover` | takeover.test.js | `soldTakeoverMarkup` content (incl. the circular 5→0 timer, its ring duration and reduced-motion step count both derived from `TAKEOVER_SECONDS`, `aria-hidden`), HTML-escaping of player/team names, and graceful degradation on missing fields; the real tick chain — digit reads 4,3,2,1,0 at one second apiece (5s total), then a 300ms fade and removal; Escape / tap closes early and a stale pending tick then does nothing; a second sale replaces rather than stacks; and that it is wired to the fireworks gate exactly (not on first load, repeat render, unsold or assign; **does** show again for a released-and-re-sold player, with the new team and price); and that it never references `TEMP_FIREWORKS_ENABLED` | public.js's takeover (`soldTakeoverMarkup`/`showSoldTakeover`/`tickSoldTakeover`/`dismissSoldTakeover`) or `maybeCelebrateNewSale` |
| `public-sound` | public-sound.test.js | `enablePublicSound()`: success unlocks + updates `#soundToggle` + confirms with a toast; a genuinely rejected `play()` leaves `publicSoundEnabled` false and the button retry-able, with an error toast; missing `Audio` doesn't throw. `playPublicSoldSound()`: silent before enabling (even for a real new sale), wired to the same gate as the takeover/fireworks once enabled (first load, repeat, unsold, assign, re-sale — same matrix as `takeover`), and reuses one `<audio>` element rather than rebuilding it. Plus: `index.html` has `#soundToggle` wired to `enablePublicSound()`, and the other three pages don't | public.js's `enablePublicSound`/`playPublicSoldSound`/`updateSoundToggle`, `index.html`'s `#soundToggle`, or `maybeCelebrateNewSale` |

**What these tests do NOT catch** — they run in a headless `vm` context with
a fake DOM, not a real browser: no actual CSS is applied, so a visual/layout
bug (wrong color, broken responsive breakpoint, an element rendering off
sedge, backdrop-filter not applying) will not fail any suite here. For a
CSS-only or visual change, the check is a real screenshot (Chrome headless,
`--force-device-scale-factor=1` — Windows Chrome won't open a window
narrower than ~500px, so phone widths need a fixed-width iframe wrapper),
not this test suite. Don't report "tests pass" as evidence a visual change
looks right.

**Fast-path policy:**
- Touching one page's render function only → run that page's suites
  (`render` + `markup` always apply; add `flow`/`bidsteps`/`endgame` if the
  function they cover is the one you touched).
- Touching `js/shared.js` → run the full suite. Every page depends on it
  (§4); there is no safe subset.
- Touching `css/theme.css` or `css/styles.css` → tests won't catch a visual
  regression at all (see above); take a screenshot instead. Do still run
  `render`+`markup` if the edit could plausibly affect class names the JS
  checks for (e.g. `disabledCount` in bidsteps.test.js parses for
  `pv-bid-btn` in the markup).
- A copy-only change (button label, hint text) → the suite most likely to
  reference that exact string in an assertion (grep tests/ for the old
  string) plus `render`. If nothing greps, skipping is reasonable — the
  point of this file is to make that judgment call quickly, not to force
  ceremony.
- Never skip tests entirely for a multi-file change spanning more than one
  page or touching `shared.js`/`theme.css` — run the full suite before
  calling the task done.

## 7a. Temporary features currently live

- **Fireworks on sold** (`js/public.js` only, added 2026-09-27): a full-screen
  canvas particle animation fires when a new **real live-auction** sale
  appears in `recentSales` while `index.html` is open — NOT for the
  moderator's pre-auction "Assign" action (`confirmAssignPlayer` in
  moderator.js), which also writes a `result:'sold'` row but tags it
  `via:'assigned'` in `saleRecord()` (shared.js) specifically so this feature
  can tell the two apart; `maybeCelebrateNewSale()` is the gate that checks
  it. Entirely self-contained in `public.js` — search that file for
  `TEMP_FIREWORKS` / `__fw` to find all four pieces (two `let`s near the top,
  the call to `maybeCelebrateNewSale()` in the `recentSales` listener, that
  function itself, and the animation near the foot of the file, before
  `pvCss()`). The `via` tag itself is NOT part of this and stays even if the
  feature is removed — it's also how the results log tells a retained player
  apart from an auction sale. Flip `TEMP_FIREWORKS_ENABLED` to `false` to
  disable without deleting anything, or delete all four pieces to remove it
  entirely. Respects `prefers-reduced-motion`. The stop condition is "no
  bursts left to fire and no particles still alive," not a wall-clock timer —
  an earlier version used `Date.now()` for that and it both threw a
  `ReferenceError` on every page load (see below) and, separately, didn't
  reliably terminate under every timing regime it was tested against; don't reintroduce
  wall-clock-based timing for the stop condition if this gets extended.
  **Real bug this shipped with and fixed**: the two `let` state variables
  were originally declared near the bottom of the file, below the
  `recentSales` listener that reads them. Firebase's `.on('value', cb)` can
  resolve synchronously from local cache, which is enough to hit the
  temporal-dead-zone and throw — any `let`/`const` a listener reads must be
  declared before that listener is registered, not just before it's
  logically "used" elsewhere in the file.

## 8. Things that look like bugs but aren't

- `js/public.classic.js` is dead code by design (a revert snapshot), not an
  orphaned file to clean up.
- `images/default.png` is a JPEG. Intentional, browsers don't care about the
  extension mismatch.
- Three `.pv-*` classes are deliberately defined in both theme.css and
  public.js's `pvCss()` (§5) — that's a shared utility, not duplication to
  merge.
