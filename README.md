# Corpus planner

Plan SIPs and SWPs, rank Indian mutual funds within each category using AMFI's official NAVs, and track your own portfolio from its first SIP. There's no AI anywhere in it. GitHub Actions rebuilds the data every night and GitHub Pages serves the site for free.

The site has three pages:

- **Plan**: the SIP, step-up SIP and SWP calculator, including its editable engine.
- **Explore funds**: pick a category and rank its funds by the measure you choose. Select a fund to see its NAV chart, then send its return to the planner or start a SIP in it.
- **My portfolio**: add SIPs by hand, or import your CAS statement for exact figures. You'll see value, money in, gain and XIRR from your first instalment, with a chart. It's kept in your browser and, if you connect one, in a Google Sheet you own.

## Set it up

1. Create a GitHub repository and push this folder to it. Make the repository **public**, because GitHub Pages on a private repository needs a paid plan. The site only ever contains public NAV data; your portfolio stays in your browser and your own Google Sheet.
2. In the repository, open **Settings → Pages**. Under **Build and deployment**, set **Source** to **GitHub Actions**. There's nothing else to fill in on that page.
3. Open the **Actions** tab. If GitHub asks, press **I understand my workflows, go ahead and enable them**. Choose **Nightly mutual fund data** on the left, press **Run workflow**, keep the branch as `main`, and press the green **Run workflow** button.
4. Wait for the run to finish; its page shows the progress of **build** and then **deploy**. The first run downloads years of history for about 4,000 funds, which took about 5 minutes in the first real run. If it stops before the end, the next run carries on from where it stopped, and the site still publishes what it has.
5. Open `https://<your-username>.github.io/<repository-name>/`. The deploy step also prints this link. For this repository that's `https://customapplication.github.io/wealth-calculator/`.

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
- **Columns are found by name, not position.** On 19 Aug 2026 AMFI inserted Plan and Option columns into `NAVAll.txt`, which broke parsers that counted fields, and the history report now says *NAV Name* where it said *Scheme Name*. This parser reads the header, handles the old and new layouts, and has tests for each. If MFapi falls behind, the pipeline fills the missing days from AMFI.
- **A NAV dated tomorrow doesn't move the date.** NAVAll.txt sometimes carries NAVs dated the day after it's published. They're kept as AMFI published them, but the site's "NAVs up to" date never runs ahead of the day it was built.
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

Your portfolio is stored in your browser's local storage. Use **Download backup** to keep a copy or move it to another browser, or connect a Google Sheet (below) to keep every device in step. `.gitignore` already excludes PDFs and portfolio files, so keep them out of the repository.

## Save to a Google Sheet (optional)

Connect a Google Sheet and the site keeps your plan and portfolio there as well as in the browser, and the same on every phone and computer you connect. It uses a small Apps Script in a Sheet you own, with no Google Cloud project and no sign-in to renew.

The Sheet gets four tabs you can read, sort and chart:

| Tab | What's in it |
|---|---|
| Portfolio | Each investment's units, money put in, worth, gain and XIRR, and the total. Updated whenever you open My portfolio. |
| Investments | Every SIP, one-time investment and statement fund, as you entered it |
| Transactions | Every transaction from your imported CAS statement |
| Plan | The inputs on the Plan page |

A hidden `_data` tab holds the records the devices sync. Edit on the site: changes made in the readable tabs are overwritten at the next sync.

### Set it up (about five minutes, once)

1. Go to [sheets.new](https://sheets.new) to make a blank Google Sheet, and give it a name, such as *Corpus planner*.
2. In the Sheet, open **Extensions → Apps Script**. Delete the code that's there, paste in the whole of [`sheets/Code.gs`](sheets/Code.gs) from this repository, and press **Save** (the disk icon). Don't edit the file; nothing in it needs changing.
3. Make a secret. On the site, open **My portfolio**, find **Google Sheet**, and press **Make a new secret**. It fills the Secret box with a random 32-character value and copies it. Any long random string of 16 characters or more works too.
4. Back in Apps Script, open **Project Settings** (the gear icon on the left). Under **Script Properties**, press **Add script property** (or **Edit script properties**, then **Add script property**). Enter `SECRET` as the property and paste the secret as the value, then press **Save script properties**. The secret lives here, never in the code, so `Code.gs` in this public repository stays free of it.
5. Press **Deploy → New deployment**. Next to **Select type**, press the gear and choose **Web app**. Set **Execute as** to **Me** and **Who has access** to **Anyone**, then press **Deploy**.
6. Press **Authorize access** and choose your Google account. Google warns *"Google hasn't verified this app"*. That's expected, because the app is the script you just pasted. Press **Advanced**, then **Go to (your project) (unsafe)**, then **Allow**.
7. Copy the **Web app URL**. It starts with `https://script.google.com/` and ends in `/exec`.
8. On the site, paste the URL into **Web app URL**. The secret should still be in the **Secret** box; if not, paste it there too. Press **Connect**. You'll see *Connected*, and the header shows **Saved to Sheet**.
9. On every other phone or computer, open the site, go to **My portfolio → Google Sheet**, and paste the same URL and secret.

Connect the device that holds your real data first. When a device connects, its investments are added to what the Sheet holds. If the Sheet already has a plan, it replaces the plan on the device that's connecting, unless that device's plan was never changed from the defaults.

### Using it

- Changes go to the Sheet a second or two after you make them, and each device picks up the others' changes when you open or return to the site, and every 10 minutes while it's open. **Sync now** does it straight away.
- If you're offline, changes wait on the device and go up at the next sync. The header shows **Sheet not updated** until they do.
- When two devices change the same thing, the later change wins. Removing an investment removes it everywhere.
- **Open the Sheet** in the Google Sheet section opens it. The Sheet also has a **Corpus planner** menu with *Refresh the readable tabs*, *Check that this Sheet stores data exactly*, and *Erase the synced data*.
- **Disconnect this device** stops syncing and keeps the data on the device and in the Sheet.

### After you change `Code.gs`

Paste the new version into Apps Script and save. Then choose **Deploy → Manage deployments**, press the pencil icon, set **Version** to **New version**, and press **Deploy**. The URL stays the same. Saving alone doesn't change what the URL runs.

### Keeping it private

- The Sheet holds your portfolio in readable form. Share it with nobody, and turn on 2-step verification for the Google account that owns it.
- Anyone with both the URL and the secret can read and change what's synced, so treat them like a password. They're stored only in each browser you connect, never in the site or this repository.
- If you think the secret has leaked, change the `SECRET` script property to a new value (no new deployment needed) and connect each device again with it.
- The script is limited to this one Sheet (`@OnlyCurrentDoc`), so the permission Google asks for in step 6 covers only it, not your other files. It runs as you, and the only requests it accepts are the site's sync with the right secret.

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
node --test sheets/tests/*.test.js    # the Google Sheet script, against simulated Google services
```

The nightly workflow runs the pipeline tests before every build, and pull requests run both sets. If AMFI changes its format again in a way the parser can't handle, the build fails loudly rather than publishing wrong numbers, and yesterday's site stays up.

## Limits

- NAVs are end-of-day values; mutual funds have no intraday price.
- Rankings sort past results. They don't include expense ratio, fund size, portfolio overlap or fund manager yet. AMFI publishes expense ratios and AUM separately, which makes them the natural next addition.
- IDCW and other non-growth options aren't tracked unless you list them in `extra_schemes`. Until then, the portfolio page fetches their NAVs from MFapi.in and says so.
- This is a planning tool, not investment advice.
