/**
 * Google Drive archive for SIPs, v1.
 *
 * Keeps a copy of AMFI's data in your own Google Drive. The nightly GitHub
 * job sends it here:
 *
 *   SIPs archive/
 *     NAVAll/2026/09/NAVAll-2026-09-26.txt.gz    each night's NAVAll.txt, exactly
 *                                                as AMFI served it, named by the
 *                                                day it was downloaded (IST)
 *     NAV history/NAV history 2026-10-01/       the tracked funds' full NAV history,
 *       nav-history-2026-10-01-part1of6.tar.gz  once a month; the last 2 are kept
 *       ...
 *       manifest.json
 *
 * A .txt.gz file opens with any unzip tool (7-Zip on Windows, double-click on
 * a Mac). The history parts restore into the pipeline's cache with:
 *   for f in *.tar.gz; do tar xzf "$f" -C .cache; done
 *
 * This is a separate script from the Sheet sync (Code.gs) on purpose: saving
 * files needs Google Drive access, and Code.gs stays limited to its one Sheet.
 * This script only ever creates files inside its own folder, and trashes only
 * its own older history copies.
 *
 * SETUP (README.md has the same steps in full):
 *   1. Go to script.google.com -> New project. Name it "SIPs archive".
 *      Delete what's there, paste this file unchanged, and save.
 *   2. Project Settings (the gear) -> Script Properties -> Add script property.
 *      Property: SECRET. Value: a long random string, at least 16 characters,
 *      different from the Sheet sync's secret.
 *   3. Deploy -> New deployment -> Web app. Execute as: Me. Who has access: Anyone.
 *   4. Authorise. "Google hasn't verified this app" is expected: the app is the
 *      script you just pasted. Advanced -> Go to (project) -> Allow.
 *   5. In the GitHub repository: Settings -> Secrets and variables -> Actions ->
 *      New repository secret. ARCHIVE_URL = the web app URL (ends in /exec),
 *      ARCHIVE_SECRET = the same secret as step 2.
 *
 * AFTER CHANGING THIS FILE: Deploy -> Manage deployments -> Edit (pencil) ->
 * Version: New version -> Deploy.
 */

var APP = 'corpus-planner-archive';
var VERSION = 1;
var MIN_SECRET = 16;
var ROOT_NAME = 'SIPs archive';
var OLD_ROOT_NAMES = ['Corpus planner archive'];   // the app's earlier name; that folder is kept and renamed
var DAILY_DIR = 'NAVAll';
var HISTORY_DIR = 'NAV history';
var SNAP_PREFIX = 'NAV history ';
var INCOMING_PREFIX = 'Incoming ';
var KEEP_SNAPSHOTS = 2;
var MAX_BYTES = 40 * 1024 * 1024;       // one upload; the site sends ~5 MB parts
var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function props_() { return PropertiesService.getScriptProperties(); }

function secret_() {
  var s = String(props_().getProperty('SECRET') || '').trim();
  return s.length >= MIN_SECRET ? s : '';
}

function doGet() {
  return out_({ ok: true, app: APP, version: VERSION, msg: 'SIPs archive is running. The nightly job talks to it with POST requests.' });
}

function doPost(e) {
  try {
    var secret = secret_();
    if (!secret) {
      return out_({ ok: false, app: APP, setup: true,
                    error: 'The archive script has no SECRET yet. In Apps Script, open Project Settings -> Script properties ' +
                           'and add SECRET, at least ' + MIN_SECRET + ' characters long.' });
    }
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (typeof body.secret !== 'string' || body.secret !== secret) {
      return out_({ ok: false, app: APP, badSecret: true,
                    error: "The secret doesn't match the archive script's SECRET property. Check the ARCHIVE_SECRET repository secret." });
    }
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var action = body.action || 'status';
      if (action === 'status') return out_(status_());
      if (action === 'putDaily') return out_(putDaily_(body));
      if (action === 'snapshotPut') return out_(snapshotPut_(body));
      if (action === 'snapshotCommit') return out_(snapshotCommit_(body));
      return out_({ ok: false, app: APP, error: 'Unknown action: ' + action });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return out_({ ok: false, app: APP, error: String((err && err.message) || err) });
  }
}

/* ============================== folders ============================== */

/**
 * The archive's own folder, in the top level of My Drive. Found by the id
 * saved when it was made, so renaming or moving it is fine; made again only
 * if it was deleted.
 */
function root_() {
  var p = props_(), id = p.getProperty('rootId');
  if (id) {
    try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return renamed_(f); } catch (e) { /* gone: find or make it */ }
  }
  var names = [ROOT_NAME].concat(OLD_ROOT_NAMES), folder = null;
  for (var i = 0; i < names.length && !folder; i++) {
    var it = DriveApp.getRootFolder().getFoldersByName(names[i]);
    while (it.hasNext()) { var x = it.next(); if (!x.isTrashed()) { folder = x; break; } }
  }
  folder = folder ? renamed_(folder) : DriveApp.getRootFolder().createFolder(ROOT_NAME);
  p.setProperty('rootId', folder.getId());
  return folder;
}

/** A folder made under the app's earlier name takes the current one; any other name is the owner's choice. */
function renamed_(folder) {
  if (OLD_ROOT_NAMES.indexOf(folder.getName()) >= 0) folder.setName(ROOT_NAME);
  return folder;
}

function child_(parent, name) {
  var it = parent.getFoldersByName(name);
  while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) return f; }
  return parent.createFolder(name);
}

function findFile_(folder, name) {
  var it = folder.getFilesByName(name);
  while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) return f; }
  return null;
}

function bytes_(b64) {
  var bytes = Utilities.base64Decode(String(b64 || ''));
  if (!bytes.length) throw new Error('No file was sent.');
  if (bytes.length > MAX_BYTES) throw new Error('The file is larger than ' + MAX_BYTES + ' bytes.');
  return bytes;
}

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

/* ============================ the daily file ============================ */

/**
 * body: { date: '2026-09-26', md5: of the unzipped file, size, data: base64 of the .gz }
 *
 * One file per day it was downloaded. The same file sent again that day (a
 * re-run) stores nothing; a different one (AMFI changed it in between) is kept
 * too, as NAVAll-2026-09-26-2.txt.gz.
 */
function putDaily_(body) {
  var day = String(body.date || '');
  if (!DAY_RE.test(day)) return { ok: false, app: APP, error: 'Not a date: ' + day };
  var md5 = String(body.md5 || '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(md5)) return { ok: false, app: APP, error: 'No checksum was sent.' };
  var bytes = bytes_(body.data);

  var folder = child_(child_(child_(root_(), DAILY_DIR), day.slice(0, 4)), day.slice(5, 7));
  var base = 'NAVAll-' + day, name = base + '.txt.gz';
  for (var n = 1; n < 100; n++) {
    name = base + (n === 1 ? '' : '-' + n) + '.txt.gz';
    var existing = findFile_(folder, name);
    if (!existing) break;
    var meta = {};
    try { meta = JSON.parse(existing.getDescription() || '{}'); } catch (e) { /* hand-edited: treat as different */ }
    if (meta.md5 === md5) return { ok: true, app: APP, stored: false, name: name, snapshot: latestSnapshot_() };
  }
  var file = folder.createFile(Utilities.newBlob(bytes, 'application/gzip', name));
  file.setDescription(JSON.stringify({ md5: md5, size: Number(body.size) || null, downloaded: day,
                                       source: 'https://www.amfiindia.com/spages/NAVAll.txt' }));
  return { ok: true, app: APP, stored: true, name: name, snapshot: latestSnapshot_() };
}

/* ========================== the history snapshot ========================== */

function historyDir_() { return child_(root_(), HISTORY_DIR); }

function partName_(id, part, parts) { return 'nav-history-' + id + '-part' + part + 'of' + parts + '.tar.gz'; }

/** body: { id: '2026-10-01', part, parts, sha256, data } — one part, into a folder of its own until complete. */
function snapshotPut_(body) {
  var id = String(body.id || ''), part = Number(body.part), parts = Number(body.parts);
  if (!DAY_RE.test(id)) return { ok: false, app: APP, error: 'Not a snapshot id: ' + id };
  if (!(parts >= 1 && parts <= 200 && part >= 1 && part <= parts)) return { ok: false, app: APP, error: 'Bad part number.' };
  var bytes = bytes_(body.data);
  if (body.sha256) {
    var sha = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
    if (sha !== String(body.sha256).toLowerCase()) return { ok: false, app: APP, error: 'Part ' + part + ' arrived damaged; the job will try again next time.' };
  }
  var folder = child_(historyDir_(), INCOMING_PREFIX + id);
  var name = partName_(id, part, parts);
  var old = findFile_(folder, name);
  if (old) old.setTrashed(true);                  // a retried part replaces the earlier try
  folder.createFile(Utilities.newBlob(bytes, 'application/gzip', name));
  return { ok: true, app: APP, stored: name };
}

/**
 * body: { id, parts, manifest } — every part arrived: the copy becomes
 * "NAV history <id>", and only the newest KEEP_SNAPSHOTS copies are kept.
 * Until this runs, a half-sent copy never replaces a complete one.
 */
function snapshotCommit_(body) {
  var id = String(body.id || ''), parts = Number(body.parts);
  if (!DAY_RE.test(id)) return { ok: false, app: APP, error: 'Not a snapshot id: ' + id };
  var dir = historyDir_();
  var it = dir.getFoldersByName(INCOMING_PREFIX + id);
  var incoming = null;
  while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) { incoming = f; break; } }
  if (!incoming) return { ok: false, app: APP, error: 'No parts arrived for ' + id + '.' };
  var missing = [];
  for (var p = 1; p <= parts; p++) if (!findFile_(incoming, partName_(id, p, parts))) missing.push(p);
  if (missing.length) return { ok: false, app: APP, error: 'Parts missing for ' + id + ': ' + missing.join(', ') };

  incoming.createFile(Utilities.newBlob(JSON.stringify(body.manifest || {}, null, 1), 'application/json', 'manifest.json'));
  var same = dir.getFoldersByName(SNAP_PREFIX + id);          // a second run the same day replaces the first
  while (same.hasNext()) { var s = same.next(); if (!s.isTrashed()) s.setTrashed(true); }
  incoming.setName(SNAP_PREFIX + id);

  // Keep the newest copies; trash older ones and any half-sent leftovers.
  var snaps = [], all = dir.getFolders();
  while (all.hasNext()) {
    var folder = all.next();
    if (folder.isTrashed()) continue;
    var name = folder.getName();
    if (name.indexOf(SNAP_PREFIX) === 0 && DAY_RE.test(name.slice(SNAP_PREFIX.length))) snaps.push(folder);
    else if (name.indexOf(INCOMING_PREFIX) === 0) folder.setTrashed(true);
  }
  snaps.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
  var trashed = [];
  snaps.slice(KEEP_SNAPSHOTS).forEach(function (f) { trashed.push(f.getName()); f.setTrashed(true); });
  return { ok: true, app: APP, snapshot: { id: id }, parts: parts, trashed: trashed };
}

/** The newest complete history copy, or null. */
function latestSnapshot_() {
  var dir = historyDir_(), all = dir.getFolders(), best = null;
  while (all.hasNext()) {
    var f = all.next();
    if (f.isTrashed()) continue;
    var name = f.getName(), id = name.slice(SNAP_PREFIX.length);
    if (name.indexOf(SNAP_PREFIX) === 0 && DAY_RE.test(id) && (!best || id > best)) best = id;
  }
  return best ? { id: best } : null;
}

function status_() {
  return { ok: true, app: APP, version: VERSION, folder: root_().getUrl(), snapshot: latestSnapshot_() };
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
