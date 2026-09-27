/** @OnlyCurrentDoc */

/**
 * Google Sheet sync for SIPs, v4.
 *
 * Keeps your plan and your portfolio in a Google Sheet that you own, and in
 * step across every browser you connect: a web app bound to the Sheet, a
 * secret every request must carry, records merged by id with the newest edit
 * winning, and deletions kept as markers so a removed investment stays
 * removed on every device.
 *
 * v3 adds a login. Once you make one on the site, the secret no longer opens
 * the data: each device signs in with your name and password, and carries a
 * session of its own that you can sign out. Only hashes are stored here: the
 * password itself never leaves your devices. Forgot it? Your 3 answers plus
 * the one-time recovery code set a new one, and the SIPs menu can remove the
 * login altogether. v3 can also start the site's nightly data update on
 * GitHub, from a button on the site or on its own each day (see FUND DATA).
 *
 * v4 adds family profiles. The first login is the owner's. The owner invites
 * each family member from the site (Security -> Family); each has
 * their own name, password and portfolio, and sees only their own on the
 * site. This Sheet's tabs show everyone's, with a Member column.
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
 *   6. Copy the web app URL (it ends in /exec). On the site, open Google Sheet
 *      (in the menu, or Portfolio -> Sync and backup on a phone), paste the URL
 *      and the secret, and press Connect.
 *   7. Do step 6 on every device you use, with the same URL and secret.
 *
 * AFTER CHANGING THIS FILE: Deploy -> Manage deployments -> Edit (pencil) ->
 * Version: New version -> Deploy. Saving alone doesn't change what /exec runs.
 * If Google asks for new permissions (v3 asks to connect to an external
 * service, for GitHub, and to run while you're away, for the daily check),
 * choose checkNightly in the function list, press Run once, and allow them.
 * Changing the SECRET property needs no new deployment, but every device must
 * be connected again with the new value.
 *
 * FUND DATA (optional): the site's fund data is rebuilt every night by a
 * GitHub Actions workflow, which GitHub pauses after 60 days without a
 * commit. With these script properties, the site's "Update now" button, and
 * SIPs -> Keep the nightly update running, start it from here instead:
 *   GITHUB_TOKEN  a fine-grained personal access token for the one repository,
 *                 with Actions: Read and write (nothing else)
 *   GITHUB_REPO   owner/repository, e.g. customapplication/wealth-calculator.
 *                 The daily check needs it; Update now on the site also fills it in.
 *
 * WHAT IS STORED
 *   _data (hidden tab), one row per record:
 *       key | c | id | at | del | rev | json1 .. json8
 *     c     holdings (one investment), settings (the plan; the statement's
 *           notes; your benchmark choices), snapshot (the latest valuation,
 *           for the Portfolio tab)
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
var VERSION = 4;
var MIN_SECRET = 16;

var MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
var LOGIN_TRIES = 5;           // wrong passwords before logins pause (15 minutes, doubling up to a day)
var RECOVER_TRIES = 3;         // wrong recovery answers before recovery pauses (1 hour, doubling up to a day)
var IDLE_DAYS = 400;           // a device that hasn't synced for this long is signed out
var PROOF_RE = /^[A-Za-z0-9_-]{43}$/;   // 32 bytes from the site's key derivation, base64url
var WORKFLOW = 'nightly.yml';
var REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

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
      .addItem('Keep the nightly data update running', 'KEEP_NIGHTLY')
      .addItem('Check the nightly data update now', 'CHECK_NIGHTLY_NOW')
      .addItem('Stop the daily check', 'STOP_NIGHTLY_CHECK')
      .addSeparator()
      .addItem('Sign out every device', 'SIGN_OUT_EVERY_DEVICE')
      .addItem('Remove the login', 'REMOVE_LOGIN')
      .addItem('Erase the synced data', 'RESET_EVERYTHING')
      .addToUi();
  } catch (e) { /* no UI when running headless */ }
}

function doGet() {
  return out_({ ok: true, app: APP, version: VERSION, msg: 'SIPs sync is running. The site talks to it with POST requests.' });
}

// Actions anyone with the URL may try. Each checks what it needs itself, and the
// ones that test a password, answers or an invite count the wrong tries.
var OPEN = { login: login_, questions: questions_, recover: recover_, register: register_, join: join_ };
// Actions for a signed-in device, or for the secret while there's no login.
var SIGNED = {
  ping: ping_, sync: sync_, devices: devices_, signOut: signOut_, logout: logout_,
  changePassword: changePassword_, newRecovery: newRecovery_, dataStatus: dataStatus_, dataRefresh: dataRefresh_,
  members: members_, invite: invite_, cancelInvites: cancelInvites_, removeMember: removeMember_
};

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!body || typeof body !== 'object') body = {};
    var action = String(body.action || 'sync');
    if (action === 'hello') return out_(hello_());
    var secret = secret_();
    if (!secret && !anyone_(accounts_())) {
      return out_({ ok: false, app: APP, setup: true,
                    error: 'The script has no SECRET yet. In Apps Script, open Project Settings -> Script properties and add ' +
                           'SECRET with a random value of at least ' + MIN_SECRET + ' characters.' });
    }
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);          // two devices may sync at the same moment
    try {
      var accts = accounts_();
      if (OPEN.hasOwnProperty(action)) return out_(OPEN[action](body, accts, secret));
      var who = auth_(body, accts, secret);
      if (who.refuse) return out_(who.refuse);
      if (!SIGNED.hasOwnProperty(action)) return out_({ ok: false, app: APP, error: 'Unknown action: ' + action });
      return out_(SIGNED[action](body, who, who.user ? accts[who.user] : null));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return out_({ ok: false, app: APP, error: String((err && err.message) || err) });
  }
}

/** For a device that has only the URL: which way in to offer. Says nothing private. */
function hello_() {
  var any = anyone_(accounts_());
  return { ok: true, app: APP, version: VERSION, account: any, setup: !secret_() && !any };
}

/**
 * Who is asking. With a login, a device must carry a session this script
 * handed out; the secret alone no longer opens the data. Without one, the
 * secret does, as before v3, and the data is the owner's.
 *
 * who.member is whose records this device reads and writes: '' for the
 * owner (whose records keep the keys they had before v4), else the member's name.
 */
function auth_(body, accts, secret) {
  var tok = typeof body.session === 'string' ? body.session : '';
  if (anyone_(accts)) {
    if (!tok) return { refuse: { ok: false, app: APP, login: true, error: 'This Sheet has a login. Sign in on this device.' } };
    var all = sessions_(), h = hash_(tok), rec = all[h], now = Date.now();
    var acct = rec && accts[rec.u || ownerName_(accts)];
    if (!rec || !acct || now - rec.s > IDLE_DAYS * DAY) {
      if (rec) { delete all[h]; saveSessions_(all); }
      return { refuse: { ok: false, app: APP, signedOut: true, error: 'This device was signed out. Sign in again.' } };
    }
    if (now - rec.s > 6 * HOUR || !rec.u) { rec.s = now; rec.u = acct.user; saveSessions_(all); }
    return { session: h, user: acct.user, role: acct.role, member: memberKey_(acct) };
  }
  if (tok && body.secret !== secret) {
    return { refuse: { ok: false, app: APP, noAccount: true, error: 'The login on this Sheet was removed. Connect this device again with the secret.' } };
  }
  if (typeof body.secret !== 'string' || !secret || body.secret !== secret) {
    return { refuse: { ok: false, app: APP, badSecret: true, error: "The secret doesn't match the SECRET script property." } };
  }
  return { session: null, user: null, role: 'owner', member: '' };
}

/** Run fn holding the script lock. Menu items use this; doPost already holds it. */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function ping_(body, who) {
  var any = anyone_(accounts_());
  return { ok: true, app: APP, version: VERSION, epoch: epoch_(), now: Date.now(),
           account: any, user: who && who.user || null, role: who && who.user ? who.role : null };
}

/* ============================== the login ============================== */

/*
 * The site turns a name and password into two keys (PBKDF2, 600,000 rounds,
 * then HKDF). One unlocks the data on the device and never leaves it. The
 * other, the "auth" proof, is sent here, and only its SHA-256 is stored, so
 * these properties can't be used to sign in. The recovery proof is made the
 * same way from the 3 answers plus the recovery code.
 *
 * PROFILES (v4): the first login is the Sheet's owner. The owner invites family
 * members; each has their own name, password, questions and recovery code, and
 * their own investments, plan and benchmark choices. A member's devices see
 * only that member's data. The owner sees everyone's in this Sheet's tabs.
 * Each login is one script property, acct:<name>; v3's single `account`
 * becomes the owner's the first time v4 reads it.
 */
var MAX_PROFILES = 8;
var MAX_SESSIONS = 40, MAX_PER_PERSON = 12;
var INVITE_DAYS = 7;
var NAME_BAD = /[|\u0000-\u001f]/;

function accounts_() {
  var p = props_(), all = {};
  var old = p.getProperty('account');                 // v3: the one login, now the owner's
  if (old) {
    try { var a = JSON.parse(old); if (a && a.user && a.auth) { a.role = 'owner'; p.setProperty('acct:' + a.user, JSON.stringify(a)); } } catch (e) { /* unreadable */ }
    p.deleteProperty('account');
  }
  keys_(p).forEach(function (k) {
    if (k.indexOf('acct:') !== 0) return;
    try { var a2 = JSON.parse(p.getProperty(k)); if (a2 && a2.user && a2.auth) all[a2.user] = a2; } catch (e) { /* unreadable */ }
  });
  return all;
}
function keys_(p) { return typeof p.getKeys === 'function' ? p.getKeys() : Object.keys(p.getProperties()); }
function saveAccount_(a) { props_().setProperty('acct:' + a.user, JSON.stringify(a)); }
function anyone_(accts) { return Object.keys(accts).length > 0; }
function ownerName_(accts) {
  var names = Object.keys(accts);
  for (var i = 0; i < names.length; i++) if (accts[names[i]].role === 'owner') return names[i];
  return names[0] || '';
}
function memberKey_(acct) { return acct.role === 'owner' ? '' : acct.user; }

/** Names are compared the way the site makes its keys: trimmed, lower case, single spaces. */
function normUser_(u) {
  var s = String(u == null ? '' : u).trim().toLowerCase().replace(/\s+/g, ' ');
  return s.length >= 3 && s.length <= 40 && !NAME_BAD.test(s) ? s : '';
}

function hex_(bytes) {
  return bytes.map(function (b) { return ((b + 256) % 256).toString(16); })
    .map(function (x) { return x.length < 2 ? '0' + x : x; }).join('');
}
function hash_(s) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)); }

/** Compares two hashes without stopping at the first difference. */
function same_(a, b) {
  a = String(a); b = String(b);
  var d = a.length ^ b.length;
  for (var i = 0; i < Math.min(a.length, b.length); i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function proofOk_(p, stored) { return typeof p === 'string' && PROOF_RE.test(p) && !!stored && same_(hash_(p), stored); }

function questionsOf_(q) {
  if (!Array.isArray(q) || q.length !== 3) return null;
  var out = q.map(function (x) { return String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, 150); });
  if (out.some(function (x) { return x.length < 5; })) return null;
  if (out[0] === out[1] || out[1] === out[2] || out[0] === out[2]) return null;
  return out;
}

/* Sessions: { sha256(token): { u: name, n: device, c: created, s: last seen } }. */
function sessions_() {
  try { return JSON.parse(props_().getProperty('sessions') || '{}') || {}; } catch (e) { return {}; }
}
function saveSessions_(all) { props_().setProperty('sessions', JSON.stringify(all)); }

/** A new session for this person's device: a random token it keeps, and its hash kept here. */
function newSession_(user, device) {
  var all = sessions_(), now = Date.now();
  var tok = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  Object.keys(all).forEach(function (h) { if (now - all[h].s > IDLE_DAYS * DAY) delete all[h]; });
  var byAge = function (list) { return list.sort(function (a, b) { return all[a].s - all[b].s; }); };
  var mine = byAge(Object.keys(all).filter(function (h) { return all[h].u === user; }));
  while (mine.length >= MAX_PER_PERSON) delete all[mine.shift()];
  var every = byAge(Object.keys(all));
  while (every.length >= MAX_SESSIONS) delete all[every.shift()];
  all[hash_(tok)] = { u: user, n: String(device || 'A device').replace(/[\u0000-\u001f]/g, '').slice(0, 40), c: now, s: now };
  saveSessions_(all);
  return tok;
}
function sessionsOf_(all, user, accts) {
  var owner = ownerName_(accts);
  return Object.keys(all).filter(function (h) { return (all[h].u || owner) === user; });
}

/*
 * Wrong tries: after too many, that way in pauses, for longer each time.
 * Counted per name, so one person's typos never lock out another; names that
 * don't exist share one count.
 */
function guard_() {
  try { return JSON.parse(props_().getProperty('guard') || '{}') || {}; } catch (e) { return {}; }
}
function guardKey_(kind, user, accts) { return kind + ':' + (user && accts && accts[user] ? user : '?'); }
function guardWait_(key) {
  var g = guard_()[key];
  return g && g.until > Date.now() ? Math.ceil((g.until - Date.now()) / 1000) : 0;
}
function guardFail_(key, tries, baseMinutes) {
  var all = guard_(), g = all[key] || { n: 0, until: 0 }, now = Date.now();
  g.n++;
  if (g.n >= tries) g.until = now + Math.min(DAY, baseMinutes * MINUTE * Math.pow(2, g.n - tries));
  all[key] = g;
  Object.keys(all).forEach(function (k) { if (all[k].n < 1 || (all[k].until && now - all[k].until > DAY)) delete all[k]; });
  props_().setProperty('guard', JSON.stringify(all));
  return { left: Math.max(0, tries - g.n), wait: g.until > now ? Math.ceil((g.until - now) / 1000) : 0 };
}
function guardClear_(key) {
  var all = guard_();
  if (all[key]) { delete all[key]; props_().setProperty('guard', JSON.stringify(all)); }
}
function waitText_(sec) {
  var m = Math.ceil(sec / 60);
  return m >= 90 ? Math.round(m / 60) + ' hours' : m + (m === 1 ? ' minute' : ' minutes');
}
function signedIn_(acct, tok, extra) {
  var out = { ok: true, app: APP, version: VERSION, session: tok, user: acct.user, role: acct.role, epoch: epoch_(), now: Date.now() };
  for (var k in extra || {}) out[k] = extra[k];
  return out;
}
function tooMany_(kind, g) {
  var what = kind === 'recover' ? 'tries' : kind === 'join' ? 'invite codes' : 'passwords';
  return 'Too many wrong ' + what + '. Try again in ' + waitText_(g) + '.';
}

/** Make the first login, the owner's. Needs the secret, and only while there's no login yet. */
function register_(body, accts, secret) {
  if (anyone_(accts)) return { ok: false, app: APP, hasAccount: true, error: 'This Sheet already has a login. Sign in with it, or ask its owner for an invite.' };
  if (!secret || body.secret !== secret) return { ok: false, app: APP, badSecret: true, error: "The secret doesn't match the SECRET script property." };
  if (kept_(accts)[normUser_(body.user)]) return { ok: false, app: APP, error: KEPT_NAME };
  var made = newAccount_(body, 'owner');
  if (made.error) return { ok: false, app: APP, error: made.error };
  saveSessions_({});
  props_().deleteProperty('guard');
  return signedIn_(made.acct, newSession_(made.acct.user, body.device));
}

/** A family member joins with the owner's one-time invite. */
function join_(body, accts) {
  if (!anyone_(accts)) return { ok: false, app: APP, noAccount: true, error: 'This Sheet has no login yet.' };
  var wait = guardWait_('join:?');
  if (wait) return { ok: false, app: APP, wait: wait, error: tooMany_('join', wait) };
  var all = invites_(), h = hash_(normCode_(body.invite)), inv = all[h];
  if (!inv || inv.exp < Date.now()) {
    var g = guardFail_('join:?', LOGIN_TRIES, 15);
    return { ok: false, app: APP, badInvite: true, left: g.left, wait: g.wait,
             error: inv ? 'That invite has expired. Ask for a new one.' : "That invite code isn't right, or it was already used." };
  }
  var user = normUser_(body.user);
  if (inv.user && user !== inv.user) return { ok: false, app: APP, error: 'This invite is for ' + inv.user + '. Join with that name.' };
  if (user && accts[user]) return { ok: false, app: APP, error: 'Someone on this Sheet already has that name. Choose another.' };
  if (user && !inv.user && kept_(accts)[user]) return { ok: false, app: APP, error: KEPT_NAME };
  if (Object.keys(accts).length >= MAX_PROFILES) return { ok: false, app: APP, error: 'This Sheet has ' + MAX_PROFILES + ' people already, the most it holds.' };
  var made = newAccount_(body, 'member');
  if (made.error) return { ok: false, app: APP, error: made.error };
  delete all[h];
  saveInvites_(all);
  guardClear_('join:?');
  return signedIn_(made.acct, newSession_(made.acct.user, body.device));
}

function newAccount_(body, role) {
  var user = normUser_(body.user), q = questionsOf_(body.questions);
  if (!user) return { error: 'Choose a name of 3 to 40 characters.' };
  if (!q) return { error: 'Choose 3 different security questions.' };
  if (!PROOF_RE.test(String(body.auth)) || !PROOF_RE.test(String(body.rec))) return { error: 'The login details were incomplete. Try again.' };
  var now = Date.now();
  var acct = { user: user, role: role, auth: hash_(body.auth), rec: hash_(body.rec), q: q, created: now, changed: now };
  saveAccount_(acct);
  return { acct: acct };
}

function login_(body, accts) {
  if (!anyone_(accts)) return { ok: false, app: APP, noAccount: true, error: 'This Sheet has no login yet.' };
  var user = normUser_(body.user), acct = accts[user], key = guardKey_('login', user, accts);
  var wait = guardWait_(key);
  if (wait) return { ok: false, app: APP, wait: wait, error: tooMany_('login', wait) };
  if (!acct || !proofOk_(body.auth, acct.auth)) {
    var g = guardFail_(key, LOGIN_TRIES, 15);
    return { ok: false, app: APP, badLogin: true, left: g.left, wait: g.wait,
             error: g.wait ? 'Wrong name or password. Too many tries: try again in ' + waitText_(g.wait) + '.'
                           : 'Wrong name or password.' + (g.left <= 2 ? ' ' + g.left + ' more ' + (g.left === 1 ? 'try' : 'tries') + ' before logins pause.' : '') };
  }
  guardClear_(key);
  return signedIn_(acct, newSession_(acct.user, body.device));
}

/** The 3 questions, so the site can ask them. The answers are never stored, only the recovery proof. */
function questions_(body, accts) {
  if (!anyone_(accts)) return { ok: false, app: APP, noAccount: true, error: 'This Sheet has no login yet.' };
  var acct = accts[normUser_(body.user)];
  if (!acct) return { ok: false, app: APP, error: "There's no login with that name on this Sheet." };
  return { ok: true, app: APP, questions: acct.q };
}

/**
 * Forgot the password: the 3 answers plus the recovery code make a proof that
 * matches the stored one. It sets a new password and a new recovery code (the
 * old code is used up), and signs out that person's other devices.
 */
function recover_(body, accts) {
  if (!anyone_(accts)) return { ok: false, app: APP, noAccount: true, error: 'This Sheet has no login yet.' };
  var user = normUser_(body.user), acct = accts[user], key = guardKey_('recover', user, accts);
  var wait = guardWait_(key);
  if (wait) return { ok: false, app: APP, wait: wait, error: tooMany_('recover', wait) };
  if (!acct || !proofOk_(body.rec, acct.rec)) {
    var g = guardFail_(key, RECOVER_TRIES, 60);
    return { ok: false, app: APP, badRecovery: true, left: g.left, wait: g.wait,
             error: "Those answers and recovery code don't match." + (g.wait ? ' Try again in ' + waitText_(g.wait) + '.' : '') };
  }
  if (!PROOF_RE.test(String(body.newAuth)) || !PROOF_RE.test(String(body.newRec))) return { ok: false, app: APP, error: 'The new login details were incomplete. Try again.' };
  acct.auth = hash_(body.newAuth); acct.rec = hash_(body.newRec); acct.changed = Date.now();
  saveAccount_(acct);
  dropSessions_(acct.user, accts);
  guardClear_(key); guardClear_(guardKey_('login', user, accts));
  return signedIn_(acct, newSession_(acct.user, body.device));
}

/** Sign out every device of one person. */
function dropSessions_(user, accts) {
  var all = sessions_();
  sessionsOf_(all, user, accts).forEach(function (h) { delete all[h]; });
  saveSessions_(all);
}

/** This person's devices. */
function devices_(body, who) {
  var all = sessions_(), accts = accounts_();
  var list = who.user ? sessionsOf_(all, who.user, accts).map(function (h) {
    return { id: h.slice(0, 12), name: all[h].n, created: all[h].c, seen: all[h].s, current: h === who.session };
  }).sort(function (a, b) { return b.current - a.current || b.seen - a.seen; }) : [];
  return { ok: true, app: APP, devices: list };
}

/** Sign out this person's other devices, or one of them by id. */
function signOut_(body, who) {
  if (!who.session) return { ok: false, app: APP, error: 'This Sheet has no login yet.' };
  var all = sessions_(), n = 0;
  sessionsOf_(all, who.user, accounts_()).forEach(function (h) {
    if (h === who.session) return;
    if (body.which === 'others' || (typeof body.which === 'string' && body.which.length >= 8 && h.indexOf(body.which) === 0)) { delete all[h]; n++; }
  });
  saveSessions_(all);
  var out = devices_(body, who);
  out.signedOut = n;
  return out;
}

function logout_(body, who) {
  if (who.session) { var all = sessions_(); delete all[who.session]; saveSessions_(all); }
  return { ok: true, app: APP };
}

/** Check the current password before a change; counts wrong tries like a login. */
function checkPassword_(body, who, acct) {
  if (!acct || !who.session) return { ok: false, app: APP, error: 'This Sheet has no login yet.' };
  var key = guardKey_('login', acct.user, accounts_()), wait = guardWait_(key);
  if (wait) return { ok: false, app: APP, wait: wait, error: tooMany_('login', wait) };
  if (!proofOk_(body.auth, acct.auth)) {
    var g = guardFail_(key, LOGIN_TRIES, 15);
    return { ok: false, app: APP, badLogin: true, left: g.left, wait: g.wait, error: "That isn't your current password." };
  }
  guardClear_(key);
  return null;
}

/** A new password, given the current one. Other devices stay signed in unless asked. */
function changePassword_(body, who, acct) {
  var bad = checkPassword_(body, who, acct);
  if (bad) return bad;
  if (!PROOF_RE.test(String(body.newAuth))) return { ok: false, app: APP, error: 'The new password details were incomplete. Try again.' };
  acct.auth = hash_(body.newAuth); acct.changed = Date.now();
  saveAccount_(acct);
  if (body.others) signOut_({ which: 'others' }, who);
  return { ok: true, app: APP };
}

/** New security questions and a new recovery code, given the password. */
function newRecovery_(body, who, acct) {
  var bad = checkPassword_(body, who, acct);
  if (bad) return bad;
  var q = questionsOf_(body.questions);
  if (!q) return { ok: false, app: APP, error: 'Choose 3 different security questions.' };
  if (!PROOF_RE.test(String(body.rec))) return { ok: false, app: APP, error: 'The recovery details were incomplete. Try again.' };
  acct.q = q; acct.rec = hash_(body.rec); acct.changed = Date.now();
  saveAccount_(acct);
  return { ok: true, app: APP };
}

/* ---------- family members (the owner's) ---------- */

function invites_() {
  var all;
  try { all = JSON.parse(props_().getProperty('invites') || '{}') || {}; } catch (e) { all = {}; }
  var now = Date.now();
  Object.keys(all).forEach(function (h) { if (all[h].exp < now) delete all[h]; });
  return all;
}
function saveInvites_(all) { props_().setProperty('invites', JSON.stringify(all)); }
var CODE_ABC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';          // Crockford's base 32, as the site's recovery codes
function normCode_(c) { return String(c || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, ''); }

/**
 * Names whose investments are kept here with no login: members removed without
 * erasing, or everyone after "Remove the login". Only an invite made for that
 * name can take one, so nobody else joins into someone's kept data.
 */
function kept_(accts) {
  var out = {};
  if (!book_().getSheetByName(DATA)) return out;
  var t = readTable_();
  for (var i = 0; i < t.rows.length; i++) { var m = t.rows[i].m; if (m && !accts[m] && !t.rows[i].del) out[m] = true; }
  return out;
}
var KEPT_NAME = "Someone's investments are kept in this Sheet under that name. Choose another, or ask the owner for an invite with that name.";

function ownerOnly_(who) {
  return who.role === 'owner' && who.session ? null
    : { ok: false, app: APP, notOwner: true, error: who.session ? 'Only the Sheet\'s owner can do this.' : 'Make a login first.' };
}

/** Everyone on this Sheet, their devices, and the invites still open. */
function members_(body, who) {
  var no = ownerOnly_(who);
  if (no) return no;
  var accts = accounts_(), all = sessions_(), inv = invites_();
  var list = Object.keys(accts).map(function (u) {
    var mine = sessionsOf_(all, u, accts);
    return { user: u, role: accts[u].role, created: accts[u].created, devices: mine.length,
             seen: mine.reduce(function (m, h) { return Math.max(m, all[h].s); }, 0), you: u === who.user };
  }).sort(function (a, b) { return (a.role === 'owner' ? 0 : 1) - (b.role === 'owner' ? 0 : 1) || a.user.localeCompare(b.user); });
  return { ok: true, app: APP, members: list, kept: Object.keys(kept_(accts)).sort(),
           invites: Object.keys(inv).map(function (h) { return { exp: inv[h].exp, user: inv[h].user || '' }; }), max: MAX_PROFILES };
}

/**
 * A one-time invite for a family member, good for INVITE_DAYS. Only its hash is
 * kept. With body.user it is for that name alone: the way to give someone back
 * the investments kept under their name.
 */
function invite_(body, who) {
  var no = ownerOnly_(who);
  if (no) return no;
  var accts = accounts_(), forUser = '';
  if (Object.keys(accts).length >= MAX_PROFILES) return { ok: false, app: APP, error: 'This Sheet has ' + MAX_PROFILES + ' people already, the most it holds.' };
  if (body.user) {
    forUser = normUser_(body.user);
    if (!forUser) return { ok: false, app: APP, error: 'Use a name of 3 to 40 characters.' };
    if (accts[forUser]) return { ok: false, app: APP, error: forUser + ' is already on this Sheet.' };
  }
  var all = invites_();
  var keys = Object.keys(all).sort(function (a, b) { return all[a].exp - all[b].exp; });
  while (keys.length >= 5) delete all[keys.shift()];
  var hex = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''), code = '';
  for (var i = 0; code.length < 10; i += 2) code += CODE_ABC.charAt(parseInt(hex.substr(i, 2), 16) & 31);
  var exp = Date.now() + INVITE_DAYS * DAY;
  all[hash_(code)] = forUser ? { exp: exp, by: who.user, user: forUser } : { exp: exp, by: who.user };
  saveInvites_(all);
  return { ok: true, app: APP, code: code.slice(0, 5) + '-' + code.slice(5), exp: exp, user: forUser };
}

/** Withdraw every invite nobody has used yet. */
function cancelInvites_(body, who) {
  var no = ownerOnly_(who);
  if (no) return no;
  saveInvites_({});
  return members_(body, who);
}

/** Remove a member's login and sign out their devices; their data stays unless erase is set. */
function removeMember_(body, who) {
  var no = ownerOnly_(who);
  if (no) return no;
  var accts = accounts_(), user = normUser_(body.user), acct = accts[user];
  if (!acct && body.erase && user && kept_(accts)[user]) {         // someone already removed: erase what's kept
    eraseMember_(user);
    var gone = members_(body, who);
    gone.removed = user;
    return gone;
  }
  if (!acct) return { ok: false, app: APP, error: "There's no one called " + (user || 'that') + ' on this Sheet.' };
  if (acct.role === 'owner') return { ok: false, app: APP, error: "The owner can't be removed. Use the Sheet's SIPs menu to remove every login." };
  dropSessions_(user, accts);
  props_().deleteProperty('acct:' + user);
  if (body.erase) eraseMember_(user);
  var out = members_(body, who);
  out.removed = user;
  return out;
}

/** Take one member's records out of the data tab (the owner asked to erase them). */
function eraseMember_(user) {
  var t = readTable_(), keep = t.rows.filter(function (r) { return r.m !== user; });
  if (keep.length === t.rows.length) return;
  var sh = t.sh, last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, WIDTH).clearContent();
  keep.forEach(function (r, i) { r.r = i + 2; });
  if (keep.length) writeRows_(sh, 2, keep.map(row_));
  refreshViews_(readTable_());
}

/* ============================== fund data (GitHub) ============================== */

function ghToken_() { return String(props_().getProperty('GITHUB_TOKEN') || '').trim(); }

/** The repository: GITHUB_REPO if set, else the one the site said it's served from (kept for the daily check). */
function repo_(body) {
  var p = props_(), set = String(p.getProperty('GITHUB_REPO') || '').trim();
  if (REPO_RE.test(set)) return set;
  var asked = String((body && body.repo) || ''), kept = String(p.getProperty('repo') || '');
  if (REPO_RE.test(asked)) { if (asked !== kept) p.setProperty('repo', asked); return asked; }
  return REPO_RE.test(kept) ? kept : '';
}

function github_(method, path, payload) {
  var opt = {
    method: method, muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ghToken_(), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  };
  if (payload) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(payload); }
  var r = UrlFetchApp.fetch('https://api.github.com' + path, opt);
  var text = r.getContentText(), json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  return { code: r.getResponseCode(), json: json };
}

function ghError_(r, repo) {
  if (r.code === 401) return 'GitHub refused the token. It may have expired: make a new one and paste it into the GITHUB_TOKEN script property.';
  if (r.code === 403) return "The token isn't allowed to do this. It needs Actions: Read and write on " + repo + '.';
  if (r.code === 404) return "GitHub couldn't find " + repo + ' or its ' + WORKFLOW + '. Check GITHUB_REPO, and that the token can see this repository.';
  if (r.code === 422) return 'GitHub refused to start the workflow: ' + ((r.json && r.json.message) || 'check its branch') + '.';
  return 'GitHub answered with an error (' + r.code + '). Try again later.';
}

function runOf_(x) {
  return { status: x.status, conclusion: x.conclusion || null, event: x.event, created: Date.parse(x.created_at) || 0,
           updated: Date.parse(x.updated_at) || 0, url: x.html_url };
}

/** The nightly workflow: on or paused, its latest run, and when it last succeeded. */
function nightly_(body) {
  if (!ghToken_()) return { configured: false };
  var repo = repo_(body);
  if (!repo) return { configured: true, error: 'Add the script property GITHUB_REPO with your repository as owner/name, e.g. customapplication/wealth-calculator. (Update now on the site also fills it in.)' };
  var base = '/repos/' + repo + '/actions/workflows/' + WORKFLOW;
  var w = github_('get', base);
  if (w.code !== 200) return { configured: true, repo: repo, error: ghError_(w, repo) };
  var rs = github_('get', base + '/runs?per_page=10');
  if (rs.code !== 200) return { configured: true, repo: repo, error: ghError_(rs, repo) };
  var runs = ((rs.json && rs.json.workflow_runs) || []).map(runOf_), lastOk = null;
  for (var i = 0; i < runs.length && !lastOk; i++) if (runs[i].conclusion === 'success') lastOk = runs[i].updated;
  var watch = null;
  try { watch = JSON.parse(props_().getProperty('watch') || 'null'); } catch (e) { /* none yet */ }
  return { configured: true, repo: repo, state: w.json && w.json.state, run: runs[0] || null, lastOk: lastOk, watch: watch,
           checking: dailyCheckOn_() };
}

/** Switch the workflow back on if GitHub paused it, then start a run unless one is going or just went. */
function startNightly_(st, force) {
  var base = '/repos/' + st.repo + '/actions/workflows/' + WORKFLOW, enabled = false;
  if (st.state !== 'active' && (force || st.state === 'disabled_inactivity')) {
    var e = github_('put', base + '/enable');
    if (e.code !== 204) return { started: false, reason: 'error', error: ghError_(e, st.repo) };
    enabled = true;
  }
  if (st.state === 'disabled_manually' && !force) return { started: false, reason: 'off' };
  var run = st.run, now = Date.now();
  if (run && run.status !== 'completed') return { started: false, enabled: enabled, reason: 'running' };
  if (run && now - run.created < 10 * MINUTE) return { started: false, enabled: enabled, reason: 'recent' };
  var d = github_('post', base + '/dispatches', { ref: String(props_().getProperty('GITHUB_BRANCH') || 'main') });
  if (d.code !== 204) return { started: false, enabled: enabled, reason: 'error', error: ghError_(d, st.repo) };
  return { started: true, enabled: enabled };
}

function dataStatus_(body) {
  return { ok: true, app: APP, github: nightly_(body) };
}

/** The site's "Update now" button. */
function dataRefresh_(body) {
  var st = nightly_(body);
  if (!st.configured) return { ok: false, app: APP, github: st, error: 'Add a GITHUB_TOKEN script property to update the fund data from here.' };
  if (st.error) return { ok: false, app: APP, github: st, error: st.error };
  var r = startNightly_(st, true);
  if (r.error) return { ok: false, app: APP, github: st, error: r.error };
  return { ok: true, app: APP, github: st, started: r.started, enabled: r.enabled, reason: r.reason || null };
}

/**
 * The daily check (SIPs -> Keep the nightly data update running): switches the
 * workflow back on if GitHub paused it for inactivity, and starts a run when
 * the last good one is more than 26 hours old. A workflow you turned off by
 * hand on GitHub is left off.
 */
function checkNightly() {
  var st = nightly_({}), did;
  if (!st.configured) did = 'Nothing to do: add a GITHUB_TOKEN script property first.';
  else if (st.error) did = st.error;
  else if (st.state === 'disabled_manually') did = 'The workflow was turned off on GitHub by hand, so it was left off.';
  else {
    var stale = !st.lastOk || Date.now() - st.lastOk > 26 * HOUR;
    if (st.state !== 'active' || stale) {
      var r = stale ? startNightly_(st, false) : { started: false, enabled: false };
      if (!stale) {
        var e = github_('put', '/repos/' + st.repo + '/actions/workflows/' + WORKFLOW + '/enable');
        r.enabled = e.code === 204;
        if (!r.enabled) r.error = ghError_(e, st.repo);
      }
      did = r.error || [r.enabled ? 'Switched the paused workflow back on.' : '',
                        r.started ? 'Started a data update.' : stale ? (r.reason === 'running' ? 'An update was already running.' : 'An update started a few minutes ago.') : ''].join(' ').trim();
    } else did = 'All well: the last update finished ' + stamp_(st.lastOk) + '.';
  }
  props_().setProperty('watch', JSON.stringify({ at: Date.now(), did: did }));
  Logger.log('Nightly check: ' + did);
  return did;
}

function dailyCheckOn_() {
  try { return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'checkNightly'; }); }
  catch (e) { return null; }
}

function KEEP_NIGHTLY() {
  if (!dailyCheckOn_()) ScriptApp.newTrigger('checkNightly').timeBased().everyDays(1).atHour(5).create();
  tellOwner_('The nightly data update is checked every morning around 5 am. ' + checkNightly());
}
function CHECK_NIGHTLY_NOW() { tellOwner_(checkNightly()); }
function STOP_NIGHTLY_CHECK() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'checkNightly') ScriptApp.deleteTrigger(t); });
  tellOwner_('The daily check is off. The site\'s Update now button still works.');
}

/* The owner's way out, from the Sheet itself (Google has already checked it's you). */
function SIGN_OUT_EVERY_DEVICE() {
  withLock_(function () { saveSessions_({}); });
  tellOwner_("Every device, everyone's, is signed out. Each one asks for its person's name and password at its next sync.");
}
function REMOVE_LOGIN() {
  try {
    var ui = SpreadsheetApp.getUi();
    if (ui.alert('Remove every login?', "Everyone's login goes, the owner's too. Devices will need the SECRET again to connect, and you can make a new login on the site. Everyone's data stays in this Sheet.", ui.ButtonSet.YES_NO) !== ui.Button.YES) return false;
  } catch (e) { /* run from the editor: running it is the confirmation */ }
  withLock_(function () {
    var p = props_();
    keys_(p).forEach(function (k) { if (k.indexOf('acct:') === 0) p.deleteProperty(k); });
    ['account', 'sessions', 'guard', 'invites'].forEach(function (k) { p.deleteProperty(k); });
  });
  tellOwner_("Every login is removed. Connect a device with the URL and the SECRET, then make a new login on the site. Family members' data stays in this Sheet: on the site, Security -> Family -> Invite again next to each name gives it back.");
  return true;
}

/* ============================== the sync ============================== */

/**
 * One round trip: store what the device changed, then hand back everything it
 * hasn't seen.
 *
 * Request  { epoch, since, changes: [{ c, id, at, del, data }] }
 * Response { ok, epoch, resync, cursor, changes: [...], rejected: [...], refused: [...], now }
 *
 * The Sheet's own address is never sent: family members sign in to the site,
 * and only the Sheet's owner opens the Sheet.
 *
 * A change is kept only if its `at` is newer than the stored one. Otherwise the
 * stored record goes back in `rejected`, so the device replaces its copy and
 * every device ends up with the same data even when their clocks disagree.
 * `epoch` changes only when the data is erased; a device that sees a new epoch
 * gets everything (resync) and sends back what it holds.
 */
function sync_(body, who) {
  var t = readTable_(), mine = (who && who.member) || '';
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
    var key = keyOf_(mine, c, id), cur = t.byKey[key];
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
    var rec = cur || { key: key, c: c, id: id, m: mine };
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
    if (r.rev > since && PULLED[r.c] && r.m === mine) { var doc = doc_(r); if (doc) res.changes.push(doc); }
  }
  res.cursor = rev;
  res.now = Date.now();
  return res;
}

/*
 * Whose records: the owner's keep the keys they always had ("holdings/abc");
 * a member's start with their name ("@asha|holdings/abc"). A device reads and
 * writes only its own person's.
 */
function keyOf_(member, c, id) { return (member ? '@' + member + '|' : '') + c + '/' + id; }
function memberOf_(key) { return key.charAt(0) === '@' && key.indexOf('|') > 1 ? key.slice(1, key.indexOf('|')) : ''; }

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
                  del: String(v[4]) === '1', rev: Number(v[5]) || 0, cells: v.slice(META_COLS.length), m: memberOf_(key) };
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

/*
 * With family members, every tab starts with a Member column (the owner
 * first), the Plan tab has a column per person, and the Portfolio tab adds a
 * family total. With only the owner, the tabs look as they did before v4.
 */
function refreshViews_(t) {
  t = t || readTable_();
  var accts = accounts_(), owner = ownerName_(accts);
  var people = {};                                   // member key -> { name, holdings, settings, snapshot }
  var person = function (m) {
    if (!people[m]) people[m] = { name: m || owner || 'You', holdings: [], settings: {}, snapshot: null };
    return people[m];
  };
  person('');
  Object.keys(accts).forEach(function (u) { if (accts[u].role !== 'owner') person(u); });
  for (var i = 0; i < t.rows.length; i++) {
    var rec = t.rows[i];
    if (rec.del) continue;
    var d = recData_(rec);
    if (d === undefined || d === null) continue;
    var live = person(rec.m);
    if (rec.c === 'holdings') live.holdings.push({ at: rec.at, h: d });
    else if (rec.c === 'settings') live.settings[rec.id] = { at: rec.at, d: d };
    else if (rec.c === 'snapshot' && rec.id === 'latest') live.snapshot = { at: rec.at, d: d };
  }
  var list = Object.keys(people).sort(function (a, b) { return (a ? 1 : 0) - (b ? 1 : 0) || a.localeCompare(b); }).map(function (m) { return people[m]; });
  list.forEach(function (p) {
    p.holdings.sort(function (a, b) {
      return kindOrder_(a.h.kind) - kindOrder_(b.h.kind) || String(a.h.name || '').localeCompare(String(b.h.name || ''));
    });
  });
  var family = list.length > 1;
  portfolioTab_(list, family);
  investmentsTab_(list, family);
  transactionsTab_(list, family);
  planTab_(list, family);
}

/** With family members, each row starts with its person's name. */
function who_(family, p, row) { return family ? [text_(p.name)].concat(row) : row; }
function whoHead_(family, headers) { return family ? ['Member'].concat(headers) : headers; }
function whoFmt_(family, formats) { return formats && family ? ['@'].concat(formats) : formats; }

function kindOrder_(k) { return k === 'sip' ? 0 : k === 'lump' ? 1 : 2; }

function portfolioTab_(list, family) {
  var headers = whoHead_(family, ['Investment', 'Kind', 'Units', 'Put in, net (₹)', 'Worth (₹)', 'Gain (₹)', 'XIRR', 'NAV date', 'Note']);
  var w = headers.length, rows = [], notes = [], sum = { net: 0, value: 0, gain: 0, n: 0 };
  list.forEach(function (p) {
    var latest = p.snapshot, snap = latest && latest.d;
    if (!snap) {
      if (!family) { rows.push(pad_(['Open the site to value your investments here.'], w)); return; }
      rows.push(pad_(who_(family, p, ["Not valued yet: it's valued here when this person opens the site."]), w));
      return;
    }
    var own = [];
    (snap.rows || []).forEach(function (r) {
      own.push(who_(family, p, r.error
        ? [text_(r.name), KIND[r.kind] || '', '', '', '', '', '', '', text_(r.error)]
        : [text_(r.name), KIND[r.kind] || '', num_(r.units), num_(r.net), num_(r.value), num_(r.gain), num_(r.xirr), day_(r.navDate), '']));
    });
    var tot = snap.totals;
    if (tot && own.length) {
      own.push(who_(family, p, [family ? 'Total for ' + text_(p.name) : 'Total', '', '', num_(tot.net), num_(tot.value), num_(tot.gain), num_(tot.xirr), day_(snap.navDate), '']));
      ['net', 'value', 'gain'].forEach(function (k) { sum[k] += Number(tot[k]) || 0; });
      sum.n++;
    }
    if (!own.length) own.push(pad_(who_(family, p, ['No investments yet.']), w));
    rows = rows.concat(own);
    notes.push((family ? text_(p.name) + ': valued ' : 'Valued ') + stamp_(latest.at) + (snap.navDate ? ', using NAVs up to ' + snap.navDate : '') + '.');
  });
  // The family's XIRR needs everyone's cash flows, which the tab doesn't have, so it's left blank.
  if (family && sum.n > 1) rows.push(['Family', 'Total', '', '', num_(sum.net), num_(sum.value), num_(sum.gain), '', '', 'XIRR is per person']);
  if (!rows.length) rows.push(pad_(['No investments yet.'], w));
  if (notes.length) {
    rows.push(pad_([''], w));
    notes.forEach(function (n) { rows.push(pad_([n], w)); });
    rows.push(pad_(['The site values a portfolio each time its owner opens it.'], w));
  }
  tab_('Portfolio', headers, rows, notes.length ? whoFmt_(family, ['@', '@', '#,##0.000', '#,##0', '#,##0', '#,##0', '0.00%', 'd mmm yyyy', '@']) : null);
}

function investmentsTab_(list, family) {
  var headers = whoHead_(family, ['Fund', 'Kind', 'Scheme code', 'ISIN', 'Amount (₹)', 'Debit day', 'First SIP', 'Stopped',
                 'Raised every year (%)', 'Date invested', 'Folio', 'Transactions', 'Units in statement', 'Last changed',
                 'Fund house', 'Goal', 'Registrar', 'Distributor', 'Nominees', 'KYC and PAN']);
  var rows = [];
  list.forEach(function (p) { p.holdings.forEach(function (x) { rows.push(who_(family, p, investmentRow_(x))); }); });
  if (!rows.length) rows.push(pad_(['No investments yet. Add them on the site, under Portfolio.'], headers.length));
  tab_('Investments', headers, rows, whoFmt_(family, ['@', '@', '0', '@', '#,##0', '0', 'mmm yyyy', 'mmm yyyy', '0.##', 'd mmm yyyy',
                                      '@', '0', '#,##0.000', 'd mmm yyyy h:mm', '@', '@', '@', '@', '@', '@']));
}

function investmentRow_(x) {
    var h = x.h, sip = h.kind === 'sip', lump = h.kind === 'lump', cas = h.kind === 'cas';
    return [
      text_(h.name), KIND[h.kind] || text_(h.kind), num_(h.code), text_(h.isin),
      sip || lump ? num_(h.amount) : '', sip ? num_(h.day) : '', sip ? month_(h.start) : '', sip ? month_(h.end) : '',
      sip ? num_(h.step) : '', lump ? day_(h.date) : '', cas ? text_(h.folio) : '',
      cas ? (h.txns || []).length : '', cas ? num_(h.closeUnits) : '', new Date(x.at),
      text_(h.amc), text_(h.goal), cas ? text_(h.rta) : '', cas ? text_(h.advisor) : '',
      cas && Array.isArray(h.nominees) ? (h.nominees.length ? text_(h.nominees.join(', ')) : 'None on the statement') : '',
      cas ? text_([h.kyc ? 'KYC ' + h.kyc : '', h.panOk === true ? 'PAN OK' : h.panOk === false ? 'PAN not OK' : ''].filter(String).join(', ')) : ''
    ];
}

function transactionsTab_(list, family) {
  var headers = whoHead_(family, ['Fund', 'Folio', 'Date', 'Type', 'Amount (₹)', 'Units', 'NAV']);
  var rows = [];
  list.forEach(function (p) {
    p.holdings.forEach(function (x) {
      var h = x.h;
      if (h.kind !== 'cas') return;
      (h.txns || []).slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); }).forEach(function (tx) {
        rows.push(who_(family, p, [text_(h.name), text_(h.folio), day_(tx.date), TXN_TYPES[tx.type] || text_(tx.type),
                   num_(tx.amount), num_(tx.units), num_(tx.nav)]));
      });
    });
  });
  if (!rows.length) rows.push(pad_(['Nothing yet. Import your CAS statement on the site to see every transaction here.'], headers.length));
  tab_('Transactions', headers, rows, whoFmt_(family, ['@', '@', 'd mmm yyyy', '@', '#,##0.00', '#,##0.000', '#,##0.0000']));
}

function planTab_(list, family) {
  var plans = list.map(function (p) { return p.settings.plan; });
  var headers = family ? ['Setting'].concat(list.map(function (p) { return text_(p.name); })) : ['Setting', 'Value'];
  var fmts = headers.map(function () { return '@'; });
  var rows = [];
  if (!plans.some(Boolean)) {
    rows.push(pad_(['Nothing yet. Change any input on the Plan page and it appears here.'], headers.length));
    return tab_('Plan', headers, rows, fmts);
  }
  var show = function (k, v) {
    if (PLAN_VALUES[k]) v = PLAN_VALUES[k][v] || v;
    else if (k === 'swpEnabled') v = v ? 'On' : 'Off';
    else if (Array.isArray(v)) v = v.join(', ');
    return typeof v === 'number' ? v : text_(v);
  };
  PLAN_LABELS.forEach(function (pair) {
    var k = pair[0];
    if (!plans.some(function (pl) { return pl && k in pl.d; })) return;
    rows.push([pair[1]].concat(plans.map(function (pl) { return pl && k in pl.d ? show(k, pl.d[k]) : ''; })));
  });
  rows.push(['Last changed'].concat(plans.map(function (pl) { return pl ? stamp_(pl.at) : ''; })));
  tab_('Plan', headers, rows, fmts);
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
