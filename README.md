# Auction House — Multi-Portal Cricket Auction

Four static pages, one shared Firebase Realtime Database:

| Page | Who it's for | Access |
|---|---|---|
| `index.html` | Spectators | Open to anyone, read-only |
| `admin.html` | You (the organizer) | Real Firebase email/password login |
| `moderator.html` | Auction moderator | Moderator **key** (generated on the admin page) |
| `team.html` | Team owners | Team **key**, one per team (generated on the admin page) |

Everything (players, photos, teams, live bid, results) lives in Firebase and updates on every screen in real time.

---

## 1. Where do I enter my Firebase credentials?

**`js/firebase-config.js`** — that's the only file you edit for setup.

```js
window.FIREBASE_CONFIG = {
  apiKey: "...",
  authDomain: "...",
  databaseURL: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

Get these values from **Firebase Console → Project Settings (gear icon) → General → Your apps → SDK setup and configuration**. If you haven't added a "Web app" to your Firebase project yet, do that first (Project Settings → Add app → Web `</>`).

A template is provided at `js/firebase-config.example.js` — copy it to `js/firebase-config.js` and fill in the real values. `firebase-config.js` is listed in `.gitignore`, so it won't get committed.

### Important: this isn't actually a secret, and `.env` files don't work here

I know you asked for a `.env` file — worth explaining why that's not quite the right tool here, and what to do instead:

- **`.env` files need a build step to work.** They're read at *build time* by tools like Vite, webpack, or Next.js, which bake the values into the shipped JS. GitHub Pages just serves whatever files you push — there's no build step, so a `.env` file sitting in your repo would never actually get read by the browser. This project intentionally has **no build step**, so it can be pushed straight to GitHub Pages.
- **The Firebase web config above is not a secret anyway.** `apiKey`, `projectId`, etc. are meant to be visible in your shipped JavaScript — every Firebase web app on earth ships them in the browser, and Google's own docs say so explicitly. Anyone can already see them in your deployed site's dev tools no matter how you build it, and that's fine by design.
- **What actually protects your data is `database.rules.json`** (Section 3 below). That's the real security boundary — it's enforced on Google's servers, not in the browser, and it's what stops a random visitor from writing fake bids even though they can see your config.

So: `js/firebase-config.js` is gitignored purely so you can keep this repo generic/reusable without your personal project ID sitting in git history — not because it needs to be hidden from the deployed site. If you'd still like your GitHub repo's *commit history* to never contain the values (e.g. you're making the repo public before deploying), see "Optional: injecting config via GitHub Actions" at the bottom — that uses GitHub's real secret store and writes `firebase-config.js` only at deploy time.

---

## 2. Enable the Firebase products you need

In the Firebase Console for your project:

1. **Build → Realtime Database → Create Database** (any region, start in locked mode — you'll paste real rules in step 3).
2. **Build → Authentication → Sign-in method** → enable:
   - **Anonymous** (used by the moderator/team portals so Database Rules can check *who* is writing, without making every team owner create a full account)
   - **Email/Password** (used only for your one admin login)

---

## 3. Paste in the security rules

**Realtime Database → Rules** tab → replace everything with the contents of `database.rules.json` in this project → **Publish**.

What these rules actually enforce:
- Anyone can *read* players/teams/current-bid (so `index.html` works with no login).
- Only the admin account or someone holding a valid, non-revoked **moderator** key can write players, teams, or settings.
- Someone holding a valid **team** key can only ever set *their own* team as the bid leader — never bid on behalf of another team, and only while bidding is actually open (not between lots, and not while the auction is paused).
- The **moderator cannot place bids at all.** They can clear the current leader (to reset a bid or move to the next player) but the rules reject any write that names a team as leader. Bids can only come from the team portals.
- Access keys themselves can only be created/revoked by the real admin account; a key can be looked up (validated) by anyone typing it in, but the full list can't be browsed by non-admins.
- A person's "session" (which role/team their browser is tied to) can only be written by that person, and only if it matches a real, active key.

This is solid for a community/friends auction. It is **not** hardened against a determined attacker trying to forge exact bid amounts (e.g. nothing server-side stops a modified client from sending a price that skips the increment) — the moderator visually confirming every "SOLD" is your real-world backstop, the same way a human auctioneer is. If you want that last mile closed too, the natural next step is moving bid validation into a Cloud Function (requires the paid-but-still-free-at-this-scale "Blaze" plan) — happy to help with that later if you want it.

---

## 4. Create your first admin account

1. **Authentication → Users → Add user** → enter your own email + a password.
2. Copy the new user's **UID** (shown in the users list).
3. **Realtime Database → Data** tab → add a node: `admins` → `<paste UID>` → value `true` (boolean).

That's it — you can now sign in at `admin.html`.

> **Upgrading an existing setup?** `database.rules.json` changed (bidding is now gated on the auction being open and unpaused, and moderators are blocked from setting a bid leader). Re-paste it into **Realtime Database → Rules** and click **Publish**, or the new pause/resume behaviour won't be enforced server-side.

---

## 5. Deploy to GitHub Pages

1. Push this whole folder to a GitHub repo (making sure `firebase-config.js` — not the `.example.js` one — exists locally with your real values; `git status` should **not** show it if `.gitignore` is working).
2. Repo → **Settings → Pages** → Source: deploy from branch → pick `main` and `/ (root)`.
3. Your site will be live at `https://<username>.github.io/<repo>/`.
4. Back in Firebase, **Authentication → Settings → Authorized domains** → add `<username>.github.io` (Firebase blocks auth from unrecognized domains by default).

---

## 6. Running an auction, end to end

1. **You** sign in at `admin.html` → generate a **moderator key** → send it to whoever's running the show.
2. **Moderator** opens `moderator.html`, enters the key, and in the **Setup** tab creates teams + settings, then in **Players** adds the player pool.
3. **(Optional) Retentions.** Before the auction starts, the moderator can hand a player straight to a team at an agreed price — the **Assign** button on a pending player's row in the **Players** tab. It skips the live floor entirely and records the deal immediately: the player's squad, purse and the results log all update exactly as if they'd been sold live.
4. **You** go back to `admin.html` — teams now show up in the dropdown — generate one **team key** per team, send each to that team's owner.
5. **Team owners** open `team.html` on their own laptop/phone and enter their key. They now see live purse, squad, and a bid button that's only active for the current lot.
6. **Moderator** presses **Put Up First Player** on the Auction Floor. Team owners bid live from their own devices — the moderator never bids, they just watch the purses and confirm the outcome with **SOLD** / **UNSOLD** / **Skip**.
7. After each result the floor holds: everyone watching sees *"next player coming up"* until the moderator presses **▶ Next Player**. That's the cue to build a bit of suspense.
8. Anyone can watch the whole thing live, read-only, at `index.html` — good for a projector screen.
9. **Moderator** presses **🏁 Complete Bidding** when the auction is over. The live view returns to its home screen and just offers the previous results.
10. Go to `admin.html` → **Data & Reset** to download everything.

---

## 7. Player photos

Photos are **ordinary files committed to the `images/` folder**. Firebase only ever stores the relative path (e.g. `images/kohli.jpg`), so the photos are served by GitHub Pages right alongside the rest of the site and keep working after deploy.

**To add a photo:**

1. Drop the image file into the `images/` folder of the project.
2. In the moderator's **Players** tab, use the **Player Photo** picker. Choosing a file fills in the path and shows you a preview — you can also just type `images/kohli.jpg` yourself.
3. Commit and push the image along with everything else.

> The browser can't write into your repo, so step 1 is a manual copy — picking a file in the form only records the path and previews it. If you push the app without pushing the image, that player falls back to the default photo.

Notes:
- Players with no photo (or a path that 404s) show **`images/default.png`**.
- Bulk add takes a photo as the 4th column: `Virat Kohli, Batsman, 15, kohli.jpg`. A bare file name is stored as `images/kohli.jpg`.
- A full `https://…` URL works too and is used as-is.
- Any shape or size is fine — photos are cropped to a uniform square in the browser (`object-fit: cover`), so the layout stays even. Roughly square images around 400×400 look best.

---

## 8. During the auction

**Bidding is team-owners-only.** The moderator console has no bid button — it shows every team's live purse read-only, and the moderator's job is to call the result. This is enforced in the Database Rules too, not just hidden in the UI.

**One player at a time, on the moderator's cue.** After **SOLD**, **UNSOLD** or **Skip**, the floor deliberately goes quiet: spectators and team owners see *"Next Player Coming Up"* and the last result, and nothing new appears until the moderator presses **▶ Next Player**. A skipped player stays in the pool but won't be re-offered immediately (unless they're the only one left).

**Live results** replace the old "Recent Sales" strip. `index.html`, the moderator's **Live Results** tab and the admin's **Live Auction** tab all show the same table — every lot as it was called, newest first, with photo, category, base price, result, buying team, price and time. Each player has exactly one row, reflecting their current outcome — release a sold player (Teams tab, or "Return to Auction Pool" on Edit) and their row disappears until they're sold again, so a re-auctioned player is never shown twice or double-counted in any total.

**Pause and resume.** Bidding can be paused three ways, and all of them behave the same: the **⏸ Pause Bidding** button on the auction floor, signing out, or simply closing the tab / losing connection. While paused, no team owner can bid (enforced in the Database Rules, not just the UI) and spectators see a "paused" notice. Nothing is lost. The moderator resumes with **▶ Resume Bidding** on the floor, or — after signing back in at `moderator.html` **with the same moderator key** — with the **▶ Resume Session** banner. Either way it picks up on the exact same player, at the exact same bid, with the same leader. The console tells you *why* it paused, so you can tell "I paused this" apart from "the moderator's laptop dropped off the wifi".

This is entirely separate from `admin.html`. The organizer signing in or out never pauses anything, and the admin page works normally whatever state the auction is in.

**Finishing up.** When the last player has gone through, the auction floor turns into an **All Players Auctioned** panel with a summary and one clear action: **🏁 Complete Bidding Session**. You can also end early — the same button sits on the auction floor and between lots, and warns you about anyone still on the block or left unauctioned. Either way it closes the auction. `index.html` drops back to a **home screen** saying no auction is running, with a single **📋 View Previous Bidding Results** button — the results table and final squads are one click away rather than on show. Team owners see "Bidding Complete" with their final squad. Nothing is deleted, and **↺ Reopen Auction** on the moderator console puts everything back the way it was if you closed it by mistake or want to run another round with the leftover players.

---

## 9. Organizer tools (`admin.html`)

Beyond issuing keys, the admin page has tabs for:

- **Teams** — every team's budget, spend, remaining purse and full squad, with a delete button (deleting a team returns its players to the pool and removes its access keys).
- **Players** — the whole pool with photos, searchable and filterable by status, showing who bought each player and for how much. Deleting a sold player refunds the buying team.
- **Live Auction** — read-only view of the current lot, current bid, who's leading, every team's purse, and the live results table. It also tells you whether bidding is running, paused (and why), between lots, or complete.
- **Data & Reset** —
  - **Downloads** (generated in your browser, nothing is uploaded): auction results CSV, live results log CSV, team squads CSV, and a full JSON backup of everything.
  - **Danger zone**: reset the bidding session (keeps teams and players, clears all results and refills purses so you can re-run the same auction), delete all players, delete all teams, delete all moderator keys, or wipe everything. The destructive ones make you type `DELETE` first. **Take a backup before using these — none of it can be undone.**

---

## Project structure

```
index.html            public live view (read-only)
admin.html             organizer: create/revoke keys
moderator.html          auction control (gated by moderator key)
team.html                 team owner bidding (gated by team key)
css/styles.css              structure + layout, shared by all pages
css/theme.css                Liquid Glass look, loaded after styles.css
images/
  default.png                 fallback photo for players with no image
  <your-player-photos>        commit these; Firebase stores only the path
js/
  firebase-config.example.js   template — copy to firebase-config.js
  firebase-config.js            <-- YOUR CREDENTIALS GO HERE (gitignored)
  shared.js                      Firebase init, session/key logic, shared rules
  public.js / admin.js / moderator.js / team.js   per-page logic
database.rules.json      paste into Firebase Console → Realtime Database → Rules
.gitignore
```

---

## Optional: injecting config via GitHub Actions (only if you want it out of git entirely)

Since GitHub Pages has no server, the only way to truly keep `firebase-config.js` out of your committed source *and* have it work is to generate that file at deploy time from GitHub's encrypted **Secrets**, using a GitHub Actions workflow instead of Pages' "deploy from branch" option:

1. Repo → **Settings → Secrets and variables → Actions** → add secrets: `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_DB_URL`, `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_SENDER_ID`, `FIREBASE_APP_ID`.
2. Add a workflow (`.github/workflows/deploy.yml`) that, on push to `main`, writes `js/firebase-config.js` from those secrets (a simple `echo`/`envsubst` step) and then deploys the folder with `actions/deploy-pages`.
3. Switch Pages' source to "GitHub Actions" instead of "Deploy from a branch".

This is purely a source-hygiene nicety, not a data-security one — remember, the values still ship to every visitor's browser either way, and `database.rules.json` remains the thing actually protecting your data. Say the word if you'd like me to write that workflow file out for you.
