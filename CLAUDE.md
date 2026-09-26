# CLAUDE.md: context for Claude Code

Read this first in every session. It records what this project is, how it's built, the decisions already made, and what's next.

## What this is

A personal Indian mutual fund app, self-hosted on GitHub Pages, with three pages:

- **Plan** (`site/js/planner.js`): SIP, step-up SIP and SWP calculator with an editable calculation engine.
- **Explore funds** (`site/js/explore.js`): rank each SEBI category's funds by a chosen measure, computed from AMFI NAVs.
- **My portfolio** (`site/js/portfolio.js`): the owner's SIPs from inception, entered by hand or imported from a CAMS/KFintech CAS statement. Shows value, money in, gain and XIRR.

## Owner's requirements (decided, don't change without asking)

- Mutual funds only for now. Shares come later.
- No AI anywhere in the data path. Numbers come from official sources: AMFI first. NSE, SEBI and CAMS were considered; NSE and SEBI publish no NAV feed, and CAMS/KFintech supply only the owner's own statement.
- Accuracy over completeness: leave a figure blank rather than guess it.
- Self-hosted: a public GitHub repo, a nightly GitHub Actions job, GitHub Pages. No server.
- Portfolio data is private. It lives only in the browser (localStorage), never in the repo or the published site.

## Layout

```
pipeline/            nightly data build (Python 3.12, requests + numpy)
  amfi.py            fetch + parse NAVAll.txt and the NAV history report; columns found by header NAME
  mfapi.py           MFapi.in client, backfill of older history only
  store.py           history store; same compact JSON format for the cache and the site
  metrics.py         returns, rolling 3Y, drawdown, volatility, Sharpe, consistency vs category median
  build.py           orchestrator; run(cfg, cache_dir, out_dir, net, today) takes an injectable `net` for tests
  config.json        sections/plans/options filters, extra_schemes, risk-free rate, limits
  tests/             pytest, 20 tests, fixtures in AMFI's real old (6-col) and new (8-col) formats
tools/cas_to_json.py CAS PDF -> portfolio JSON via casparser 1.4; strips name/PAN/email/phone/address
site/                static site: index.html, css/app.css, js/{common,planner,explore,portfolio,app}.js
.github/workflows/nightly.yml  02:00 IST: tests -> build -> Pages deploy; .cache kept via actions/cache
```

## Data pipeline rules

1. `NAVAll.txt` from AMFI is the source of truth for the latest NAV, category, plan and option. The build stops, and the previous site stays up, if its newest NAV is more than 7 days old.
2. **AMFI changed NAVAll.txt on 19 Aug 2026**, inserting `Plan;Option` before `Net Asset Value`. The parser maps columns by header name and handles both layouts. Plan and option come from those columns, or from the scheme name in the old format.
3. MFapi.in reportedly stopped updating after 18 Aug 2026. It's used only to backfill older history, fill-only: it never overwrites an existing day.
4. Every night the AMFI NAV history report is fetched for the last `verify_days` (7), plus any gap since a scheme's last stored NAV. AMFI values overwrite the cache; each correction is counted and logged in `site/data/meta.json`.
5. Metrics are left blank when the needed NAV is more than 10 days from its target date. Since-launch CAGR is blank for funds whose data starts around Apr 2006 (the start of AMFI's history), and for schemes without a full MFapi backfill.
6. History file format (the cache in `.cache/nav/` and the site in `site/data/nav/`): `{"c": code, "s": "YYYY-MM-DD", "t": [0, gap, gap...], "v": [nav...]}`. `t` is day gaps from the previous NAV.
7. `site/data/funds.json` holds one row per active open-ended scheme, keyed `c n a g k p pl o i i2 v d h m`. `m` is the metrics object (`r1 r3 r5 r10 si rr3med rr3min rr3n cons mdd5 vol3 sh3 age inc`) or null.

## Front-end conventions

- Plain classic scripts, no build step, no framework. Chart.js 4.4.1 from jsdelivr.
- `planner.js` came from a self-contained calculator. All its selectors are scoped to `#view-plan`. Don't reuse its IDs, or `data-key` / `data-focus` attributes, on other pages.
- Cross-page events on `document`: `mf:view` {view}, `mf:theme`, `mf:add-sip` {code}. `window.Planner.addRate(pct)` adds a return rate to the planner.
- localStorage keys: `corpus-planner:v1`, `corpus-planner:engine`, `corpus-planner:theme`, `corpus-planner:view`, `mf-explore:v1`, `mf-portfolio:v1`, `mf-portfolio:v1:view`.
- Portfolio pricing for manual entries: first NAV on or after the debit date, with 0.005% stamp duty from 1 Jul 2020. CAS imports use the statement's own units, and the page checks computed units against the CAS closing units.
- Design: a "passbook" look using IBM Plex Sans, Plex Sans Condensed for figures, and Plex Mono only for code. Ink #16233F, stamp indigo #2F4BA0, crimson #B7324A for withdrawals, scenario colours from rupee notes. Sentence case everywhere, no all-caps labels, plain active-voice copy. Keep light/dark tokens in sync; both themes exist.

## How to test

```bash
pip install -r pipeline/requirements-dev.txt
python -m pytest -q pipeline/tests
python pipeline/build.py                 # needs network: www/portal.amfiindia.com, api.mfapi.in
python -m http.server -d site 8000
```

The site was also smoke-tested in jsdom against pipeline-built synthetic data: rankings, fund chart, planner hand-off, manual SIP, CAS import with a units check, and failure states. XIRR was verified: a SIP in a fund growing exactly 12% a year gives 12.00%. Those harness scripts aren't in the repo.

## Status

- Built and tested offline. **Not yet run against live AMFI data**, because the original sandbox couldn't reach amfiindia.com, and the Claude Code on the web environment (26 Sep 2026) was blocked too: its network policy denies www.amfiindia.com, portal.amfiindia.com and api.mfapi.in. Add those hosts to the environment's allowed domains, or run the workflow on GitHub. That attempt did fix one bug: a connection error on www.amfiindia.com used to skip the portal.amfiindia.com fallback and crash `build.py` with a traceback. The first real run is the open risk: check the parser against the live file and the history report (the history report's columns may also have changed in Aug 2026).
- The first backfill may take most of an hour; `mfapi_max_per_run` caps it, and later nights resume.

## Proposed next steps (not started; confirm with the owner)

1. **Live-data shakedown.** Run `python pipeline/build.py`, fix anything in the parser, and add a fixture from the real files.
2. **Google Sheets sync** (the owner asked about storing data in Google Sheets).
   - Portfolio: Google sign-in in the page (Google Identity Services plus Sheets API, OAuth client ID) so the portfolio syncs across devices into a private sheet the owner owns. Avoid an open Apps Script URL for financial data.
   - Rankings: optionally have the nightly job write the `funds.json` summary to a sheet with a service account (key in GitHub Actions secrets).
   - Full NAV history doesn't fit: about 6,000 schemes × thousands of days exceeds Sheets' 10-million-cell limit. It stays in JSON.
3. Expense ratio (TER) and AUM from AMFI's separate disclosures, shown on Explore funds.
4. CAS import directly in the browser (pdf.js), so no local Python step is needed.
5. Later: shares.
