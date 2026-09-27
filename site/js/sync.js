/* Google Sheet sync: keeps the plan and the portfolio in a Google Sheet the
   owner owns, and in step on every device they connect, through their own
   Apps Script web app (sheets/Code.gs). The URL and the secret, or once there's
   a login, this device's session, stay in this browser; nothing about the
   connection is in the site or the repository. */
window.Sync = (() => {
  'use strict';
  const { $, esc, store, emit, fmtDate } = MF;

  const KEY = 'mf-sync:v1';
  const URL_RE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/]+|macros)\/s\/[\w-]+\/exec$/;
  const MIN_SECRET = 16;
  const DEBOUNCE = 1500;          // wait for typing to settle before sending
  const PULL_EVERY = 10 * 60e3;   // look for other devices' changes while the page is open

  let S = load();
  let busy = false, again = false, timer = null, applying = false;

  // hold: 'login' when the Sheet wants this device to sign in, 'secret' when its login was removed.
  function fresh(over) {
    return Object.assign({ url: '', secret: '', session: '', user: '', version: 0, account: false, hold: '', out: false,
      epoch: null, cursor: 0, skew: 0, docs: {}, snap: null, sheetUrl: '', lastOk: 0, lastError: '' }, over);
  }
  function load() { const s = store.json(KEY, null); return fresh(s && typeof s === 'object' ? s : {}); }
  const persist = () => store.set(KEY, JSON.stringify(S));
  const connected = () => !!(S.url && (S.secret || S.session) && !S.hold);
  const cred = () => S.session ? { session: S.session } : { secret: S.secret };

  /* ---------- what gets synced ---------- */

  // JSON with object keys sorted, so the same data always hashes the same.
  const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x))
    ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x);
  function hash(str) {                       // cyrb53: fast, and plenty to tell edits apart
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  const hashOf = data => hash(canon(data));

  /**
   * This device's records as {key: {data, blank}}. `blank` means there is
   * nothing worth sending unless the record was synced before: an untouched
   * plan on a new device must never replace the real one in the Sheet.
   */
  function localDocs(what) {
    const out = {};
    if (what !== 'plan' && window.Portfolio) {
      const P = window.Portfolio.syncGet();
      for (const h of P.holdings) if (h && h.id) out['holdings/' + h.id] = { data: h, blank: false };
      const meta = { casWarnings: P.casWarnings || [], casPeriod: P.casPeriod || null };
      out['settings/portfolio'] = { data: meta, blank: !meta.casWarnings.length && !meta.casPeriod };
    }
    if (what !== 'portfolio' && window.Planner && window.Planner.syncGet) {
      out['settings/plan'] = window.Planner.syncGet();
    }
    if (window.Bench) out['settings/bench'] = window.Bench.syncGet();
    return out;
  }

  /** Stamp a new edit: after every earlier version of it, on the Sheet's clock. */
  const stamp = prev => Math.max(Date.now() + (S.skew || 0), (prev || 0) + 1);

  /**
   * Compare this device's records with what was last synced and mark what
   * changed. `baseline` is the first scan after connecting: what the device
   * already held counts as older than anything edited since (at = 1), so a
   * record already in the Sheet is kept over it.
   */
  function scan(what, baseline) {
    const docs = localDocs(what);
    let changed = false;
    for (const k of Object.keys(docs)) {
      const { data, blank } = docs[k], m = S.docs[k];
      if (!m && blank) continue;
      const h = hashOf(data);
      if (m && !m.del && m.h === h) continue;
      S.docs[k] = { at: baseline ? 1 : stamp(m && m.at), h, dirty: 1 };
      changed = true;
    }
    if (what !== 'plan') {
      for (const k of Object.keys(S.docs)) {
        if (!k.startsWith('holdings/') || docs[k] || S.docs[k].del) continue;
        S.docs[k] = { at: stamp(S.docs[k].at), h: '', del: 1, dirty: 1 };   // removed here: tell the others
        changed = true;
      }
    }
    return { docs, changed };
  }

  /* ---------- talking to the Apps Script ---------- */

  /** auth is { secret } or { session }, or {} for the actions that need neither. */
  async function post(url, auth, body) {
    let r;
    try {
      r = await fetch(url, {
        method: 'POST', redirect: 'follow',
        // text/plain keeps this a "simple" request, which Apps Script can answer
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({}, auth, body))
      });
    } catch (e) {
      throw new Error("Couldn't reach your Apps Script. Check that you're online, and that the deployment's Who has access is set to Anyone.");
    }
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch (e) {
      throw new Error(/^\s*</.test(text)
        ? "Google answered with a web page instead of data. In Apps Script, check that the deployment's Who has access is Anyone, and that you copied the URL ending in /exec."
        : "Couldn't read the Apps Script's answer.");
    }
    if (!j || j.app !== 'corpus-planner') {
      throw new Error("That URL belongs to a different Apps Script, perhaps one of your other apps. Deploy sheets/Code.gs from this project in its own Sheet, and use that URL.");
    }
    if (!j.ok) throw Object.assign(new Error(j.error || 'The Apps Script turned the request down.'), { info: j });
    return j;
  }

  /** The Sheet turned this device away: sign in again, or connect with the secret again. */
  function refused(info) {
    if (info.login) { S.hold = 'login'; S.lastError = info.error; }
    else if (info.noAccount) { S.hold = 'secret'; S.session = ''; S.lastError = info.error; }
    else if (info.signedOut) { signedOut(); return true; }
    else return false;
    persist(); render();
    emit('mf:account', { hold: S.hold });
    return true;
  }

  /**
   * Another device, or the Sheet's owner, signed this one out: what came from
   * the Sheet goes from here too. The records are forgotten first, so nothing
   * here is read as a deletion and sent back.
   */
  function signedOut() {
    clearTimeout(timer);
    S = fresh({ url: S.url, user: S.user, version: S.version, account: true, hold: 'login', out: true,
                lastError: 'This device was signed out, so its copy of your data was removed. Sign in to get it back.' });
    persist();
    ['mf-portfolio:v1', 'corpus-planner:v1', 'mf-bench:v1'].forEach(k => store.del(k));
    const go = () => location.reload();
    if (window.Lock && window.Lock.flush) window.Lock.flush().then(go, go); else go();
  }

  /* ---------- one sync ---------- */

  function takeRemote(rows, report) {
    applying = true;
    try {
      let P = null, plan = null, planAt = 0;
      const portfolio = () => P || (P = JSON.parse(JSON.stringify(window.Portfolio.syncGet())));
      for (const r of rows) {
        const k = r.c + '/' + r.id, m = S.docs[k];
        if (m && m.dirty && m.at > r.at) continue;           // this device's newer edit goes up next
        // Already what this device holds (usually its own change coming back):
        // note the Sheet's time, but don't redraw a page someone may be typing in.
        if (m && !!m.del === !!r.del && m.h === (r.del ? '' : hashOf(r.data))) { m.at = r.at; delete m.dirty; continue; }
        if (r.c === 'holdings') {
          if (!window.Portfolio) continue;
          const list = portfolio().holdings, i = list.findIndex(h => h.id === r.id);
          if (r.del) { if (i >= 0) { list.splice(i, 1); report.removed++; } }
          else if (i >= 0) list[i] = r.data;
          else { list.push(r.data); report.added++; }
          S.docs[k] = r.del ? { at: r.at, h: '', del: 1 } : { at: r.at, h: hashOf(r.data) };
        } else if (r.c === 'settings' && r.id === 'portfolio' && !r.del && window.Portfolio) {
          const d = r.data || {};
          portfolio().casWarnings = d.casWarnings || []; portfolio().casPeriod = d.casPeriod || null;
          S.docs[k] = { at: r.at, h: hashOf({ casWarnings: d.casWarnings || [], casPeriod: d.casPeriod || null }) };
        } else if (r.c === 'settings' && r.id === 'plan' && !r.del && window.Planner && window.Planner.syncSet) {
          plan = r.data; planAt = r.at;
        } else if (r.c === 'settings' && r.id === 'bench' && !r.del && window.Bench) {
          window.Bench.syncSet(r.data);
          S.docs[k] = { at: r.at, h: hashOf(window.Bench.syncGet().data) };
        }
      }
      if (P) window.Portfolio.syncSet(P);
      if (plan) {
        const before = window.Planner.syncGet();
        window.Planner.syncSet(plan);
        // The planner may tidy what it was given; remember its own version, so
        // that isn't mistaken for an edit and sent back.
        const after = window.Planner.syncGet();
        S.docs['settings/plan'] = { at: planAt, h: hashOf(after.data) };
        if (!before.blank && hashOf(before.data) !== hashOf(after.data)) report.plan = true;
      }
    } finally {
      applying = false;
    }
  }

  async function run() {
    if (!connected()) return;
    if (busy) { again = true; return; }
    busy = true; again = false; clearTimeout(timer); render();
    const report = { added: 0, removed: 0, plan: false };
    try {
      const { docs } = scan();
      const sent = {}, changes = [];
      for (const k of Object.keys(S.docs)) {
        const m = S.docs[k];
        if (!m.dirty) continue;
        const [c, id] = [k.slice(0, k.indexOf('/')), k.slice(k.indexOf('/') + 1)];
        if (!m.del && !docs[k]) { delete S.docs[k]; continue; }
        changes.push({ c, id, at: m.at, del: m.del ? 1 : 0, data: m.del ? null : docs[k].data });
        sent[k] = m.at;
      }
      if (S.snap && S.snap.dirty) { changes.push({ c: 'snapshot', id: 'latest', at: S.snap.at, del: 0, data: S.snap.data }); sent.snap = S.snap.at; }

      const res = await post(S.url, cred(), { action: 'sync', epoch: S.epoch, since: S.cursor, changes });
      if (typeof res.now === 'number') S.skew = res.now - Date.now();
      for (const k of Object.keys(sent)) {
        if (k === 'snap') { if (S.snap && S.snap.at === sent.snap) S.snap.dirty = 0; }
        else if (S.docs[k] && S.docs[k].at === sent[k]) S.docs[k].dirty = 0;   // unless edited again meanwhile
      }
      takeRemote((res.changes || []).concat(res.rejected || []), report);
      (res.refused || []).forEach(x => { if (S.docs[x.c + '/' + x.id]) S.docs[x.c + '/' + x.id].dirty = 0; });
      if (res.resync) {
        // The Sheet's data is new or was erased: send it everything this
        // device holds that didn't just go up.
        for (const k of Object.keys(S.docs)) if (!(k in sent) && !S.docs[k].dirty) { S.docs[k].dirty = 1; again = true; }
        if (S.snap && !('snap' in sent)) { S.snap.dirty = 1; again = true; }
      }
      Object.assign(S, { epoch: res.epoch, cursor: res.cursor, sheetUrl: res.sheetUrl || S.sheetUrl, lastOk: Date.now(), lastError: '', version: res.version || S.version });
      if (res.refused && res.refused.length) S.lastError = `${res.refused.length} record${res.refused.length === 1 ? " wasn't" : "s weren't"} stored: ${res.refused[0].error}.`;
      persist();
      if (report.added || report.removed || report.plan) emit('mf:synced', report);
      return report;
    } catch (e) {
      if (e.info && refused(e.info)) throw e;
      S.lastError = e.message || String(e);
      persist();
      throw e;
    } finally {
      busy = false;
      render();
      if (again) schedule(0);
    }
  }

  function schedule(ms) {
    if (!connected()) return;
    clearTimeout(timer);
    timer = setTimeout(() => { run().catch(() => { /* shown in the status */ }); }, ms == null ? DEBOUNCE : ms);
  }

  /** Send what's waiting as the page closes; the next sync settles it either way. */
  function flushOnLeave() {
    if (!connected() || busy || !navigator.sendBeacon) return;
    const { docs } = scan();
    const changes = Object.keys(S.docs).filter(k => S.docs[k].dirty && (S.docs[k].del || docs[k])).map(k => {
      const m = S.docs[k], i = k.indexOf('/');
      return { c: k.slice(0, i), id: k.slice(i + 1), at: m.at, del: m.del ? 1 : 0, data: m.del ? null : docs[k].data };
    });
    persist();
    if (!changes.length) return;
    const body = JSON.stringify(Object.assign(cred(), { action: 'sync', epoch: S.epoch, since: S.cursor, changes }));
    try { navigator.sendBeacon(S.url, new Blob([body], { type: 'text/plain;charset=utf-8' })); } catch (e) { /* next visit sends it */ }
  }

  /* ---------- connecting ---------- */

  function makeSecret() {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const checkUrl = url => {
    url = String(url || '').trim();
    if (!URL_RE.test(url)) throw new Error('Paste the web app URL from Apps Script (Deploy, then Manage deployments). It starts with https://script.google.com/ and ends in /exec.');
    return url;
  };

  /** What the Sheet's script offers: { version, account }. A version 2 script doesn't answer hello. */
  async function hello(url) {
    url = checkUrl(url);
    try { const r = await post(url, {}, { action: 'hello' }); return { version: r.version || 3, account: !!r.account, setup: !!r.setup }; }
    catch (e) {
      if (e.info && (e.info.badSecret || e.info.setup)) return { version: e.info.setup ? 3 : 2, account: false, setup: !!e.info.setup };
      throw e;
    }
  }

  /** Start syncing: this device's data is stamped as old, so what's already in the Sheet wins. */
  async function begin(fields, first) {
    S = fresh(Object.assign({ sheetUrl: first.sheetUrl || '', version: first.version || 0, account: !!first.account, user: first.user || '',
      skew: typeof first.now === 'number' ? first.now - Date.now() : 0 }, fields));
    scan(undefined, true);
    const snap = window.Portfolio && window.Portfolio.snapshot && window.Portfolio.snapshot();
    if (snap) S.snap = { h: hashOf(snap), at: stamp(), dirty: 1, data: snap };
    persist();
    if (window.Lock) window.Lock.noteSheet(S.url);
    const report = await run();
    const n = window.Portfolio ? window.Portfolio.syncGet().holdings.length : 0;
    return `This device and your Sheet now hold the same ${n} investment${n === 1 ? '' : 's'}` +
      (report && report.plan ? ", and the plan already in your Sheet replaced this device's plan." : ' and the same plan.');
  }

  async function connect(url, secret) {
    url = checkUrl(url); secret = String(secret || '').trim();
    if (secret.length < MIN_SECRET) throw new Error(`The secret is the SECRET script property, at least ${MIN_SECRET} characters long.`);
    const ping = await post(url, { secret }, { action: 'ping' });
    return 'Connected. ' + await begin({ url, secret }, ping);
  }

  /**
   * Sign in with a name and password. keys come from Lock.passwordKeys. A
   * device already syncing carries on with its session; a new one starts as
   * connect() does.
   */
  async function signIn(url, keys) {
    url = checkUrl(url);
    const r = await post(url, {}, { action: 'login', user: keys.user, auth: keys.auth, device: window.Lock.deviceName() });
    if (S.url === url && S.epoch && !S.out) {
      Object.assign(S, { session: r.session, secret: '', user: r.user, account: true, hold: '', lastError: '', version: r.version || S.version });
      persist(); render();
      if (window.Lock) window.Lock.noteSheet(url);
      await run();
      return 'Signed in.';
    }
    return 'Signed in. ' + await begin({ url, session: r.session, account: true }, r);
  }

  /** After making the login, or recovering it: this device carries on with a session instead of the secret. */
  function useSession(session, user) {
    Object.assign(S, { session, user, secret: '', account: true, hold: '', out: false, lastError: '' });
    persist(); render();
    if (window.Lock) window.Lock.noteSheet(S.url);
  }

  /** An account or data action, with this device's secret or session. */
  const call = (action, body) => post(S.url, cred(), Object.assign({ action }, body)).catch(e => { if (e.info) refused(e.info); throw e; });
  /** A request that needs neither: login, questions, recover (the Sheet counts wrong tries). */
  const callOpen = (action, body) => post(S.url, {}, Object.assign({ action }, body));

  function disconnect() {
    clearTimeout(timer);
    if (S.session) post(S.url, { session: S.session }, { action: 'logout' }).catch(() => {});
    S = fresh();
    persist();
    render();
    if (window.Lock) window.Lock.noteSheet(null);
  }

  /** Sign this device out: its session ends, and what came from the Sheet leaves it. */
  async function signOutHere() {
    try { await call('logout', {}); } catch (e) { /* signed out either way */ }
    signedOut();
  }

  /* ---------- status ---------- */

  function ago(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 45) return 'just now';
    if (s < 90) return 'a minute ago';
    if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
    if (s < 5400) return 'an hour ago';
    if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
    return 'on ' + fmtDate(ms - new Date().getTimezoneOffset() * 60e3);
  }
  const waiting = () => Object.values(S.docs).some(m => m.dirty) || !!(S.snap && S.snap.dirty);

  function render() {
    const on = connected();
    const state = busy || (waiting() && !S.lastError) ? 'busy' : S.lastError ? 'warn' : 'ok';
    const chip = $('#syncChip');
    if (chip) {
      chip.hidden = !on;
      chip.className = 'sync-chip ' + state;
      $('#syncChipText').textContent = state === 'busy' ? 'Saving to Sheet…' : state === 'warn' ? 'Sheet not updated' : 'Sheet synced';
      chip.title = S.lastError || (S.lastOk ? `Last synced ${ago(S.lastOk)}` : '');
    }
    const card = $('#syncCard');
    if (card) {
      card.className = 'sync-card' + (on ? ' ' + state : '');
      $('#syncCardTitle').textContent = !on ? 'Google Sheet' : state === 'busy' ? 'Saving to your Sheet…' : state === 'warn' ? 'Sheet not updated' : 'Google Sheet synced';
      $('#syncCardSub').textContent = !on ? 'Not connected. Keep your data on every device.' : S.lastError ? 'Your changes are kept here and go up at the next sync.' : S.lastOk ? `Last synced ${ago(S.lastOk)}` : 'Not synced yet';
    }
    if (!$('#syncBox')) return;
    $('#syncSetup').hidden = on;
    $('#syncOn').hidden = !on;
    if (!on && S.hold && S.url) {
      if (!$('#syncUrl').value) $('#syncUrl').value = S.url;
      $('#syncLoginBox').hidden = S.hold !== 'login';
      $('#syncSecretBox').hidden = S.hold !== 'secret';
      $('#syncNext').hidden = true;
      if (S.hold === 'login' && S.user && !$('#syncUser').value) $('#syncUser').value = S.user;
      if (!$('#syncMsg').textContent) msg(S.lastError, true);
    }
    const who = $('#syncWho');
    if (who) { who.hidden = !(on && S.session); who.textContent = S.session ? `Signed in as ${S.user}. Manage the login and devices under Security.` : ''; }
    const note = $('#pfBackupNote');
    if (note) note.textContent = on
      ? 'Your portfolio is saved in this browser and in your Google Sheet. The site itself never includes it.'
      : 'Your portfolio is saved only in this browser. Nothing is uploaded, and the site\'s public data never includes it.';
    if (!on) return;
    const st = $('#syncState');
    st.classList.toggle('bad', !!S.lastError && !busy);
    st.innerHTML = busy ? 'Syncing with your Sheet…'
      : S.lastError ? `${esc(S.lastError)} Your changes are kept on this device and go up at the next sync.`
      : S.lastOk ? `Your plan and portfolio are in your Sheet. Last synced ${ago(S.lastOk)}.` : 'Not synced yet.';
    const open = $('#syncOpen');
    open.hidden = !S.sheetUrl;
    if (S.sheetUrl) open.href = S.sheetUrl;
  }

  function msg(text, bad) { const el = $('#syncMsg'); if (!el) return; el.textContent = text; el.classList.toggle('bad', !!bad); }

  function bind() {
    if (!$('#syncBox')) return;
    $('#syncMake').addEventListener('click', () => {
      const box = $('#syncSecret');
      box.type = 'text'; box.value = makeSecret(); box.focus(); box.select();
      const next = 'Add it in Apps Script: Project Settings, Script properties, property SECRET with this value. Then connect.';
      msg(next);
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(box.value).then(() => msg('Copied. ' + next), () => {});
    });
    const showBoxes = which => {
      $('#syncSecretBox').hidden = which !== 'secret';
      $('#syncLoginBox').hidden = which !== 'login';
      $('#syncRec').hidden = which !== 'rec';
      $('#syncNext').hidden = !!which;
    };
    $('#syncUrl').addEventListener('input', () => { if (!S.hold) showBoxes(''); });
    $('#syncNext').addEventListener('click', async () => {
      const btn = $('#syncNext');
      btn.disabled = true; msg('Checking your Sheet…');
      try {
        const h = await hello($('#syncUrl').value);
        if (h.account) { showBoxes('login'); msg(''); $('#syncUser').focus(); }
        else { showBoxes('secret'); msg(h.setup ? "The script has no SECRET yet. Make one below and add it in Apps Script's Script properties." : 'Paste the secret, the SECRET script property.'); $('#syncSecret').focus(); }
      } catch (e) { msg(e.message, true); }
      finally { btn.disabled = false; }
    });
    $('#syncConnect').addEventListener('click', async () => {
      const btn = $('#syncConnect');
      btn.disabled = true; msg('Connecting…');
      try {
        msg(await connect($('#syncUrl').value, $('#syncSecret').value));
        $('#syncSecret').value = ''; $('#syncSecret').type = 'password';
        emit('mf:account', { connected: true });
      } catch (e) {
        msg(e.message, true);
        if (connected()) render();
      } finally { btn.disabled = false; }
    });
    $('#syncLoginBox').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = $('#syncSignIn');
      btn.disabled = true; msg('Signing in…');
      try {
        const keys = await window.Lock.passwordKeys($('#syncUser').value, $('#syncPass').value);
        msg(await signIn($('#syncUrl').value, keys));
        $('#syncPass').value = '';
        emit('mf:account', { signedIn: true, keys });
      } catch (err) { msg(err.message, true); $('#syncPass').select(); }
      finally { btn.disabled = false; }
    });
    $('#syncForgot').addEventListener('click', () => {
      let url;
      try { url = checkUrl($('#syncUrl').value); } catch (e) { msg(e.message, true); return; }
      showBoxes('rec'); msg('');
      window.Lock.recoveryForm($('#syncRec'), {
        url, user: $('#syncUser').value || S.user,
        onCancel: () => showBoxes('login'),
        onDone: async ({ keys, session, code }) => {
          S = fresh({ url, session, user: keys.user, account: true });   // everything else comes back from the Sheet
          persist();
          window.Lock.showCode($('#syncRec'), code, async () => {
            showBoxes(''); msg('Your new password is set. Syncing…');
            emit('mf:account', { signedIn: true, keys, recovered: true });
            try { msg('Signed in. ' + await begin({ url, session, account: true, user: keys.user }, { account: true, user: keys.user })); } catch (err) { msg(err.message, true); }
          });
        }
      });
    });
    $('#syncNow').addEventListener('click', () => { msg(''); run().catch(() => {}); });
    $('#syncOff').addEventListener('click', () => {
      if (!window.confirm('Stop syncing this device? Your plan and portfolio stay on this device and in your Sheet.')) return;
      disconnect(); msg('Disconnected. This device no longer syncs.');
    });
    // the chip on Home opens the Google Sheet panel
    $('#syncChip').addEventListener('click', e => { e.preventDefault(); if (window.Shell) window.Shell.openPanel('panelSheet'); });
  }

  /* ---------- wiring ---------- */

  document.addEventListener('mf:changed', e => {
    if (!connected() || applying) return;
    if (scan(e.detail && e.detail.what).changed) { persist(); schedule(); }
    render();
  });
  document.addEventListener('mf:valued', e => {
    if (!connected() || !e.detail) return;
    const h = hashOf(e.detail);
    if (S.snap && S.snap.h === h) return;
    S.snap = { h, at: stamp(S.snap && S.snap.at), dirty: 1, data: e.detail };
    persist(); schedule();
  });
  // Another tab of this site changed something: pick it up rather than
  // overwrite it with this tab's older copy.
  MF.onStorage(key => {
    if (key === KEY) { S = load(); render(); return; }
    if (!connected()) return;
    applying = true;
    try {
      if (key === 'mf-portfolio:v1' && window.Portfolio) window.Portfolio.syncSet(store.json(key, { holdings: [] }));
      else if (key === 'corpus-planner:v1' && window.Planner && window.Planner.syncSet) window.Planner.syncSet(store.json(key, {}));
      else if (key === 'mf-bench:v1' && window.Bench) window.Bench.syncSet(store.json(key, {}));
    } finally { applying = false; }
  });
  window.addEventListener('online', () => schedule(0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - S.lastOk > 60e3) schedule(0);
    else if (document.visibilityState === 'hidden') flushOnLeave();
  });
  window.addEventListener('pagehide', flushOnLeave);
  setInterval(() => { if (document.visibilityState === 'visible') { if (Date.now() - S.lastOk > PULL_EVERY) schedule(0); else render(); } }, 30e3);

  bind();
  render();
  if (connected()) schedule(0);

  return {
    connected, run, connect, disconnect, makeSecret, hello, signIn, useSession, signOutHere, call, callOpen,
    status: () => ({ busy, lastOk: S.lastOk, lastError: S.lastError, waiting: waiting(), url: S.url, version: S.version, account: S.account,
                     session: !!S.session, secret: !!S.secret, user: S.user, hold: S.hold, out: S.out })
  };
})();
