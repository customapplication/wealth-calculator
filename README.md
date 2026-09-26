# Corpus planner

Plan SIPs and SWPs, rank Indian mutual funds within each category using AMFI's official NAVs, and track your own portfolio from its first SIP. There's no AI anywhere in it. GitHub Actions rebuilds the data every night and GitHub Pages serves the site for free.

The site has three pages:

- **Plan**: the SIP, step-up SIP and SWP calculator, including its editable engine.
- **Explore funds**: pick a category and rank its funds by the measure you choose. Select a fund to see its NAV chart, then send its return to the planner or start a SIP in it.
- **My portfolio**: add SIPs by hand, or import your CAS statement for exact figures. You'll see value, money in, gain and XIRR from your first instalment, with a chart. Everything stays in your browser.

## Set it up

1. Create a GitHub repository and push this folder to it. Make the repository **public**, because GitHub Pages on a private repository needs a paid plan. The site only ever contains public NAV data; your portfolio never leaves your browser.
2. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Open the **Actions** tab, choose **Nightly mutual fund data**, and press **Run workflow**. The first run downloads years of history for several thousand funds, which usually takes under an hour. If it doesn't finish, the next run carries on from where it stopped.
4. Open `https://<your-username>.github.io/<repository-name>/`.

After that, the build runs every night at 02:00 IST, after AMFI has published the day's NAVs.

GitHub pauses scheduled workflows in a public repository after 60 days with no commits. It emails you when this happens; re-enable the workflow from the Actions tab, or push any commit.

## Run it on your computer

```bash
pip install -r pipeline/requirements.txt
python pipeline/build.py              # writes site/data (the first run is the long history download)
python -m http.server -d site 8000
```

Then open http://localhost:8000. Opening `index.html` straight from disk won't work, because browsers block pages opened from disk from loading data files.

## Where the numbers come from

| What | Source |
|---|---|
| Latest NAV, category, plan and option of every scheme | AMFI's `NAVAll.txt` |
| The last 7 days re-checked, and any missing days filled | AMFI's NAV history report |
| Older history (backfill only) | MFapi.in, a free copy of AMFI's data |

These rules keep the data honest:

- **AMFI wins.** When two sources disagree, AMFI's value is kept. Every correction is logged in `site/data/meta.json`, and the Explore page shows how many values were checked and corrected.
- **No stale publishing.** If AMFI's newest NAV is more than 7 days old, the build stops and the previous site stays online.
- **Columns are found by name, not position.** On 19 Aug 2026 AMFI inserted Plan and Option columns into `NAVAll.txt`, which broke parsers that counted fields. This one reads the header, handles both layouts, and has tests for each. MFapi reportedly stopped updating around the same change; the pipeline fills those days from AMFI.
- **Blank beats wrong.** If a NAV needed for a return is missing by more than 10 days, that figure is left blank. Since-launch returns are left out for funds launched before April 2006, when AMFI's history begins.

The Explore page explains each measure under "How these numbers are worked out".

## Your portfolio

There are two ways to add investments:

- **By hand.** Enter the fund, SIP amount, debit day, start month and optional yearly step-up. Each instalment is priced at the first NAV on or after the debit date, less the 0.005% stamp duty charged since July 2020. Your real allotment can land a day or two later, so treat these as close estimates.
- **From your CAS, exactly.** Request a **Detailed** Consolidated Account Statement from camsonline.com or MF Central, covering the period from before your first investment to today. Then, on your computer, run:

  ```bash
  pip install -r tools/requirements.txt
  python tools/cas_to_json.py cas.pdf --out my-portfolio.json   # asks for the PDF password
  ```

  Import `my-portfolio.json` on the My portfolio page. The converter drops your name, PAN, email, phone and address, and keeps only the last 4 digits of each folio. The page checks your computed units against the statement's closing balance for every fund.

Your portfolio is stored in your browser's local storage. Use **Download backup** to keep a copy or move it to another browser. `.gitignore` already excludes PDFs and portfolio files, so keep them out of the repository.

## Settings

Edit `pipeline/config.json`:

| Key | What it does |
|---|---|
| `plans`, `options`, `sections` | Which schemes get full history and rankings. Default: open-ended, Direct and Regular, Growth option |
| `extra_schemes` | AMFI scheme codes to track anyway, such as an IDCW fund you hold |
| `risk_free_rate` | Used only for the Sharpe ratio (default 6.5%) |
| `verify_days` | How many recent days are re-checked against AMFI each night |
| `mfapi_max_per_run` | Cap on history downloads per run, so the first backfill fits in a run |

## Tests

```bash
pip install -r pipeline/requirements-dev.txt
python -m pytest pipeline/tests
```

The workflow runs these before every build. If AMFI changes its format again in a way the parser can't handle, the build fails loudly rather than publishing wrong numbers, and yesterday's site stays up.

## Limits

- NAVs are end-of-day values; mutual funds have no intraday price.
- Rankings sort past results. They don't include expense ratio, fund size, portfolio overlap or fund manager yet. AMFI publishes expense ratios and AUM separately, which makes them the natural next addition.
- IDCW and other non-growth options aren't tracked unless you list them in `extra_schemes`. Until then, the portfolio page fetches their NAVs from MFapi.in and says so.
- This is a planning tool, not investment advice.
