# CLAUDE.md: context for Claude Code

Read this first in every session. It records what this project is, how it's built, the decisions already made, and what's next.

## What this is

**SIPs** (called Corpus planner until Sep 2026; the repo keeps its name, wealth-calculator): a personal Indian mutual fund app for the owner and their family, self-hosted on GitHub Pages, with five pages (`site/js/app.js` switches them by URL hash):

- **Home** and **Portfolio** (`site/js/portfolio.js`): the owner's SIPs from inception, entered by hand or imported from a CAMS + KFintech CAS PDF (with or without a password), read in the browser by `site/js/cas.js`. Value, money in, gain and XIRR; SIPs due next; groups by category, fund house, plan or goal, with a **Log in at …** pill to each fund house's site.
- **Explore funds** (`site/js/explore.js`): rank any mix of SEBI categories and picked funds by a chosen measure, computed from AMFI NAVs, with Direct/Regular/both, top N, years running and fund house filters. Tick up to 5 funds to compare.
- **Compare** (`site/js/compare.js`, reached from Explore): growth of ₹10,000, the category's typical fund and a benchmark the owner can change.
- **Plan** (`site/js/planner.js`): SIP, step-up SIP and SWP calculator, shown as an editable sentence, with an editable calculation engine.
- **Google Sheet sync** (`site/js/sync.js` + `sheets/Code.gs`): optional. Keeps the plan and portfolio in a Sheet the owner owns, and in step across devices. From Code.gs v3, a login (name and password) replaces the secret, with per-device sessions. From v4, family profiles: the owner invites members, each with their own login and portfolio in the same Sheet.
- **Lock** (`site/js/lock.js` + `site/js/security.js`): a 6-digit PIN per device, the password, and fingerprint or face (passkey PRF) open the site; personal storage is encrypted at rest; auto-lock after N minutes away.
- **Fund data update** (`site/js/update.js`, through Code.gs): "Update now" re-enables and dispatches the nightly GitHub workflow with a token held in the script's properties; an optional daily Apps Script trigger does the same when GitHub pauses it.
- **Drive archive** (`pipeline/archive.py` + `sheets/Archive.gs`): optional. The nightly job keeps each day's NAVAll.txt and a monthly copy of the NAV history in the owner's Google Drive.

## Owner's requirements (decided, don't change without asking)

- Mutual funds only for now. Shares come later.
- No AI anywhere in the data path. Numbers come from official sources: AMFI first. NSE, SEBI and CAMS were considered; NSE and SEBI publish no NAV feed, and CAMS/KFintech supply only the owner's own statement.
- Accuracy over completeness: leave a figure blank rather than guess it.
- Self-hosted: a public GitHub repo, a nightly GitHub Actions job, GitHub Pages. No server.
- Portfolio data is private. It lives in the browser (localStorage) and, once the owner connects it, in their own Google Sheet through their own Apps Script. Never in the repo or the published site.
- Decided 27 Sep 2026:
  - For the owner and family only, not a public service.
  - The Sheet's tabs stay readable, not encrypted.
  - The planned login gets recovery by security questions plus a one-time recovery code.
  - Benchmarks are configurable: an index fund stands in by default, and the owner can pick one or more funds per fund or per category and save them.
  - No Gmail CAS fetch.
  - Nightly tests stay as they are.
  - The name is "SIPs", with no repo rename.
  - Fund house, MF Central, CAMS and KFintech links, plus in-app CAS import. No PAN-based fetch, since no legal free API exists.
  - The statement import keeps the whole folio, the nominees' names, registrar, ARN/DIRECT, KYC and PAN status (never the PAN), demat, statement cost and value, and the exit load wording (owner asked, 27 Sep 2026). Name, PAN, email, phone, address and bank never.
  - A fetch button so a paused nightly workflow doesn't leave the data stale: done through the Sheet's script (GitHub token in Script properties), plus an optional daily check.
  - Separate profiles in one Sheet (owner asked, 27 Sep 2026): up to 8 people, each with their own login, portfolio, plan and benchmarks, and each sees only their own in the app. The owner sees everyone's in the Sheet (Member column). Chosen over a Sheet per person.
- Google Sheets goes through an Apps Script web app bound to the Sheet, the same pattern as the owner's other apps: no Google Cloud project, no OAuth client, nothing to renew. The owner chose this over Google Identity Services. Every request carries a secret, so it isn't an open URL.

## Layout

```
pipeline/            nightly data build (Python 3.12, requests + numpy)
  amfi.py            fetch + parse NAVAll.txt and the NAV history report; columns found by header NAME
  mfapi.py           MFapi.in client, backfill of older history only
  store.py           history store; same compact JSON format for the cache and the site
  metrics.py         returns, rolling 3Y, drawdown, volatility, Sharpe, consistency vs category median
  build.py           orchestrator; run(cfg, cache_dir, out_dir, net, today, archive) takes an injectable `net` and `archive` for tests
  archive.py         Drive archive client: daily NAVAll.txt.gz, monthly history as ~5 MB .tar.gz parts; never fails the build
  schemedata.py      AMFI scheme master CSV -> launch date per code (+ the scheme's first launch); last good copy in .cache
  links.py           checks pipeline/links.json (MF Central, CAMS, KFintech, ~43 fund houses) nightly -> site/data/links.json
  config.json        sections/plans/options filters, extra_schemes, risk-free rate, limits (benchmarks default in build.py)
  tests/             pytest, 57 tests, fixtures in AMFI's real old (6-col) and new (8-col) formats
tests/cas.test.js    node:test for site/js/cas.js against a made-up statement laid out like pdf.js reads a real one
sheets/Code.gs       Apps Script sync backend, pasted into the owner's Sheet unchanged (@OnlyCurrentDoc)
sheets/Archive.gs    Apps Script Drive archive, a separate standalone project (needs Drive scope, so kept apart)
sheets/tests/        node:test against fake-google.js, an in-memory SpreadsheetApp/DriveApp/Properties/Lock/Content/UrlFetch/ScriptApp
                     code.test.js (sync), login.test.js (login, recovery, devices, GitHub update),
                     profiles.test.js (v4 family profiles), archive.test.js
site/                static site: index.html, manifest.webmanifest, icons/, css/app.css,
                     js/{common,lock,planner,explore,compare,cas,portfolio,sync,security,update,app}.js
site/vendor/         Chart.js 4.4.1 and PDF.js 5.4.624 (legacy build, .mjs renamed .js), served by the site itself; see its README
.github/workflows/nightly.yml  02:00 IST: tests -> build (+ Drive archive) -> Pages deploy; .cache kept via actions/cache; keepalive job
.github/workflows/tests.yml    pytest + node tests on pull requests
                               Both use Node 24 action majors (checkout/setup-python/setup-node v7, cache v6, configure-pages v6,
                               upload-pages-artifact v5, deploy-pages v5) on a pinned ubuntu-24.04 runner; bump deliberately.
```

## Data pipeline rules

1. `NAVAll.txt` from AMFI is the source of truth for the latest NAV, category, plan and option. The build stops, and the previous site stays up, if its newest NAV is more than 7 days old.
2. **AMFI changed NAVAll.txt on 19 Aug 2026**, inserting `Plan;Option` before `Net Asset Value`. The parser maps columns by header name and handles both layouts. Plan and option come from those columns, or from the scheme name in the old format.
3. MFapi.in was reported to have stopped updating after 18 Aug 2026, but in the first live run (26 Sep 2026) its data was current to within a week. It's used only to backfill older history, fill-only: it never overwrites an existing day.
4. Every night the AMFI NAV history report is fetched for the last `verify_days` (7), plus any gap since a scheme's last stored NAV. AMFI values overwrite the cache; each correction is counted and logged in `site/data/meta.json`. The history report changed too (seen live on 26 Sep 2026): `Scheme Code;NAV Name;Plan;Option;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Date`. Its parser needs only code, NAV and date. A report with no rows for the tracked schemes counts as a failed check, not a clean one.
4a. NAVAll.txt can carry NAVs dated after the day of the build (seen live on Saturday 26 Sep: some dated 27 Sep). They're kept as published, but the build's `nav_date` is the newest date on or before today. `meta.json` lists them under `navall_ahead`.
4b. Drive archive (only when the ARCHIVE_URL and ARCHIVE_SECRET repository secrets exist): right after download, the raw NAVAll.txt bytes go up as `NAVAll/<yyyy>/<mm>/NAVAll-<IST download date>.txt.gz`. Same md5 the same day stores nothing; a different file becomes `-2`. After the build, the history (`.cache/nav`, `index.json`) goes up as .tar.gz parts when the last copy is 30+ days old. Parts land in `Incoming <id>` and are swapped in by `snapshotCommit`; the newest 2 are kept. Any archive failure is logged and reported in `meta.json` `archive`, and never stops the build.
4c. Pages source must be **GitHub Actions**, not "Deploy from a branch": site/data isn't in the repo. The `keepalive` job re-enables `nightly.yml` via `gh api PUT .../enable` on scheduled runs, so GitHub's 60-day inactivity pause doesn't lapse the schedule.
5. Metrics are left blank when the needed NAV is more than 10 days from its target date. Since-launch CAGR is blank for funds whose data starts around Apr 2006 (the start of AMFI's history), and for schemes without a full MFapi backfill.
6. History file format (the cache in `.cache/nav/` and the site in `site/data/nav/`): `{"c": code, "s": "YYYY-MM-DD", "t": [0, gap, gap...], "v": [nav...]}`. `t` is day gaps from the previous NAV.
7. `site/data/funds.json` holds one row per active open-ended scheme, keyed `c n a g k p pl o i i2 v d h m l L`. `m` is the metrics object (`r1 r3 r5 r10 si rr3med rr3min rr3n cons mdd5 vol3 sh3 age inc`) or null. `l` is the plan's launch date and `L` the scheme's first launch when earlier, both from AMFI's scheme data (`DownloadSchemeData_Po.aspx?mf=0`, columns by header name). Blank when AMFI gives none. Top level: `cats` {"<category>|<plan>": {f, n, s}} and `bench` {category: {i: index, c: code, n: name}}.
8. The typical fund (`site/data/cat/<f>.json`, the same compact format with `c` = "category|plan") is the median of the tracked funds' Friday-to-Friday returns, chained from 100. It starts on the first week with `category_min_funds` (3) funds.
9. The default benchmark per equity category is an index fund standing in for the index, because NSE, not AMFI, publishes index values. `benchmarks` in DEFAULT_CONFIG gives name regexes; the Direct Growth plan with the longest history wins. A category with no match gets none.
10. Links: `pipeline/links.json` is hand-kept. The nightly check marks a site `ok: false` only for 404/410, DNS failure or connection refused, which the app hides. 403, 429, 5xx and timeouts count as `ok: null` and stay shown. `meta.json` `links` lists broken sites and fund houses with no entry (`no_link`).
11. Scheme data, category medians, benchmarks and links never stop the build; each reports in `meta.json` (`scheme_data`, `categories`, `benchmarks`, `links`).

## Front-end conventions

- Plain classic scripts, no build step, no framework. Chart.js 4.4.1 and PDF.js are served from `site/vendor/`, not a CDN: no third-party script runs on the page that holds the portfolio or reads the statement.
- `planner.js` came from a self-contained calculator. All its selectors are scoped to `#view-plan`. Don't reuse its IDs, or `data-key` / `data-focus` attributes, on other pages.
- Script order: index.html loads only `common.js` and `lock.js`. lock.js shows the lock screen if `mf-lock:v1` exists, and once unlocked (or straight away) appends planner, explore, compare, cas, portfolio, sync, security, update, app with `async=false`. An inline head script adds `html.locked` before paint, so nothing of the app shows while locked.
- Shell (`app.js`): views `home portfolio explore compare plan` (Compare highlights Explore in the nav). Forms live in panels (`.panel`, `role=dialog`): `panelImport`, `panelAdd`, `panelSheet`, `panelBench`, and the plan's `planRail`. `[data-open-panel="<id>"]` (optional `data-focus-sel`) opens one, `[data-panel-close]`, the scrim and Esc close it; focus is trapped, then returns to the opener (or, if it was redrawn, to the element with its id or `data-focus`). `window.Shell.openPanel(id, focusSel)`, `closePanel()`, `isOpen(id)`; the old `openDrawer`/`closeDrawer` still work.
- Cross-page events on `document`: `mf:view` {view}, `mf:theme`, `mf:add-sip` {code}, `mf:picks` {list} (funds ticked to compare, `window.Picks`), `mf:panel` {id, open}, `mf:storage` {key}, `mf:account` {signedIn, keys, hold, joined, recovered} (sync.js to security.js).
- Panels also include `panelSecurity` (rendered by security.js into `#secBody`) and `panelData` (update.js). Home has `#dataStale` (data over 30 h old) and `#acctNote` (sign in / signed out). `window.Planner.addRate(pct)` adds a return rate to the planner.
- Storage goes through `MF.store` (planner.js uses it too). With the lock on, every `corpus-planner:*` and `mf-*` key except `corpus-planner:theme` and `mf-lock:v1` is stored as `enc1:` + base64url(iv ‖ AES-GCM ciphertext) under the device's data key, and read from memory once unlocked (`store.useVault`). Cross-tab changes arrive as `mf:storage` {key} (decrypted first): listen with `MF.onStorage`, never `window` 'storage'. `store.raw` bypasses the vault.
- localStorage keys: `mf-lock:v1` (plain: user, the data key wrapped by PIN / password / passkey PRF, PIN tries, auto-lock minutes, the Sheet URL for recovery while locked), `corpus-planner:v1`, `corpus-planner:engine`, `corpus-planner:theme`, `corpus-planner:view`, `mf-explore:v1` (cats, funds, plan, metric, top, age, amc, sel, range, cmp), `mf-compare:v1` (range, anchor), `mf-bench:v1` ({cat: {category: [codes]}, fund: {code: [codes]}}), `mf-portfolio:v1`, `mf-portfolio:v1:view` (scope, mode, group, range), `mf-sync:v1` (the Sheet URL, secret or session, user, version, hold, cursor and per-record sync state), `mf-charts:v1` (chosen chart types: plan, planMix, pfTime, pfMix, pfMixBy, exFund, exList). The `corpus-planner:*` and `mf-*` names stay, so nothing already saved is lost.
- Shared components in `common.js`:
  - `MF.picker(select, {search, minWidth, title})` puts a button and panel in front of a native `<select>`, which stays as the value holder: code keeps reading `.value` and `change`. Options can carry `data-desc`, `data-sub` and `data-label`. After setting `.value` in code, call `MF.refreshPickers()`. On phones the panel is a bottom sheet.
  - `MF.typeSwitch(el, {label, types, value, onChange})` renders native radios with icons, so arrow keys work.
  - `MF.pref`/`MF.setPref` store chart choices.
  - Chart.js plugins: `barValues` for value labels at bar ends, and `donutCenter`.
  - The icon sprite is in index.html (`#i-*`); use `MF.icon(name)`.
  - `MF.combo(input, list, {find, html, pick})`: a searchable listbox (keyboard and mouse); items with `head` are group headings. `MF.searchFunds(D, q, {limit, filter})` ranks funds by name words.
  - `MF.loadFunds()` (funds, `cats`, `bench`), `loadHistory(code)`, `loadCat(D, key)`, `loadLinks()` then `amcSite(name)` → {name, url} (https only, not `ok: false`), `shortAmc`, `launchYear(f)`.
- Layout breakpoints:
  - ≥1024px: left side nav with the Google Sheet card and theme switch; the Explore table.
  - <1024px: bottom tab bar; Explore shows `#exCards`.
  - ≥760px panels are drawers on the right; <760px they're bottom sheets, and Explore's extra filters fold behind `#exToggle`.
  - `.seg.block` must keep `padding:2px`.
- Chart forms (from the dataviz method):
  - line/area/bars for anything over time; donut/pie/bars only for "What you hold", which has at most 5 named slices plus a gray "Other" (`--c-other`).
  - The ranking uses horizontal bars in one hue; yearly returns use blue for gains and crimson for losses.
  - No 2-slice pies and no dual axes.
  - Palette validated with the dataviz validator (adjacent pairs) in both themes: light c5/c6 were made more saturated, and dark c1–c6 were redrawn inside the dark lightness band. `--stamp` stays the UI accent.
- Sync hooks: `planner.js`, `portfolio.js` and `compare.js` fire `mf:changed` {what: 'plan' | 'portfolio' | 'bench'} after every save, and `portfolio.js` fires `mf:valued` with the figures it just showed. `sync.js` reads and applies data through `window.Planner.syncGet/syncSet`, `window.Portfolio.syncGet/syncSet/snapshot` and `window.Bench.syncGet/syncSet`, and fires `mf:synced` after applying another device's changes.
- Portfolio groups (`groups(by)`): category, fund house (`f.a`, or the statement's `amc`), plan, goal (`h.goal`, set on the card) and asset class (the mix chart). A fund that couldn't be valued stays in its fund house or goal group; otherwise it goes to "Couldn't be valued". The login pill comes from `amcSite()`; with no match there's no pill. MF Central, CAMS and KFintech are in `#pfPortals`.
- Portfolio pricing for manual entries: first NAV on or after the debit date, with 0.005% stamp duty from 1 Jul 2020. CAS imports use the statement's own units. The page checks opening units plus computed units against the CAS closing units.
- CAS import (`cas.js`, `window.CasReader`):
  - `read(ArrayBuffer, password, progress)` loads `vendor/pdfjs/pdf.min.js` with a dynamic `import()`. `parse(pages)` is pure: pdf.js text items become rows (±2.5 pt, touching pieces joined without a space), then a state machine.
  - The state machine reads: AMC line, `Folio No`, the scheme heading (can wrap, ISIN drawn in pieces, `Registrar :` / `KFINTECH` on its own row), `Opening Unit Balance`, dated transaction rows (numbers placed in Amount/Units/Price/Balance by the table header's column centres), then `Closing Unit Balance` / `NAV on` / `Total Cost Value` / `Market Value on`.
  - Transaction types use casparser's names (PURCHASE, PURCHASE_SIP, REDEMPTION, SWITCH_IN/OUT(_MERGER), DIVIDEND_PAYOUT/REINVEST, STAMP_DUTY_TAX, STT_TAX, TDS_TAX, REVERSAL, SEGREGATION), plus BONUS, TRANSFER_IN/OUT and MISC. A wordless charge row counts as stamp duty only when it's 0.005% of a same-day purchase.
  - Every scheme is checked (opening + units = closing, and each printed running balance), as is the total value against the page-1 summary. Name, PAN, email, phone and address are never read into the result, and the password is never stored.
  - Also read per scheme: `folio` (whole, "12345678/90"), `rta`, `advisor` ("ARN-…" or "DIRECT"), `demat`, `kyc` and `pan_ok` (statuses from the folio line, not the PAN), `nominees` (names from "Nominee 1: … Nominee 2: …"), `cost`, and `load` (the exit load wording after the closing balance, up to 9 rows or 800 characters, stopped at the KYC reminder "Please ensure…", which can break over rows).
  - `importCas` keys holdings by ISIN + the folio's last 4 characters, so statements imported when only "••••1234" was kept still merge; it then stores the whole folio. `casFacts()` copies rta/advisor/demat/kyc/panOk/nominees/load/stmt from the newest statement. ELSS lock-in (`elssLock`): units bought in the last 3 years, with the next free date.
  - `importCas` merges by ISIN + folio. The new statement replaces its own period's transactions, and older ones stay. Holdings carry `from`, `asOf` and `openUnits`, and ids are kept so sync updates rather than replaces.
  - Checked against a real CAMS + KFintech statement: every scheme's units add up, and the value matches the summary. No statement, or anything from one, goes in the repo (`*.pdf` is gitignored); fixtures are made up.
- Google Sheet sync rules (`sync.js`, `Code.gs`):
  - Records are `holdings/<id>`, `settings/plan`, `settings/portfolio` (CAS warnings and period), `settings/bench` (benchmark choices; any `settings/<id>` is accepted, so v1 of `Code.gs` syncs it too), plus `snapshot/latest` (the valuation, written by devices, never pulled). The newest `at` (ms, corrected by the server's clock) wins. A tie keeps the stored copy, and a losing change gets the stored copy back in `rejected`. Deletions are tombstones and are never purged.
  - Server: one row per record in the hidden `_data` tab, JSON split over 8 cells of 45,000 characters, each piece marked `~` and written as plain text. `rev` in Script Properties is a cursor for incremental pulls. `epoch` changes on erase, which makes devices resync and push what they hold.
  - The plan's `tab`, `chartMode` and `valueMode` stay per device. The edited engine source isn't synced; it's code, and it stays on the device that wrote it.
  - On connect, what the device already holds is stamped `at = 1`, so data already in the Sheet wins. An untouched (default) plan is never sent.
  - The Sheet's own address is never sent to devices or shown in the app (owner's decision, 27 Sep 2026: family members use the app, only the owner opens the Sheet). sync.js drops any `sheetUrl` saved by older versions.
  - The `SECRET` lives in Script properties, never in `Code.gs`. The URL and secret live only in `mf-sync:v1`. Readable tabs (Portfolio, Investments, Transactions, Plan) are rebuilt after every write; strings pass through `text_()` against formula injection.
  - `Code.gs` VERSION 2 (Sep 2026) added Fund house and Goal to the Investments tab and named the menu SIPs. `Archive.gs` renames a *Corpus planner archive* folder to *SIPs archive* rather than starting a new one.
  - `Code.gs` VERSION 3 (27 Sep 2026): the login and the fund data update.
    - Open actions (no secret or session): `hello` {account}, `login` {user, auth, device}, `questions` {user}, `recover` {user, rec, newAuth, newRec}; `register` needs the secret and no existing login.
    - With a login, every other action needs `session`; the secret alone gets `login: true`. A session unknown or idle 400 days gets `signedOut: true`; a session with no login gets `noAccount: true`. Without a login, the secret works as before.
    - Script properties: `account` {user, auth: sha256(auth proof), rec: sha256(recovery proof), q[3]}, `sessions` {sha256(token): {n, c, s}} (max 20), `guard` (login: 5 tries then 15 min doubling to a day; recover: 3 tries then 1 h doubling), `watch` (last daily check), `repo` (learned from the site). The owner sets `SECRET`, and for the data update `GITHUB_TOKEN` (fine-grained, this repo, Actions read/write) and `GITHUB_REPO` (the daily check has no site to learn it from; seen 27 Sep 2026 when the owner ran `checkNightly` first), optionally `GITHUB_BRANCH`.
    - Signed-in actions: `devices`, `signOut` {which: 'others' | id prefix}, `logout`, `changePassword` {auth, newAuth, others}, `newRecovery` {auth, questions, rec}, `dataStatus` {repo}, `dataRefresh` {repo}.
    - `dataRefresh` enables the workflow (any disabled state) and dispatches `nightly.yml` on `main`, unless a run is going or started under 10 minutes ago. `checkNightly()` (daily trigger from the menu) enables only `disabled_inactivity`, and dispatches only when the last success is over 26 h old.
    - Menu: Keep the nightly data update running / Check it now / Stop the daily check, Sign out every device, Remove the login (back to the secret).
  - `Code.gs` VERSION 4 (27 Sep 2026): family profiles. No new permissions.
    - Accounts are one Script property each, `acct:<user>` {user, role 'owner' | 'member', auth, rec, q, created}. `accounts_()` moves v3's `account` to `acct:<user>` as the owner. The first login (`register`) is the owner. At most 8 people (`MAX_PROFILES`).
    - Data: the owner's records keep their v3 keys (`holdings/x`); a member's are `@<user>|holdings/x` (`keyOf_`, `memberOf_`; names can't hold `|`). `sync_(body, who)` reads and writes only `who.member` (the owner's is ''), so two people can use the same ids. `epoch` stays Sheet-wide.
    - Sessions `{sha256(token): {u, n, c, s}}`: 12 per person, 40 in all. `auth_` answers {session, user, role, member}; the secret, while no login exists, is the owner.
    - Guards are per name: `login:<user>`, `login:?` (unknown names), `recover:<user>`, `join:?`. A wrong name no longer pauses the real user's logins.
    - Open action `join` {invite, user, auth, rec, questions, device}: an invite is 10 Crockford base32 characters (shown XXXXX-XXXXX), stored as its sha256 in `invites` {hash: {exp, by}}, used once, good for 7 days, at most 5 open.
    - Owner-only actions (`ownerOnly_`, else `notOwner: true`): `members` (people, device counts, last seen, open invites, `kept`), `invite` {user?}, `cancelInvites`, `removeMember` {user, erase}. Removing drops the login and sessions; the records stay unless `erase`. The owner can't be removed from the site.
    - Kept names (`kept_`): live records under `@<user>|` with no `acct:<user>` (removed members, or everyone after Remove the login). Only an invite made for that name (`invite` {user}, stored with `user`) can join as it; a plain invite, or `register`, can't take a kept name. `removeMember` {user, erase: true} erases a kept name's records.
    - `devices`, `signOut`, `changePassword`, `newRecovery` and recovery act on the caller's own sessions only.
    - Readable tabs: with more than one person (members, or a removed member's kept records), every tab starts with a Member column, Plan has a column per person, and Portfolio adds a per-person total and a Family total (its XIRR blank: the tab lacks the cash flows). With only the owner, the tabs keep the v3 layout.
    - Menu: Sign out every device and Remove the login act on everyone (every `acct:*`, sessions, guards and invites); the data stays.
- Keys (lock.js; the same derivation on every device):
  - user = trimmed, lower case, single spaces. master = PBKDF2-SHA256(password, "SIPs login v1|" + user, 600,000). auth = HKDF(master, "SIPs auth") as base64url, sent to the script. data = HKDF(master, "SIPs data"), an AES-GCM key that wraps the device's random 32-byte data key and never leaves the device.
  - recovery proof = HKDF(PBKDF2(answers + "\n" + code, "SIPs recovery v1|" + user), "SIPs recovery"). Answers keep only letters and digits, lower case. The code is 20 characters of Crockford base32 (shown XXXXX-XXXXX-XXXXX-XXXXX), used once: `recover` sets a new one.
  - PIN key = PBKDF2(PIN, random 16-byte salt, 600,000). 5 wrong PINs delete the PIN copy. Passkey key = HKDF(PRF output, "SIPs biometric"); offered only when the platform authenticator reports PRF.
  - A password that doesn't open the local copy but that the Sheet accepts (changed or recovered elsewhere) rebuilds the device: its encrypted keys are deleted, a new data key is made, and sync pulls everything back.
  - Sign-out semantics: on `signedOut`, sync.js resets its state first (so nothing is read as a deletion), removes the portfolio, plan and bench keys, and reloads; the Sheet keeps everything.
- Family profiles on the site:
  - A device holds one person's copy. `Sync.enter(url, r, keys)` follows every login, join and recovery. If `otherPerson(url, r)` (another Sheet, another user, or a secret-mode device, which is the owner's, signing in as a member), it asks first, then `switchPerson`: fresh sync state, the portfolio/plan/bench keys removed, the lock rewrapped for the new person with the last person's PIN and passkey copies dropped (`Lock.rewrap(keys, true)`), and a reload. The new person opens it with their password and chooses their own PIN. Otherwise it carries on, or `begin()`s for a device never connected.
  - Invite link: `<site>#join=<base64url(web app URL)>.<10-character code>`. security.js reads it, puts `#home` back in the address bar, and opens the Sheet panel with the join form (`Security.joinForm`). The Sheet panel's login box also has "Join with an invite" for a typed code. The link carries the web app URL, never the Sheet's address.
  - Security shows Family (owner only): members with device counts, kept names with Invite again and Erase, Add a family member (link + code, copy button), Cancel unused invites, and Remove (optionally erasing). "Your login" names the role.
- Design (from the owner-approved mockups, including the PIN lock screen): Anek Latin for figures and headings, IBM Plex Sans for text, Plex Mono only for code (Google Fonts, with fallbacks). Indigo `--accent` #2E44B2 on a #F2F3F7 background with white cards, the validated c1–c6 series colours, crimson for losses and withdrawals. The chart code still reads the older names (`--muted`, `--rule`, `--stamp`, `--wd`, `--cond`…), which are aliases of the new tokens. Sentence case everywhere, no all-caps labels, plain active-voice copy. Keep light/dark tokens in sync; both themes exist.

## How to test

```bash
pip install -r pipeline/requirements-dev.txt
python -m pytest -q pipeline/tests
node --test sheets/tests/*.test.js       # Code.gs and Archive.gs against simulated Google services
node --test tests/*.test.js              # the CAS reader
python pipeline/build.py                 # needs network: www/portal.amfiindia.com, api.mfapi.in
python -m http.server -d site 8000
```

The site was also smoke-tested in jsdom against pipeline-built synthetic data: rankings, fund chart, planner hand-off, manual SIP, CAS import with a units check, and failure states. XIRR was verified: a SIP in a fund growing exactly 12% a year gives 12.00%. Those harness scripts aren't in the repo.

Google Sheet sync was tested end to end in Chromium (Playwright). Two browser profiles acted as two devices, with the Apps Script URL routed to the real `Code.gs` running on `fake-google.js`. The test covered connect, both directions, removal, offline then back, conflicting edits, two tabs, CAS import to the Transactions tab, a wrong secret, another app's URL, and a phone-width dark layout. That script isn't in the repo either.

The lock and the login (27 Sep 2026) were tested the same way, with Code.gs v3 on fake-google.js:
- Encryption at rest (no fund name in plain storage), nothing of the app loaded while locked, wrong and right PINs, 5 wrong PINs then the password and a new PIN.
- Fingerprint unlock through a CDP virtual authenticator with PRF, two unlocked tabs in step, auto-lock after time away, turning the lock off.
- Making the login on a secret-connected device, a secret-only device asked to sign in (keeping its data), a new phone signing in and choosing a PIN, the devices list, signing out every other device (the signed-out device's copy removed, the Sheet untouched).
- Recovery from the lock screen, then a device signed out by it opening with the new password from its lock screen and resyncing; the old recovery code refused.
- Update now: the stale banner, a paused workflow switched on and dispatched, the run followed to success.

Family profiles (27 Sep 2026) were tested the same way, with Code.gs v4:
- The owner connects with the secret, makes the login and makes an invite link. Asha opens it on a phone (dark), joins, chooses a PIN and adds a fund.
- Each person sees only their own funds, and the Investments tab has the Member column.
- The owner's secret-mode device, asked to sign in, is taken over by Asha after the confirm; none of the owner's funds reach Asha's profile.
- Ravi joins with a typed code. The owner removes him and keeps his data: his device is signed out and emptied, and Family lists him with Invite again. That invite refuses another name, and Ravi, joining with his own, gets his fund back.
- The owner removes Ravi again, with erase: his rows leave the Sheet, and his device is signed out and emptied.
- An unused invite is cancelled and then refused.
- The owner's PIN-locked device is signed out and handed to Asha. The owner's PIN copy is gone, the owner's password doesn't open it, and Asha's password and her own new PIN do.
- No password, answer or invite code is kept in the script's properties.

The rebuilt UI (27 Sep 2026) was tested the same way, on synthetic data, at 1440px light and 390px dark:
- Statement PDFs: one without a password imports at once; a locked one asks, explains a wrong password, then merges (the same statement twice adds nothing).
- Every fund-house group and fund card has its login pill, and it opens the site in a new tab.
- Goals (Enter keeps, Esc cancels), remove, and chart types that stay chosen.
- Explore: chips, Direct/Regular/both with the commission gap, top N, years running, fund house, reset, and the compare tray.
- Compare: 3 funds plus the typical fund and the benchmark; the benchmark saved per category, then per fund, then back to the default.
- The plan sentence opens its panel on the right input, and focus comes back.
- Theme switch, no sideways scroll on any page, bottom sheets on a phone.

## Status

- **Live runs:**
  - **First, 26 Sep 2026** (run 36255044912). NAVAll.txt parsed: 14,396 schemes, 3,941 tracked, header as `navall_new.txt`. The history report failed on its new header (fixed; rule 4), and some NAVs were dated the next day (rule 4a).
  - **Second, the same evening** (run 36259996296). The history report parsed with no warning. 708 schemes had 27 Sep NAVs, and nav_date correctly stayed 25 Sep. The build took 34 s with the cache.
  - Both runs stopped at `configure-pages`, because Pages wasn't set to GitHub Actions yet. The owner first chose "Deploy from a branch", which published the README.
  - **Third, 26 Sep 19:03 UTC** (run 36264684959, the first with the archive code and secrets). It built and deployed. The archive failed: Google answered with a web page instead of JSON, most likely a sign-in page (access not Anyone), the /dev or editor URL, or a deployment made before the code was saved. `archive.web_page()` now names the cause in the log. This run was 00:33 IST on 27 Sep, so the 27 Sep liquid-fund NAVs counted as today, and nav_date was 27 Sep (rule 4a).
- Pages is on GitHub Actions and deploying (runs 3 and 4). Still open: the owner fixes the archive's Apps Script deployment; check the next run's `Archive:` log lines. Read run logs through the GitHub tools: the Claude Code on the web environment blocks amfiindia.com and api.mfapi.in, so `build.py` can't run there. Once the Drive archive is on, real NAVAll files are in the owner's Drive; they're the source for replacing the fixtures' illustrative rows.

- **Redesign mockups** (27 Sep 2026): https://claude.ai/artifact/V1dMckEyKxQeQP58yYNZ3R (private; a Design canvas). The owner approved them, and the UI was rebuilt to match, except the PIN lock screen, which comes with the security work. It has Home, Portfolio (grouped by category), Explore (multi-select categories and funds, Direct and Regular, top N, running for), Compare (growth of ₹10,000, the category median dashed, the benchmark dotted, a benchmark editor), Plan (a sentence to edit, and "what your corpus is made of"), a PIN lock screen, and Home and Explore on desktop with a left nav.
  - Proposed look: Anek Latin for figures and headings, IBM Plex Sans for text, indigo #2E44B2, the existing validated c1–c6 series colours, cards on #F2F3F7, and a dark variant (the `dark` tweak).

## Proposed next steps (confirm with the owner)

The owner's 9-point request of 27 Sep 2026, in this order (each its own change):

1. **Done:**
   - Name "SIPs".
   - In-browser CAS import, with `tools/` removed.
   - Nightly launch dates, category medians, benchmarks and link checks.
   - Mockups published (see Status).
   - The UI rebuilt to the mockups: Home, grouped Portfolio with login pills and goals, Explore filters, Compare with the editable benchmark, and the Plan sentence and corpus donut.
   - Security: login with sessions, encrypted local data, a PIN per device (5 tries), fingerprint or face via passkey PRF, auto-lock, signing out devices, recovery by 3 questions plus a one-time code, menu resets. Code.gs v3.
   - The statement's folio, nominees, registrar, distributor, KYC/PAN status, cost and exit load; ELSS lock-in.
   - "Update now" and the daily check for a paused nightly workflow.
   - Separate family profiles in one Sheet (Code.gs v4).
2. **Owner to do after merging:** paste Code.gs v4 and deploy a new version (Manage deployments → New version; no new permissions after v3). If not done for v3: run `checkNightly` once to allow its permissions, make the login on the site, add `GITHUB_TOKEN` and `GITHUB_REPO`, and choose SIPs → Keep the nightly data update running. Then invite family members from Security → Family.
3. **Still open, not scheduled:**
   - Capital gains from the statement's transactions (FIFO, the ₹1.25 lakh LTCG allowance, STCG/LTCG split), and units still under exit load.
   - Swap the fixtures' illustrative rows for real ones from the Drive archive.
   - Rankings summary to the Sheet.
   - TER and AUM from AMFI.
   - Shares, later.
