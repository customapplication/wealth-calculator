# SIPs

Plan SIPs and SWPs, rank Indian mutual funds within each category using AMFI's official NAVs, and track your own portfolio from its first SIP. There's no AI anywhere in it. GitHub Actions rebuilds the data every night and GitHub Pages serves the site for free.

The site has these pages:

- **Home**: what you're worth today, your gain and XIRR, how it grew, the SIPs due in the next month, and what you hold.
- **Portfolio**: add SIPs by hand, or import your CAS statement PDF for exact figures. You'll see value, money in, gain and XIRR from your first instalment, grouped by category, fund house, plan or a goal you set. Every fund card has a **Log in at …** pill that opens its fund house's website, and so does each fund house when you group by fund house. It's kept in your browser and, if you connect one, in a Google Sheet you own.
- **Explore funds**: search for categories and funds, add as many as you like, and rank them by the measure you choose. Filter by Direct, Regular or both, the top N, how many years a fund has been running, and fund house. Select a fund to see its NAV chart and launch date, send its return to the planner, or start a SIP in it. Tick up to 5 funds to compare them.
- **Compare**: ₹10,000 put into each fund over 1, 3, 5 or 10 years or since launch, next to the typical fund in its category and a benchmark. The benchmark is an index fund by default, and you can change it to one or more funds, for one fund or its whole category.
- **Plan**: the SIP, step-up SIP and SWP calculator, written as a sentence you can edit, with what your corpus is made of, and the editable engine.
- **Security**: a 6-digit PIN (or your fingerprint or face) opens SIPs, and everything it keeps on the device is encrypted. With your Google Sheet connected, one name and password signs in every device, and you can sign any of them out.
- **Fund data**: if GitHub ever pauses the nightly update, **Update now** starts it again from the site.

Every chart has a switch for its type: line, area or bars for anything over time, and donut, pie or bars for what you hold. On a computer the pages are in a menu on the left, and forms open in a panel on the right. On a phone there's a tab bar at the bottom and forms slide up from it. To use it like an app, open it in your phone's browser and choose **Add to Home screen** (on an iPhone, Share → **Add to Home Screen**).

## Set it up

1. Create a GitHub repository and push this folder to it. Make the repository **public**, because GitHub Pages on a private repository needs a paid plan. The site only ever contains public NAV data; your portfolio stays in your browser and your own Google Sheet.
2. In the repository, open **Settings → Pages**. Under **Build and deployment**, set **Source** to **GitHub Actions**. There's nothing else to fill in on that page.

   Don't choose *Deploy from a branch*. That publishes the repository's files as they are, so you'd see this README instead of the site. The site's fund data isn't stored in the repository: the nightly job downloads it from AMFI and hands the finished site straight to Pages, which only works with *GitHub Actions* as the source.
3. Open the **Actions** tab. If GitHub asks, press **I understand my workflows, go ahead and enable them**. Choose **Nightly mutual fund data** on the left, press **Run workflow**, keep the branch as `main`, and press the green **Run workflow** button.
4. Wait for the run to finish; its page shows the progress of **build** and then **deploy**. The first run downloads years of history for about 4,000 funds, which took about 5 minutes in the first real run. If it stops before the end, the next run carries on from where it stopped, and the site still publishes what it has.
5. Open `https://<your-username>.github.io/<repository-name>/`. The deploy step also prints this link. For this repository that's `https://customapplication.github.io/wealth-calculator/`.

After that, the build runs every night at 02:00 IST, after AMFI has published the day's NAVs.

### Keeping the nightly job running

GitHub pauses scheduled workflows in a public repository after 60 days without activity. The workflow's small **keepalive** job switches the workflow on again after every scheduled run, through GitHub's own API, so the 60 days never run out and no commits are needed.

If GitHub ever pauses it anyway, it emails you, and Home shows **Fund data is out of date** once the data is over 30 hours old. You can start it again three ways:

- **From the site, with one button.** Open **Fund data** (from that notice, or **Update the fund data** on Explore) and press **Update now**. It switches the paused job back on, runs it (the Drive archive included) and follows it until the new data is up. This goes through your Google Sheet's script, which holds a GitHub token; set it up once:
  1. On GitHub, open your picture, then **Settings → Developer settings → Personal access tokens → Fine-grained tokens**, and press **Generate new token**.
  2. Name it *SIPs update*, choose the longest expiry, and under **Repository access** pick **Only select repositories** and this repository.
  3. Under **Permissions → Repository permissions**, set **Actions** to **Read and write**. Nothing else. Generate the token and copy it.
  4. In your Sheet's Apps Script, open **Project Settings → Script properties** and add two properties: `GITHUB_TOKEN` with the token, and `GITHUB_REPO` with this repository as `owner/name`, for example `customapplication/wealth-calculator`. The script needs the repository's name to know which workflow to start; the daily check runs with no site to ask.
  5. To test it, choose `checkNightly` in the editor's function list and press **Run**. The execution log says *All well*, *Started a data update*, or what's wrong.
  The token stays in the script's properties; it's never in the site or this repository. When it expires, the panel says so: make a new one and replace the property.
  Why a token: the workflow belongs to your GitHub account, and only you can switch it on or start it. The token is a key that lets your script do just that for you, on this one repository: see the workflow and its runs, switch it back on, and start a run. It can't read or change code, secrets or other repositories. Revoke it on GitHub at any time.
- **Every morning, on its own.** Open the Google Sheet itself (not the Apps Script editor) and reload the page: a **SIPs** menu appears at the end of the menu bar, after **Help**. Choose **SIPs → Keep the nightly data update running**, and allow the permissions if Google asks. It sets up a daily trigger, runs one check straight away, and shows the result. From then on the script checks every morning between 5 and 6 am (in the time zone under Apps Script's **Project Settings**): if GitHub paused the job it switches it back on, and if the last good update is more than 26 hours old it starts one. A job you turned off by hand on GitHub is left off. You can see the trigger in Apps Script under **Triggers** (the alarm clock on the left); **SIPs → Stop the daily check** removes it.
- **By hand on GitHub.** Open the **Actions** tab, choose **Nightly mutual fund data**, press **Enable workflow** if it shows, then **Run workflow**.

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
| Launch date of each scheme and plan | AMFI's scheme data file |

These rules keep the data honest:

- **AMFI wins.** When two sources disagree, AMFI's value is kept. Every correction is logged in `site/data/meta.json`, and the Explore page shows how many values were checked and corrected.
- **No stale publishing.** If AMFI's newest NAV is more than 7 days old, the build stops and the previous site stays online.
- **Columns are found by name, not position.** On 19 Aug 2026 AMFI inserted Plan and Option columns into `NAVAll.txt`, which broke parsers that counted fields, and the history report now says *NAV Name* where it said *Scheme Name*. This parser reads the header, handles the old and new layouts, and has tests for each. If MFapi falls behind, the pipeline fills the missing days from AMFI.
- **A NAV dated tomorrow doesn't move the date.** NAVAll.txt sometimes carries NAVs dated the day after it's published. They're kept as AMFI published them, but the site's "NAVs up to" date never runs ahead of the day it was built.
- **Blank beats wrong.** If a NAV needed for a return is missing by more than 10 days, that figure is left blank. Since-launch returns are left out for funds launched before April 2006, when AMFI's history begins.

The Explore page explains each measure under "How these numbers are worked out".

### Where the nightly data lives

The nightly job writes the site's data files, and they're never committed to this repository (`.gitignore` excludes `site/data/` and `.cache/`):

1. GitHub Actions starts a fresh machine and restores `.cache/` from GitHub's build cache: every tracked fund's NAV history, plus AMFI's last scheme data file.
2. `pipeline/build.py` downloads today's AMFI files, updates `.cache/`, and writes the finished data into `site/data/`.
3. The deploy step uploads the whole `site/` folder, data included, to GitHub Pages. The machine is then thrown away, and `.cache/` goes back to the build cache for the next night.

So the files live on the published site, next to the page. The app reads them with ordinary web requests (in `site/js/common.js`):

| File | What's in it | Read by |
|---|---|---|
| `data/funds.json` | every open-ended scheme: name, fund house, category, plan, latest NAV, launch dates and all the ranking figures; the typical-fund list and the default benchmarks | every page, through `loadFunds()` |
| `data/meta.json` | when it was built, the NAV date, and what was checked and corrected | Explore's "How fresh" note |
| `data/nav/<scheme code>.json` | one fund's full NAV history | charts, Compare and your portfolio's values, through `loadHistory()` |
| `data/cat/<category-plan>.json` | the typical fund in a category and plan | Compare, through `loadCat()` |
| `data/links.json` | MF Central, CAMS, KFintech and each fund house's website, checked that night | the **Log in at …** pills and the account links, through `loadLinks()` |

To look at one, add it to the site's address, for example `https://customapplication.github.io/wealth-calculator/data/meta.json`. If you turn on the Drive archive (below), your Drive also keeps each day's raw AMFI file and a monthly copy of the history.

The nightly build also writes what the fund comparison needs:

- **Launch dates** from AMFI's scheme data file, for each plan and for the scheme itself. A date AMFI doesn't give is left blank. If the file can't be fetched, the last good copy is used.
- **The typical fund** in each category and plan: the median of its funds' weekly returns, chained week by week, in `site/data/cat/`.
- **A default benchmark** for each equity category. Index values come from NSE rather than AMFI, so an index fund stands in: the Direct Growth plan with the longest history that tracks the index, such as a Nifty 500 index fund for flexi cap funds. The choices are in `benchmarks` in `pipeline/build.py`, and you can override them in `pipeline/config.json`.
- **Official websites**: MF Central, CAMS, KFintech and each fund house, listed in `pipeline/links.json`. Each night the build checks every address. A site that no longer exists is hidden, and `meta.json` lists it along with any fund house that has no entry.

## Your portfolio

There are two ways to add investments:

- **By hand.** Enter the fund, SIP amount, debit day, start month and optional yearly step-up. Each instalment is priced at the first NAV on or after the debit date, less the 0.005% stamp duty charged since July 2020. Your real allotment can land a day or two later, so treat these as close estimates.
- **From your CAS, exactly.** Request a **Detailed** Consolidated Account Statement (CAMS + KFintech) from camsonline.com, MF Central or KFintech, covering the period from before your first investment to today. It arrives by email as a PDF. Choose **Import statement** on Home or Portfolio and pick the PDF. A PDF without a password is imported straight away. If it has one, the page asks for it: type it and press **Open and import**. The password is used only to open the file, and never stored.

  The PDF is read in your browser, by a copy of PDF.js that this site serves itself, and it's never uploaded. For every fund it checks that the opening units plus each transaction add up to the statement's closing balance, and it tells you if any don't.

  What it keeps from the statement, for each fund:

  | Kept | Shown |
  |---|---|
  | Every transaction: date, type, amount, units, NAV | the value, gain and XIRR, and the Transactions tab |
  | ISIN, name and fund house | everywhere, with a **Log in at …** pill |
  | The folio number, whole | its last 4 digits, with **Show** for the rest |
  | The registrar (CAMS or KFintech) | a link to its service site |
  | The distributor's ARN, or DIRECT | whether a commission is paid from the plan |
  | The nominees' names, as printed | a note for any folio that shows none |
  | Whether KYC and PAN are marked OK | a warning when they aren't |
  | Demat or not, the statement's cost and value, and its exit load wording | under **Folio, nominees and exit load** |

  Your name, PAN, email, phone, address and bank details are never read into it. For ELSS funds the page also works out how much is still in the 3-year lock-in, and when the next units free up.

  Importing a newer statement later merges with what's there: for each fund, the new statement replaces its own period and older transactions stay. A statement that starts after your first investment can't show your full cost, and the page says which funds are affected.

Group your funds by category, fund house, plan or goal. **Set a goal** on any fund card names what it's for, such as *Retirement*, and grouping by goal adds them up. Each card's **Log in at …** pill opens that fund house's own website in a new tab, where you log in; nothing is sent to it from this site. The **Log in to your accounts** card has MF Central, CAMS and KFintech for every folio at once.

Your portfolio is stored in your browser's local storage. Use **Download backup** to keep a copy or move it to another browser, or connect a Google Sheet (below) to keep every device in step. `.gitignore` already excludes PDFs and portfolio files, so keep them out of the repository.

## Save to a Google Sheet (optional)

Connect a Google Sheet and the site keeps your plan and portfolio there as well as in the browser, and the same on every phone and computer you connect. It uses a small Apps Script in a Sheet you own, with no Google Cloud project and no sign-in to renew.

The Sheet gets four tabs you can read, sort and chart:

| Tab | What's in it |
|---|---|
| Portfolio | Each investment's units, money put in, worth, gain and XIRR, and the total. Updated whenever you open the site. |
| Investments | Every SIP, one-time investment and statement fund, as you entered it, with its fund house, goal, folio, registrar, distributor, nominees, and KYC and PAN status |
| Transactions | Every transaction from your imported CAS statement |
| Plan | The inputs on the Plan page |

A hidden `_data` tab holds the records the devices sync. Edit on the site: changes made in the readable tabs are overwritten at the next sync.

### Set it up (about five minutes, once)

1. Go to [sheets.new](https://sheets.new) to make a blank Google Sheet, and give it a name, such as *SIPs*.
2. In the Sheet, open **Extensions → Apps Script**. Delete the code that's there, paste in the whole of [`sheets/Code.gs`](sheets/Code.gs) from this repository, and press **Save** (the disk icon). Don't edit the file; nothing in it needs changing.
3. Make a secret. On the site, open **Google Sheet** (the card at the bottom of the menu on a computer; on a phone, **Portfolio → Sync and backup → Google Sheet**). Paste nothing yet: the secret box appears after step 8's **Continue**, so you can also do this step then. **Make a new secret** fills the Secret box with a random 32-character value and copies it. Any long random string of 16 characters or more works too.
4. Back in Apps Script, open **Project Settings** (the gear icon on the left). Under **Script Properties**, press **Add script property** (or **Edit script properties**, then **Add script property**). Enter `SECRET` as the property and paste the secret as the value, then press **Save script properties**. The secret lives here, never in the code, so `Code.gs` in this public repository stays free of it.
5. Press **Deploy → New deployment**. Next to **Select type**, press the gear and choose **Web app**. Set **Execute as** to **Me** and **Who has access** to **Anyone**, then press **Deploy**.
6. Press **Authorize access** and choose your Google account. Google warns *"Google hasn't verified this app"*. That's expected, because the app is the script you just pasted. Press **Advanced**, then **Go to (your project) (unsafe)**, then **Allow**. It asks to see and edit this one Sheet, to connect to an external service (GitHub, only for **Update now**), and to run while you're away (only for the optional daily check).
7. Copy the **Web app URL**. It starts with `https://script.google.com/` and ends in `/exec`.
8. On the site, paste the URL into **Web app URL** and press **Continue**. Paste the secret into the **Secret** box that appears, and press **Connect**. You'll see *Connected*, and Home shows **Sheet synced**.
9. Make your login: open **Security**, choose **Make your login**, and follow [Lock and login](#lock-and-login). Keep the recovery code it shows you.
10. On every other phone or computer, open the site, open **Google Sheet**, paste the URL, press **Continue**, and sign in with your name and password. Then choose that device's PIN.

Connect the device that holds your real data first. When a device connects, its investments are added to what the Sheet holds. If the Sheet already has a plan, it replaces the plan on the device that's connecting, unless that device's plan was never changed from the defaults.

### Using it

- Changes go to the Sheet a second or two after you make them, and each device picks up the others' changes when you open or return to the site, and every 10 minutes while it's open. **Sync now** does it straight away.
- If you're offline, changes wait on the device and go up at the next sync. Home shows **Sheet not updated** until they do.
- Your investments, goals, plan and benchmark choices sync. Chart types, filters and which page you were on stay on each device.
- When two devices change the same thing, the later change wins. Removing an investment removes it everywhere.
- **Open the Sheet** in the Google Sheet panel opens it. The Sheet also has a **SIPs** menu: *Refresh the readable tabs*, *Check that this Sheet stores data exactly*, *Keep the nightly data update running* (and *Check it now*, *Stop the daily check*), *Sign out every device*, *Remove the login*, and *Erase the synced data*.
- **Disconnect this device** stops syncing and keeps the data on the device and in the Sheet.

### After you change `Code.gs`

Paste the new version into Apps Script and save. Then choose **Deploy → Manage deployments**, press the pencil icon, set **Version** to **New version**, and press **Deploy**. The URL stays the same. Saving alone doesn't change what the URL runs. To check, open the URL in a browser: it shows the running `version` (3 for this release).

Version 3 asks Google for two more permissions: to connect to an external service (GitHub, for **Update now**) and to run while you're away (the daily check). After deploying, choose `checkNightly` in the editor's function list, press **Run** once, and allow them; until you do, the site can't reach the new version.

### Keeping it private

- The Sheet holds your portfolio in readable form. Share it with nobody, and turn on 2-step verification for the Google account that owns it.
- Until you make a login, anyone with both the URL and the secret can read and change what's synced, so treat them like a password. After it, the secret no longer opens the data: each device needs your name and password. The URL, secret and sessions are stored only in each browser you connect (encrypted, with the lock on), never in the site or this repository.
- If you think the secret has leaked, change the `SECRET` script property to a new value (no new deployment needed) and connect each device again with it.
- The script is limited to this one Sheet (`@OnlyCurrentDoc`), so the permission Google asks for in step 6 covers only it, not your other files. It runs as you, and the only requests it accepts are the site's sync with the right secret.

## Lock and login

Open **Security** in the menu (on a phone, **Portfolio → Security and devices**).

- **A PIN for each device.** Your investments, plan, settings and Sheet connection are then stored encrypted in the browser. The lock screen asks for the 6-digit PIN; after 5 wrong PINs the device forgets its PIN key and only your password opens it (then you choose a new PIN). SIPs locks itself after 5 minutes away, or the time you choose, and **Lock now** locks it at once.
- **Fingerprint or face**, on browsers that can use a passkey to unlock data (recent Chrome on Android, Safari on iPhone and Mac): **Use fingerprint or face** in Security.
- **One login for every device**, once your Google Sheet is connected with `Code.gs` version 3. On the first device, choose **Make your login**: a name, a password of 10 or more characters, 3 security questions, and this device's PIN. You'll get a **recovery code**: write it down. From then on the secret alone no longer opens your data; each device opens **Google Sheet**, pastes the URL, presses **Continue**, and signs in with the name and password.
- **Devices**: Security lists every signed-in device. **Sign out** one, or **Sign out every other device**: at its next sync, a signed-out device loses its copy of your data (your Sheet keeps it) and has to sign in again.
- **Forgot your password?** On the lock screen, or in Google Sheet, answer your 3 questions and type the recovery code to set a new password. The code is used up: you get a new one, and every other device is signed out. If the questions or code are lost too, the Sheet's owner can choose **SIPs → Remove the login** in the Sheet, connect with the secret, and make a new login.

How it works: your name and password go through PBKDF2 (600,000 rounds) to make two keys. One proves you to your Sheet's script, which stores only its SHA-256; the other never leaves the device and opens this device's data key. The PIN (PBKDF2 with its own salt) and your fingerprint (a passkey's PRF secret) each keep another copy of that data key. The recovery proof is made the same way from your answers and the recovery code. The script pauses logins for 15 minutes after 5 wrong passwords, and recovery for an hour after 3 wrong tries, for longer each time.

What it protects against: someone picking up your phone or computer, someone who has only the Sheet's URL, and a device you've lost (sign it out). A PIN is short, though: someone who copied this browser's stored files could try every PIN on their own computer. Keep your phone's own screen lock on, and use a long password.

## Keep a copy of AMFI's data in Google Drive (optional)

Every night the job downloads AMFI's `NAVAll.txt`, uses it and throws it away. The tracked funds' history is kept in GitHub's build cache, which is a scratch space GitHub may empty. Turn this on and the job also keeps copies in your own Google Drive:

```
SIPs archive/
  NAVAll/2026/09/NAVAll-2026-09-26.txt.gz     each night's file, exactly as AMFI served it
  NAV history/NAV history 2026-10-01/         the full history of every tracked fund, once a month
```

The site doesn't read these; they're your backup and a record of what AMFI published each day. A `.txt.gz` file opens with any unzip tool. Expect roughly 150 MB a year for the daily files, plus about 60 MB for the history copies. These are estimates; Google's free 15 GB lasts many years at that rate. The last two monthly history copies are kept, and older ones go to Drive's trash.

It's a second, separate Apps Script, so the Sheet sync script stays limited to its one Sheet.

1. Go to [script.google.com](https://script.google.com) and press **New project**. Name it *SIPs archive*. Delete the code that's there, paste in the whole of [`sheets/Archive.gs`](sheets/Archive.gs), and press **Save**.
2. Make a secret: any random string of 16 characters or more. It should be different from the Sheet sync's secret; the site's **Make a new secret** button works for this too.
3. Open **Project Settings** (the gear icon). Under **Script Properties**, press **Add script property**. Enter `SECRET` as the property, paste the secret as the value, and press **Save script properties**.
4. Press **Deploy → New deployment**. Next to **Select type**, press the gear and choose **Web app**. Set **Execute as** to **Me** and **Who has access** to **Anyone**, then press **Deploy**.
5. Press **Authorize access**. Google asks to see and manage your Drive files, because this script saves files there, and warns that it hasn't verified the app. That's expected: press **Advanced → Go to SIPs archive (unsafe) → Allow**. Copy the **Web app URL**.
6. In the GitHub repository, open **Settings → Secrets and variables → Actions** and press **New repository secret** twice:
   - Name `ARCHIVE_URL`, secret: the web app URL.
   - Name `ARCHIVE_SECRET`, secret: the same secret as step 3.
7. Run the workflow once from the **Actions** tab (or **Update now** on the site). When it finishes, the folder **SIPs archive** is in your Drive with today's file and the first history copy. A folder made by the earlier version, *Corpus planner archive*, is kept and renamed.

The run's log says what was stored, and `meta.json` on the site has an `archive` section. If Drive can't be reached, the site is still built and published; the file for that night is simply missed.

If the log says the archive didn't work, open your `ARCHIVE_URL` in a private browser window. You should see `{"ok":true,"app":"corpus-planner-archive",…}`. If you don't:

- **A Google sign-in page:** the deployment's **Who has access** isn't **Anyone**. *Anyone with a Google account* isn't enough, because the nightly job has no Google account. Fix it under **Deploy → Manage deployments → Edit**.
- **"Script function not found":** the deployed version was made before the code was pasted or saved. Save, then **Deploy → Manage deployments → Edit → Version: New version → Deploy**.
- **"Authorization is required":** in the editor, choose `doGet` in the function list, press **Run**, and allow the permissions.
- **The Apps Script editor:** `ARCHIVE_URL` is the editor's address. Use the **Web app URL** from **Deploy → Manage deployments**; it ends in `/exec`.

The log names which of these it met.

To restore the history into a fresh cache, download a *NAV history* folder and run `for f in *.tar.gz; do tar xzf "$f" -C .cache; done` in the repository.

## Settings

Edit `pipeline/config.json`:

| Key | What it does |
|---|---|
| `plans`, `options`, `sections` | Which schemes get full history and rankings. Default: open-ended, Direct and Regular, Growth option |
| `extra_schemes` | AMFI scheme codes to track anyway, such as an IDCW fund you hold |
| `risk_free_rate` | Used only for the Sharpe ratio (default 6.5%) |
| `verify_days` | How many recent days are re-checked against AMFI each night |
| `mfapi_max_per_run` | Cap on history downloads per run, so the first backfill fits in a run |
| `archive_snapshot_every_days` | How often the full NAV history goes to Google Drive (default 30) |
| `benchmarks` | Which index fund stands in for each equity category's benchmark |
| `check_links` | Whether to check the official websites each night (default on) |

## Tests

```bash
pip install -r pipeline/requirements-dev.txt
python -m pytest pipeline/tests
node --test sheets/tests/*.test.js    # both Apps Scripts (sync, login, fund data update, Drive archive), against simulated Google services
node --test tests/*.test.js           # the in-browser CAS reader, against a made-up statement
```

The nightly workflow runs the pipeline tests before every build, and pull requests run all three sets. If AMFI changes its format again in a way the parser can't handle, the build fails loudly rather than publishing wrong numbers, and yesterday's site stays up.

## Limits

- NAVs are end-of-day values; mutual funds have no intraday price.
- Rankings sort past results. They don't include expense ratio, fund size, portfolio overlap or fund manager yet. AMFI publishes expense ratios and AUM separately, which makes them the natural next addition.
- IDCW and other non-growth options aren't tracked unless you list them in `extra_schemes`. Until then, the portfolio page fetches their NAVs from MFapi.in and says so.
- This is a planning tool, not investment advice.
