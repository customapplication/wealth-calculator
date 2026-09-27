# CLAUDE.md: context for Claude Code

Read this first in every session. It records what this project is, how it's built, the decisions already made, and what's next.

## What this is

**SIPs** (called Corpus planner until Sep 2026; the repo keeps its name, wealth-calculator): a personal Indian mutual fund app for the owner and their family, self-hosted on GitHub Pages, with three pages:

- **Plan** (`site/js/planner.js`): SIP, step-up SIP and SWP calculator with an editable calculation engine.
- **Explore funds** (`site/js/explore.js`): rank each SEBI category's funds by a chosen measure, computed from AMFI NAVs.
- **My portfolio** (`site/js/portfolio.js`): the owner's SIPs from inception, entered by hand or imported from a CAMS + KFintech CAS PDF, read in the browser by `site/js/cas.js`. Shows value, money in, gain and XIRR.
- **Google Sheet sync** (`site/js/sync.js` + `sheets/Code.gs`): optional. Keeps the plan and portfolio in a Sheet the owner owns, and in step across devices.
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
sheets/tests/        node:test against fake-google.js, an in-memory SpreadsheetApp/DriveApp/Properties/Lock/Content
site/                static site: index.html, manifest.webmanifest, icons/, css/app.css, js/{common,planner,explore,cas,portfolio,sync,app}.js
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
- Cross-page events on `document`: `mf:view` {view}, `mf:theme`, `mf:add-sip` {code}. `window.Planner.addRate(pct)` adds a return rate to the planner.
- localStorage keys: `corpus-planner:v1`, `corpus-planner:engine`, `corpus-planner:theme`, `corpus-planner:view`, `mf-explore:v1`, `mf-portfolio:v1`, `mf-portfolio:v1:view`, `mf-sync:v1` (the Sheet URL, secret, cursor and per-record sync state), `mf-charts:v1` (chosen chart types: plan, pfTime, pfMix, pfMixBy, exFund, exList).
- Shared components in `common.js`:
  - `MF.picker(select, {search, minWidth, title})` puts a button and panel in front of a native `<select>`, which stays as the value holder: code keeps reading `.value` and `change`. Options can carry `data-desc`, `data-sub` and `data-label`. After setting `.value` in code, call `MF.refreshPickers()`. On phones the panel is a bottom sheet.
  - `MF.typeSwitch(el, {label, types, value, onChange})` renders native radios with icons, so arrow keys work.
  - `MF.pref`/`MF.setPref` store chart choices.
  - Chart.js plugins: `barValues` for value labels at bar ends, and `donutCenter`.
  - The icon sprite is in index.html (`#i-*`); use `MF.icon(name)`.
- Layout breakpoints:
  - ≤1000px: each `.rail` (inputs) becomes a slide-up sheet opened by a `.fab`. `window.Shell.openDrawer(id, focusSel)` opens one, and a page switch closes only other pages' panels.
  - ≤760px: bottom tab bar, the Explore table becomes `#exCards`, Explore's extra filters fold behind `#exToggle`, and the portfolio table becomes cards.
  - `.seg.block` must keep `padding:2px`, because `.block` is also the sheet-section class.
- Chart forms (from the dataviz method):
  - line/area/bars for anything over time; donut/pie/bars only for "What you hold", which has at most 5 named slices plus a gray "Other" (`--c-other`).
  - The ranking uses horizontal bars in one hue; yearly returns use blue for gains and crimson for losses.
  - No 2-slice pies and no dual axes.
  - Palette validated with the dataviz validator (adjacent pairs) in both themes: light c5/c6 were made more saturated, and dark c1–c6 were redrawn inside the dark lightness band. `--stamp` stays the UI accent.
- Sync hooks: `planner.js` and `portfolio.js` fire `mf:changed` {what: 'plan' | 'portfolio'} after every save, and `portfolio.js` fires `mf:valued` with the figures it just showed. `sync.js` reads and applies data through `window.Planner.syncGet/syncSet` and `window.Portfolio.syncGet/syncSet/snapshot`, and fires `mf:synced` after applying another device's changes. Script order: `cas.js` before `portfolio.js`; `sync.js` after `portfolio.js` and before `app.js`.
- Portfolio pricing for manual entries: first NAV on or after the debit date, with 0.005% stamp duty from 1 Jul 2020. CAS imports use the statement's own units. The page checks opening units plus computed units against the CAS closing units.
- CAS import (`cas.js`, `window.CasReader`):
  - `read(ArrayBuffer, password, progress)` loads `vendor/pdfjs/pdf.min.js` with a dynamic `import()`. `parse(pages)` is pure: pdf.js text items become rows (±2.5 pt, touching pieces joined without a space), then a state machine.
  - The state machine reads: AMC line, `Folio No`, the scheme heading (can wrap, ISIN drawn in pieces, `Registrar :` / `KFINTECH` on its own row), `Opening Unit Balance`, dated transaction rows (numbers placed in Amount/Units/Price/Balance by the table header's column centres), then `Closing Unit Balance` / `NAV on` / `Total Cost Value` / `Market Value on`.
  - Transaction types use casparser's names (PURCHASE, PURCHASE_SIP, REDEMPTION, SWITCH_IN/OUT(_MERGER), DIVIDEND_PAYOUT/REINVEST, STAMP_DUTY_TAX, STT_TAX, TDS_TAX, REVERSAL, SEGREGATION), plus BONUS, TRANSFER_IN/OUT and MISC. A wordless charge row counts as stamp duty only when it's 0.005% of a same-day purchase.
  - Every scheme is checked (opening + units = closing, and each printed running balance), as is the total value against the page-1 summary. Folios keep only their last 4 characters; name, PAN, email, phone and address are never read into the result, and the password is never stored.
  - `importCas` merges by ISIN + folio. The new statement replaces its own period's transactions, and older ones stay. Holdings carry `from`, `asOf` and `openUnits`, and ids are kept so sync updates rather than replaces.
  - Checked against the owner's redacted 1-year statement (12 pages, 28 schemes, CAMS and KFintech): all 28 add up, and the value matches the summary. The PDF isn't in the repo (`*.pdf` is gitignored); fixtures are made up.
- Google Sheet sync rules (`sync.js`, `Code.gs`):
  - Records are `holdings/<id>`, `settings/plan`, `settings/portfolio` (CAS warnings and period), plus `snapshot/latest` (the valuation, written by devices, never pulled). The newest `at` (ms, corrected by the server's clock) wins. A tie keeps the stored copy, and a losing change gets the stored copy back in `rejected`. Deletions are tombstones and are never purged.
  - Server: one row per record in the hidden `_data` tab, JSON split over 8 cells of 45,000 characters, each piece marked `~` and written as plain text. `rev` in Script Properties is a cursor for incremental pulls. `epoch` changes on erase, which makes devices resync and push what they hold.
  - The plan's `tab`, `chartMode` and `valueMode` stay per device. The edited engine source isn't synced; it's code, and it stays on the device that wrote it.
  - On connect, what the device already holds is stamped `at = 1`, so data already in the Sheet wins. An untouched (default) plan is never sent.
  - The `SECRET` lives in Script properties, never in `Code.gs`. The URL and secret live only in `mf-sync:v1`. Readable tabs (Portfolio, Investments, Transactions, Plan) are rebuilt after every write; strings pass through `text_()` against formula injection.
- Design: a "passbook" look using IBM Plex Sans, Plex Sans Condensed for figures, and Plex Mono only for code. Ink #16233F, stamp indigo #2F4BA0, crimson #B7324A for withdrawals, scenario colours from rupee notes. Sentence case everywhere, no all-caps labels, plain active-voice copy. Keep light/dark tokens in sync; both themes exist.

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

## Status

- **Live runs:**
  - **First, 26 Sep 2026** (run 36255044912). NAVAll.txt parsed: 14,396 schemes, 3,941 tracked, header as `navall_new.txt`. The history report failed on its new header (fixed; rule 4), and some NAVs were dated the next day (rule 4a).
  - **Second, the same evening** (run 36259996296). The history report parsed with no warning. 708 schemes had 27 Sep NAVs, and nav_date correctly stayed 25 Sep. The build took 34 s with the cache.
  - Both runs stopped at `configure-pages`, because Pages wasn't set to GitHub Actions yet. The owner first chose "Deploy from a branch", which published the README.
  - **Third, 26 Sep 19:03 UTC** (run 36264684959, the first with the archive code and secrets). It built and deployed. The archive failed: Google answered with a web page instead of JSON, most likely a sign-in page (access not Anyone), the /dev or editor URL, or a deployment made before the code was saved. `archive.web_page()` now names the cause in the log. This run was 00:33 IST on 27 Sep, so the 27 Sep liquid-fund NAVs counted as today, and nav_date was 27 Sep (rule 4a).
- Pages is on GitHub Actions and deploying (runs 3 and 4). Still open: the owner fixes the archive's Apps Script deployment; check the next run's `Archive:` log lines. Read run logs through the GitHub tools: the Claude Code on the web environment blocks amfiindia.com and api.mfapi.in, so `build.py` can't run there. Once the Drive archive is on, real NAVAll files are in the owner's Drive; they're the source for replacing the fixtures' illustrative rows.

- **Redesign mockups** (27 Sep 2026): https://claude.ai/artifact/V1dMckEyKxQeQP58yYNZ3R (private; a Design canvas). It has Home, Portfolio (grouped by category), Explore (multi-select categories and funds, Direct and Regular, top N, running for), Compare (growth of ₹10,000, the category median dashed, the benchmark dotted, a benchmark editor), Plan (a sentence to edit, and "what your corpus is made of"), a PIN lock screen, and Home and Explore on desktop with a left nav.
  - Proposed look: Anek Latin for figures and headings, IBM Plex Sans for text, indigo #2E44B2, the existing validated c1–c6 series colours, cards on #F2F3F7, and a dark variant (the `dark` tweak).
  - Waiting on the owner's pick or changes before the UI is rebuilt.

## Proposed next steps (confirm with the owner)

The owner's 9-point request of 27 Sep 2026, in this order (each its own change):

1. **Done:**
   - Name "SIPs".
   - In-browser CAS import, with `tools/` removed.
   - Nightly launch dates, category medians, benchmarks and link checks.
   - Mockups published (see Status).
2. **After the owner picks a mockup look:**
   - One page scroll, with a left nav on desktop and a tab bar on phones.
   - A Home screen.
   - Explore filters: one search for categories and funds with removable chips; Direct, Regular or both; any top N; "running for at least N years"; a fund house filter.
   - Launch year on fund cards and details.
   - Plan as an editable sentence, with clearer labels and the corpus donut (starting SIP, step-ups, growth).
   - Portfolio grouping by category, fund house, plan or goal, with subtotals.
   - Fund house links from `data/links.json`.
3. **Security:**
   - Username and password with PBKDF2, giving two keys: one proves the owner to Apps Script (only its hash is kept in Script properties), the other is an AES-GCM key.
   - Local data encrypted.
   - A PIN per device (5 tries), plus WebAuthn where the browser supports it.
   - Auto-lock, and signing out other devices.
   - Reset with 3 security questions plus a one-time recovery code, rate-limited by the script, and a menu reset for the Sheet's owner. Sheet tabs stay readable.
4. **Compare:** up to 5 funds; growth of ₹10,000 over 1Y/3Y/5Y/10Y/Max; the category median from `data/cat/`; the benchmark from `bench`, which can be edited per fund or per category (one or more funds, averaged) and is synced as a setting.
5. **Still open, not scheduled:**
   - Swap the fixtures' illustrative rows for real ones from the Drive archive.
   - Rankings summary to the Sheet.
   - TER and AUM from AMFI.
   - Shares, later.
