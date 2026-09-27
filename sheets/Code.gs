/** @OnlyCurrentDoc */

/**
 * Google Sheet sync for SIPs, v1.
 *
 * Keeps your plan and your portfolio in a Google Sheet that you own, and in
 * step across every browser you connect: a web app bound to the Sheet, a
 * secret every request must carry, records merged by id with the newest edit
 * winning, and deletions kept as markers so a removed investment stays
 * removed on every device.
 *
 * SETUP (about five minutes, once; README.md has the same steps in full):
 *   1. Create a blank Google Sheet.
 *   2. Extensions -> Apps Script. Delete what is there, paste this file
 *      unchanged, and save.
 *   3. Project Settings (the gear icon) -> Script properties -> Add script
 *      property. Property: SECRET. Value: a long random string, at least 16
 *      characters (the site's "Make a new secret" button makes one).
 *      The secret lives there, not in this file, so this file never needs
 *      editing and is safe in a public repository.
 *   4. Deploy -> New deployment -> Select type: Web app.
 *        Execute as:      Me
 *        Who has access:  Anyone
 *   5. Authorise. "Google hasn't verified this app" is expected: the app is the
 *      script you just pasted. Advanced -> Go to (project name) -> Allow.
 *   6. Copy the web app URL (it ends in /exec). On the site, open My portfolio
 *      -> Google Sheet, paste the URL and the secret, and press Connect.
 *   7. Do step 6 on every device you use, with the same URL and secret.
 *
 * AFTER CHANGING THIS FILE: Deploy -> Manage deployments -> Edit (pencil) ->
 * Version: New version -> Deploy. Saving alone doesn't change what /exec runs.
 * Changing the SECRET property needs no new deployment, but every device must
 * be connected again with the new value.
 *
 * WHAT IS STORED
 *   _data (hidden tab), one row per record:
 *       key | c | id | at | del | rev | json1 .. json8
 *     c     holdings (one investment), settings (the plan; the statement's
 *           notes), snapshot (the latest valuation, for the Portfolio tab)
 *     at    when the record last changed, in milliseconds. The newest wins.
 *     del   1 when the record was deleted. The row stays so the deletion
 *           reaches every device instead of a device putting it back.
 *     rev   bumped on every write. A device asks for "everything after rev N",
 *           so a sync carries only what changed.
 *     json  the record as JSON, split over up to 8 cells of 45,000 characters
 *           (a cell holds 50,000), so a long statement history still fits.
 *   Portfolio, Investments, Transactions, Plan: readable copies, rebuilt after
 *     every change. Edit on the site; edits made in these tabs are overwritten.
 *
 * The Sheet holds your portfolio in readable form. Share it with nobody, and
 * turn on 2-step verification for the Google account that owns it.
 *
 * @OnlyCurrentDoc above limits the script to the Sheet it's attached to, so
 * Google asks for access to this one Sheet, not to all of your spreadsheets.
 */

var APP = 'corpus-planner';
var VERSION = 1;
var MIN_SECRET = 16;

var DATA = '_data';
var META_COLS = ['key', 'c', 'id', 'at', 'del', 'rev'];
var JSON_COLS = 8;
var WIDTH = META_COLS.length + JSON_COLS;
var CHUNK = 45000;
var CHUNK_MARK = '~';       // starts every stored piece; Sheets never reads it as a formula or number

var COLLECTIONS = { holdings: true, settings: true, snapshot: true };
var PULLED = { holdings: true, settings: true };   // the snapshot is written by devices, never sent back
var ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
var TABS = ['Portfolio', 'Investments', 'Transactions', 'Plan'];

/** The Sheet this script is attached to (Extensions -> Apps Script). */
function book_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function props_() { return PropertiesService.getScriptProperties(); }

function secret_() {
  var s = String(props_().getProperty('SECRET') || '').trim();
  return s.length >= MIN_SECRET ? s : '';
}

/** Adds a "SIPs" menu to the Sheet for the occasional manual job. */
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('SIPs')
      .addItem('Refresh the readable tabs', 'REFRESH_TABS')
      .addItem('Check that this Sheet stores data exactly', 'TEST_STORAGE')
      .addSeparator()
      .addItem('Erase the synced data', 'RESET_EVERYTHING')
      .addToUi();
  } catch (e) { /* no UI when running headless */ }
}

function doGet() {
  return out_({ ok: true, app: APP, version: VERSION, msg: 'SIPs sync is running. The site talks to it with POST requests.' });
}

function doPost(e) {
  try {
    var secret = secret_();
    if (!secret) {
      return out_({ ok: false, app: APP, setup: true,
                    error: 'The script has no SECRET yet. In Apps Script, open Project Settings -> Script properties and add ' +
                           'SECRET with a random value of at least ' + MIN_SECRET + ' characters.' });
    }
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (typeof body.secret !== 'string' || body.secret !== secret) {
      return out_({ ok: false, app: APP, badSecret: true, error: "The secret doesn't match the SECRET script property." });
    }
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);          // two devices may sync at the same moment
    try {
      var action = body.action || 'sync';
      if (action === 'ping') return out_(ping_());
      if (action === 'sync') return out_(sync_(body));
      return out_({ ok: false, app: APP, error: 'Unknown action: ' + action });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return out_({ ok: false, app: APP, error: String((err && err.message) || err) });
  }
}

/** Run fn holding the script lock. Menu items use this; doPost already holds it. */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function ping_() {
  return { ok: true, app: APP, version: VERSION, epoch: epoch_(), sheetUrl: book_().getUrl(), now: Date.now() };
}

/* ============================== the sync ============================== */

/**
 * One round trip: store what the device changed, then hand back everything it
 * hasn't seen.
 *
 * Request  { epoch, since, changes: [{ c, id, at, del, data }] }
 * Response { ok, epoch, resync, cursor, changes: [...], rejected: [...], refused: [...], now, sheetUrl }
 *
 * A change is kept only if its `at` is newer than the stored one. Otherwise the
 * stored record goes back in `rejected`, so the device replaces its copy and
 * every device ends up with the same data even when their clocks disagree.
 * `epoch` changes only when the data is erased; a device that sees a new epoch
 * gets everything (resync) and sends back what it holds.
 */
function sync_(body) {
  var t = readTable_();
  var epoch = epoch_();
  var resync = String(body.epoch || '') !== epoch;
  var since = resync ? 0 : Math.max(0, Number(body.since) || 0);
  // The stored counter can lag the rows if a run died between writing them and
  // saving it; never hand out a rev that's already in the table.
  var rev = Math.max(Number(props_().getProperty('rev') || 0), maxRev_(t));
  var res = { ok: true, app: APP, version: VERSION, epoch: epoch, resync: resync, rejected: [], refused: [] };

  var changes = Array.isArray(body.changes) ? body.changes : [];
  for (var i = 0; i < changes.length; i++) {
    var ch = changes[i] || {};
    var c = String(ch.c || ''), id = String(ch.id || ''), at = Number(ch.at);
    if (!COLLECTIONS[c] || !ID_RE.test(id) || !(at > 0)) {
      res.refused.push({ c: c, id: id, error: 'Not a record this script keeps' });
      continue;
    }
    var key = c + '/' + id, cur = t.byKey[key];
    if (cur && !newer_(c, ch, cur)) {
      if (PULLED[c]) { var d = doc_(cur); if (d) res.rejected.push(d); }
      continue;
    }
    var del = !!ch.del;
    var cells = del ? cells_(null) : cells_(ch.data === undefined ? null : ch.data);
    if (!cells) {
      res.refused.push({ c: c, id: id, error: 'Too large to store: over ' + JSON_COLS * CHUNK + ' characters' });
      continue;
    }
    var rec = cur || { key: key, c: c, id: id };
    rec.at = at; rec.del = del; rec.rev = ++rev; rec.cells = cells;
    if (!cur) { t.rows.push(rec); t.byKey[key] = rec; }
    t.dirty.push(rec);
  }

  if (t.dirty.length) {
    res.wrote = t.dirty.length;
    flush_(t);
    props_().setProperty('rev', String(rev));
    refreshViews_(t);
  }

  res.changes = [];
  for (var j = 0; j < t.rows.length; j++) {
    var r = t.rows[j];
    if (r.rev > since && PULLED[r.c]) { var doc = doc_(r); if (doc) res.changes.push(doc); }
  }
  res.cursor = rev;
  res.now = Date.now();
  res.sheetUrl = book_().getUrl();
  return res;
}

/** Whether an incoming change should replace the stored record. */
function newer_(c, ch, cur) {
  if (!(Number(ch.at) > cur.at)) return false;
  // A valuation made with older NAVs (a device whose copy of the site's data
  // is out of date) never replaces a newer one.
  if (c === 'snapshot' && !cur.del && !ch.del) {
    var old = recData_(cur), nd = ch.data && ch.data.navDate;
    if (old && old.navDate && (!nd || String(nd) < String(old.navDate))) return false;
  }
  return true;
}

function epoch_() {
  var p = props_(), ep = p.getProperty('epoch');
  if (!ep) { ep = newEpoch_(); p.setProperty('epoch', ep); }
  return ep;
}

/** Unique even when made in the same millisecond as the last one. */
function newEpoch_() {
  return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ============================== the data tab ============================== */

function header_() {
  var h = META_COLS.slice();
  for (var i = 1; i <= JSON_COLS; i++) h.push('json' + i);
  return h;
}

/**
 * The hidden data tab, made exactly as wide as its columns. Google counts every
 * cell of every tab against the Sheet's 10 million, empty or not, and a new
 * tab is 26 columns wide.
 */
function dataSheet_() {
  var ss = book_();
  var sh = ss.getSheetByName(DATA);
  if (!sh) {
    sh = ss.insertSheet(DATA);
    sh.hideSheet();
    fit_(sh, 0, WIDTH);
    sh.getRange(1, 1, 1, WIDTH).setValues([header_()]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Every stored record, read in one go: the whole tab is small. */
function readTable_() {
  var sh = dataSheet_();
  var last = sh.getLastRow();
  var rows = [], byKey = {};
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, WIDTH).getValues();
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i], key = String(v[0]);
      if (!key) continue;
      var rec = { r: i + 2, key: key, c: String(v[1]), id: String(v[2]), at: Number(v[3]) || 0,
                  del: String(v[4]) === '1', rev: Number(v[5]) || 0, cells: v.slice(META_COLS.length) };
      rows.push(rec);
      byKey[key] = rec;
    }
  }
  return { sh: sh, rows: rows, byKey: byKey, dirty: [] };
}

function maxRev_(t) {
  var m = 0;
  for (var i = 0; i < t.rows.length; i++) if (t.rows[i].rev > m) m = t.rows[i].rev;
  return m;
}

function row_(rec) {
  return [rec.key, rec.c, rec.id, String(rec.at), rec.del ? '1' : '', String(rec.rev)].concat(rec.cells);
}

/** Write the changed records: each existing row in place, new ones appended in one go. */
function flush_(t) {
  var fresh = [];
  for (var i = 0; i < t.dirty.length; i++) {
    var rec = t.dirty[i];
    if (rec.r) writeRows_(t.sh, rec.r, [row_(rec)]);
    else if (fresh.indexOf(rec) < 0) fresh.push(rec);
  }
  if (fresh.length) {
    var start = Math.max(2, t.sh.getLastRow() + 1);
    for (var j = 0; j < fresh.length; j++) fresh[j].r = start + j;
    writeRows_(t.sh, start, fresh.map(row_));
  }
  t.dirty = [];
}

/**
 * Plain text, so Sheets keeps ids, times and JSON exactly as sent rather than
 * reading them the way it reads something typed into a cell. A new tab has
 * 1,000 rows and getRange() throws past that, so grow it first.
 */
function writeRows_(sh, start, rows) {
  var need = start + rows.length - 1, max = sh.getMaxRows();
  if (need > max) sh.insertRowsAfter(max, need - max + 100);
  sh.getRange(start, 1, rows.length, WIDTH).setNumberFormat('@').setValues(rows);
}

/** A record's JSON cut into JSON_COLS cells, each marked; null if it's too big. */
function cells_(data) {
  var out = [];
  if (data !== null) {
    var s = JSON.stringify(data);
    for (var i = 0; i < s.length; i += CHUNK) out.push(CHUNK_MARK + s.substr(i, CHUNK));
    if (out.length > JSON_COLS) return null;
  }
  while (out.length < JSON_COLS) out.push('');
  return out;
}

/** The stored record's data: null if deleted, undefined if the cells don't hold valid JSON. */
function recData_(rec) {
  if (rec.del) return null;
  var s = '';
  for (var i = 0; i < rec.cells.length; i++) {
    var p = String(rec.cells[i] == null ? '' : rec.cells[i]);
    if (p) s += p.charAt(0) === CHUNK_MARK ? p.substr(1) : p;
  }
  if (!s) return undefined;
  try { return JSON.parse(s); } catch (e) { return undefined; }
}

/** A record as a device receives it, or null when its cells were damaged (by hand). */
function doc_(rec) {
  var data = recData_(rec);
  if (!rec.del && data === undefined) return null;
  return { c: rec.c, id: rec.id, at: rec.at, del: rec.del ? 1 : 0, data: rec.del ? null : data };
}

/* ============================= readable tabs ============================= */
/* Purely so you can read your data. Rebuilt from _data after every change;
   edits made here are overwritten. Numbers are real numbers and dates real
   dates, so sorting, filtering and formulas in other tabs work on them. */

var KIND = { sip: 'Monthly SIP', lump: 'One-time', cas: 'From statement' };

var TXN_TYPES = {
  PURCHASE: 'Purchase', PURCHASE_SIP: 'SIP purchase', REDEMPTION: 'Redemption',
  SWITCH_IN: 'Switch in', SWITCH_OUT: 'Switch out', SWITCH_IN_MERGER: 'Switch in (merger)',
  SWITCH_OUT_MERGER: 'Switch out (merger)', DIVIDEND_PAYOUT: 'IDCW paid out',
  DIVIDEND_REINVEST: 'IDCW reinvested', STAMP_DUTY_TAX: 'Stamp duty', STT_TAX: 'STT',
  TDS_TAX: 'TDS', REVERSAL: 'Reversal', SEGREGATION: 'Segregation', BONUS: 'Bonus units',
  TRANSFER_IN: 'Transfer in', TRANSFER_OUT: 'Transfer out', MISC: 'Other'
};

// The planner's own wording for each input, in the order the page shows them.
var PLAN_LABELS = [
  ['monthlySip', 'Monthly SIP today (₹)'],
  ['existingCorpus', 'Current portfolio value (₹)'],
  ['sipYears', 'Keep investing for (years)'],
  ['stepUpType', 'Raise the SIP every year by'],
  ['stepUpValue', 'Yearly step-up'],
  ['stepUpCap', 'Stop raising once the SIP reaches (₹, 0 means no limit)'],
  ['rates', 'Rates to compare (% a year)'],
  ['selectedRate', 'Rate selected (% a year)'],
  ['inflation', 'Inflation (% a year)'],
  ['currentAge', 'Your age today'],
  ['swpEnabled', 'Withdrawals (SWP)'],
  ['swpGapYears', 'Start withdrawing (years after the last SIP)'],
  ['swpMonthly', 'Monthly withdrawal in the first year (₹)'],
  ['swpIncrease', 'Raise the withdrawal every year by (%)'],
  ['swpYears', 'Withdraw for (years)'],
  ['swpReturnMode', 'Return while withdrawing'],
  ['swpReturnValue', 'Return while withdrawing (%)'],
  ['rateMode', 'Turning a yearly return into a monthly one'],
  ['timing', 'SIP and SWP happen at the']
];
var PLAN_VALUES = {
  stepUpType: { pct: 'a percentage', amt: 'a rupee amount' },
  swpReturnMode: { same: 'Same as while investing', minus: 'Lower by', fixed: 'Fixed' },
  rateMode: { effective: 'Compound: (1 + r)^(1/12) − 1', nominal: 'Simple: r ÷ 12' },
  timing: { start: 'Start of month', end: 'End of month' }
};

/** Menu item: rebuild the readable tabs now. */
function REFRESH_TABS() { return withLock_(function () { refreshViews_(); }); }

function refreshViews_(t) {
  t = t || readTable_();
  var live = { holdings: [], settings: {}, snapshot: null };
  for (var i = 0; i < t.rows.length; i++) {
    var rec = t.rows[i];
    if (rec.del) continue;
    var d = recData_(rec);
    if (d === undefined || d === null) continue;
    if (rec.c === 'holdings') live.holdings.push({ at: rec.at, h: d });
    else if (rec.c === 'settings') live.settings[rec.id] = { at: rec.at, d: d };
    else if (rec.c === 'snapshot' && rec.id === 'latest') live.snapshot = { at: rec.at, d: d };
  }
  live.holdings.sort(function (a, b) {
    return kindOrder_(a.h.kind) - kindOrder_(b.h.kind) || String(a.h.name || '').localeCompare(String(b.h.name || ''));
  });
  portfolioTab_(live.snapshot);
  investmentsTab_(live.holdings);
  transactionsTab_(live.holdings);
  planTab_(live.settings.plan);
}

function kindOrder_(k) { return k === 'sip' ? 0 : k === 'lump' ? 1 : 2; }

function portfolioTab_(latest) {
  var snap = latest && latest.d;
  var headers = ['Investment', 'Kind', 'Units', 'Put in, net (₹)', 'Worth (₹)', 'Gain (₹)', 'XIRR', 'NAV date', 'Note'];
  var rows = [];
  if (!snap) {
    rows.push(pad_(['Open My portfolio on the site to value your investments here.'], headers.length));
    return tab_('Portfolio', headers, rows, null);
  }
  (snap.rows || []).forEach(function (r) {
    rows.push(r.error
      ? [text_(r.name), KIND[r.kind] || '', '', '', '', '', '', '', text_(r.error)]
      : [text_(r.name), KIND[r.kind] || '', num_(r.units), num_(r.net), num_(r.value), num_(r.gain), num_(r.xirr), day_(r.navDate), '']);
  });
  var tot = snap.totals;
  if (tot && rows.length) {
    rows.push(['Total', '', '', num_(tot.net), num_(tot.value), num_(tot.gain), num_(tot.xirr), day_(snap.navDate), '']);
  }
  if (!rows.length) rows.push(pad_(['No investments yet.'], headers.length));
  rows.push(pad_([''], headers.length));
  rows.push(pad_(['Valued ' + stamp_(latest.at) + (snap.navDate ? ', using NAVs up to ' + snap.navDate : '') +
                  '. The site values your portfolio each time you open My portfolio.'], headers.length));
  tab_('Portfolio', headers, rows, ['@', '@', '#,##0.000', '#,##0', '#,##0', '#,##0', '0.00%', 'd mmm yyyy', '@']);
}

function investmentsTab_(list) {
  var headers = ['Fund', 'Kind', 'Scheme code', 'ISIN', 'Amount (₹)', 'Debit day', 'First SIP', 'Stopped',
                 'Raised every year (%)', 'Date invested', 'Folio', 'Transactions', 'Units in statement', 'Last changed'];
  var rows = list.map(function (x) {
    var h = x.h, sip = h.kind === 'sip', lump = h.kind === 'lump', cas = h.kind === 'cas';
    return [
      text_(h.name), KIND[h.kind] || text_(h.kind), num_(h.code), text_(h.isin),
      sip || lump ? num_(h.amount) : '', sip ? num_(h.day) : '', sip ? month_(h.start) : '', sip ? month_(h.end) : '',
      sip ? num_(h.step) : '', lump ? day_(h.date) : '', cas ? text_(h.folio) : '',
      cas ? (h.txns || []).length : '', cas ? num_(h.closeUnits) : '', new Date(x.at)
    ];
  });
  if (!rows.length) rows.push(pad_(['No investments yet. Add them on the site, under My portfolio.'], headers.length));
  tab_('Investments', headers, rows, ['@', '@', '0', '@', '#,##0', '0', 'mmm yyyy', 'mmm yyyy', '0.##', 'd mmm yyyy',
                                      '@', '0', '#,##0.000', 'd mmm yyyy h:mm']);
}

function transactionsTab_(list) {
  var headers = ['Fund', 'Folio', 'Date', 'Type', 'Amount (₹)', 'Units', 'NAV'];
  var rows = [];
  list.forEach(function (x) {
    var h = x.h;
    if (h.kind !== 'cas') return;
    (h.txns || []).slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); }).forEach(function (tx) {
      rows.push([text_(h.name), text_(h.folio), day_(tx.date), TXN_TYPES[tx.type] || text_(tx.type),
                 num_(tx.amount), num_(tx.units), num_(tx.nav)]);
    });
  });
  if (!rows.length) rows.push(pad_(['Nothing yet. Import your CAS statement on the site to see every transaction here.'], headers.length));
  tab_('Transactions', headers, rows, ['@', '@', 'd mmm yyyy', '@', '#,##0.00', '#,##0.000', '#,##0.0000']);
}

function planTab_(plan) {
  var headers = ['Setting', 'Value'];
  var rows = [];
  if (!plan) {
    rows.push(['Nothing yet. Change any input on the Plan page and it appears here.', '']);
    return tab_('Plan', headers, rows, ['@', '@']);
  }
  var d = plan.d;
  PLAN_LABELS.forEach(function (pair) {
    var k = pair[0], v = d[k];
    if (!(k in d)) return;
    if (PLAN_VALUES[k]) v = PLAN_VALUES[k][v] || v;
    else if (k === 'swpEnabled') v = v ? 'On' : 'Off';
    else if (Array.isArray(v)) v = v.join(', ');
    rows.push([pair[1], typeof v === 'number' ? v : text_(v)]);
  });
  rows.push(['Last changed', stamp_(plan.at)]);
  tab_('Plan', headers, rows, ['@', '@']);
}

/**
 * Replace a readable tab's contents. A new tab goes where TABS says. The tab
 * is cut to exactly what it shows, since it's rebuilt whole every time.
 */
function tab_(name, headers, rows, formats) {
  var ss = book_();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name, Math.min(TABS.indexOf(name), ss.getSheets().length));
  sh.clear();
  var n = rows.length + 1, w = headers.length;
  fit_(sh, n, w);
  sh.getRange(1, 1, 1, w).setValues([headers]).setFontWeight('bold');
  if (rows.length) {
    var body = sh.getRange(2, 1, rows.length, w);
    body.setValues(rows);
    if (formats) body.setNumberFormats(rows.map(function () { return formats; }));
  }
  sh.setFrozenRows(1);
}

/** Make a tab exactly `rows` x `cols` (rows = 0 leaves the row count alone). */
function fit_(sh, rows, cols) {
  var maxC = sh.getMaxColumns();
  if (maxC > cols) sh.deleteColumns(cols + 1, maxC - cols);
  else if (maxC < cols) sh.insertColumnsAfter(maxC, cols - maxC);
  if (rows) {
    rows = Math.max(2, rows);
    var maxR = sh.getMaxRows();
    if (maxR > rows) sh.deleteRows(rows + 1, maxR - rows);
    else if (maxR < rows) sh.insertRowsAfter(maxR, rows - maxR);
  }
}

function pad_(row, w) { while (row.length < w) row.push(''); return row; }

/**
 * Keep text as text. Sheets reads a value starting with = + - or @ as a
 * formula, the way it would if typed: a fund name that began with = would run
 * in your Sheet. A leading apostrophe makes Sheets store it as text, unshown.
 */
function text_(v) {
  if (v === undefined || v === null) return '';
  var s = String(v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function num_(v) {
  if (v === undefined || v === null || v === '') return '';
  var n = Number(v);
  return isFinite(n) ? n : '';
}

/** "2026-09-25" as a date in the Sheet's calendar (no time-zone shift). */
function day_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : '';
}

/** "2026-09" as the first of that month, shown as "Sep 2026". */
function month_(s) {
  var m = /^(\d{4})-(\d{2})$/.exec(String(s || ''));
  return m ? new Date(+m[1], +m[2] - 1, 1) : '';
}

function stamp_(ms) {
  var d = new Date(Number(ms) || 0);
  try { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'd MMM yyyy, h:mm a'); }
  catch (e) { return d.toISOString(); }
}

/* ============================== maintenance ============================== */

/**
 * Erase the synced data and start over. Every device that still holds a plan
 * or investments sends them back at its next sync (it sees the new epoch), so
 * to empty everything, first use "Remove everything" on the site and
 * disconnect your other devices.
 */
function RESET_EVERYTHING() {
  try {
    var ui = SpreadsheetApp.getUi();
    var ok = ui.alert('Erase the synced data?',
                      'This removes every investment and the plan from this Sheet. Devices that still hold them send them back when they next sync.',
                      ui.ButtonSet.YES_NO);
    if (ok !== ui.Button.YES) return false;
  } catch (e) { /* run from the editor: running it is the confirmation */ }
  return withLock_(resetEverything_);
}

function resetEverything_() {
  var ss = book_();
  var names = [DATA].concat(TABS);
  if (ss.getSheets().every(function (sh) { return names.indexOf(sh.getName()) >= 0; })) ss.insertSheet('Sheet1');
  names.forEach(function (n) { var sh = ss.getSheetByName(n); if (sh) ss.deleteSheet(sh); });
  var p = props_();
  p.deleteProperty('rev');
  p.setProperty('epoch', newEpoch_());
  Logger.log('Erased. Devices that still hold data will send it back at their next sync.');
  return true;
}

/**
 * Run from the editor, or the SIPs menu, to check that this Sheet
 * keeps the site's data exactly: awkward values go through the same write and
 * read as real records, including a record long enough to need several cells.
 */
function TEST_STORAGE() {
  return withLock_(function () {
    var ss = book_(), name = '_storage_test', lines = [], ok = true;
    var stale = ss.getSheetByName(name);
    if (stale) ss.deleteSheet(stale);
    var sh = ss.insertSheet(name);
    try {
      fit_(sh, 0, WIDTH);
      var risky = ['=1+1', '+91 12345 67890', '-5', '@home', '0012345', '1e5', '2026-09-25', 'INF846K01WO1', '₹ ✓ “quotes”'];
      var long = '';
      while (long.length < CHUNK * 2 + 10) long += '=SUM(A1)+' + long.length + ';';
      var cases = risky.map(function (v) { return { name: v, v: v }; }).concat([{ name: 'a ' + long.length + '-character record', v: long }]);
      var rows = cases.map(function (x, i) {
        return row_({ key: 'test/' + i, c: 'test', id: String(i), at: 1, del: false, rev: i + 1, cells: cells_({ v: x.v }) });
      });
      writeRows_(sh, 1, rows);
      SpreadsheetApp.flush();
      var back = sh.getRange(1, 1, rows.length, WIDTH).getValues();
      for (var i = 0; i < cases.length; i++) {
        var got = recData_({ del: false, cells: back[i].slice(META_COLS.length) });
        var same = !!got && got.v === cases[i].v && String(back[i][3]) === '1';
        if (!same) ok = false;
        lines.push(JSON.stringify(cases[i].name.length > 60 ? cases[i].name.slice(0, 60) + '…' : cases[i].name) + ': ' + (same ? 'same' : 'CHANGED'));
      }
    } finally {
      ss.deleteSheet(sh);
    }
    lines.unshift(ok ? "OK: this Sheet stores the site's data exactly." : 'PROBLEM: see the lines marked CHANGED.');
    tellOwner_(lines.join('\n'));
    return { ok: ok, lines: lines };
  });
}

/** Log a result, and show it too when run from the Sheet's menu. */
function tellOwner_(msg) {
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* run from the editor: the log has it */ }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
