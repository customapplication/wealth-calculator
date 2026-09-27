/* The lock: a 6-digit PIN (and your password, and a fingerprint or face where
   the browser can) in front of everything the site keeps on this device.

   With the lock on, every personal key (corpus-planner:*, mf-*) is stored
   encrypted (AES-GCM) under a random data key made for this device. That key
   is kept only wrapped, that is, encrypted:
     - by a key from your PIN (PBKDF2-SHA256, 600,000 rounds, a random salt).
       5 wrong PINs delete this copy, and then only the password opens it.
     - by a key from your name and password (the same derivation that signs in
       to your Google Sheet, so one password opens every device).
     - optionally by a passkey's PRF secret, which your fingerprint or face
       releases, on browsers that support it.
   The site's other scripts load only once it's unlocked. After a few minutes
   away the page reloads, which drops every key from memory and locks again.

   Loaded right after common.js; it loads the rest of the site. */
window.Lock = (() => {
  'use strict';
  const { $, esc, store, emit } = MF;
  const META = 'mf-lock:v1';
  const REASON = 'mf-lock-reason';          // sessionStorage: why the page locked, for the lock screen
  const ENC = 'enc1:';
  const ITER = 600000;
  const PIN_TRIES = 5;
  const APP_SCRIPTS = ['js/planner.js', 'js/explore.js', 'js/compare.js', 'js/cas.js', 'js/portfolio.js', 'js/sync.js',
    'js/security.js', 'js/update.js', 'js/app.js'];
  const te = new TextEncoder(), td = new TextDecoder();
  const subtle = window.crypto && window.crypto.subtle;

  /* ---------- bytes and keys ---------- */
  const b64 = u8 => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const unb64 = s => {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  };
  const rand = n => crypto.getRandomValues(new Uint8Array(n));

  /** Names are compared trimmed, in lower case, with single spaces (the Sheet's script does the same). */
  const normUser = u => String(u || '').trim().toLowerCase().replace(/\s+/g, ' ');

  async function pbkdf2(secret, salt) {
    const base = await subtle.importKey('raw', te.encode(secret), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: typeof salt === 'string' ? te.encode(salt) : salt, iterations: ITER }, base, 256));
  }
  async function hkdf(bits, info) {
    const base = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(info) }, base, 256));
  }
  const aesKey = bytes => subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  async function seal(key, bytes) {
    const iv = rand(12);
    return { iv: b64(iv), ct: b64(new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes))) };
  }
  async function unseal(key, box) {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct)));
  }

  /** From a name and password: `auth` proves you to the Sheet's script; `data` never leaves the device. */
  async function passwordKeys(user, password) {
    const master = await pbkdf2(String(password), 'SIPs login v1|' + normUser(user));
    return { user: normUser(user), auth: b64(await hkdf(master, 'SIPs auth')), data: await aesKey(await hkdf(master, 'SIPs data')) };
  }
  /** Answers are compared on their letters and digits only: capitals, spaces and punctuation don't matter. */
  const normAnswer = a => String(a || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const CODE_ABC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // Crockford's base 32: no I, L, O or U to misread
  const normCode = c => String(c || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '');
  function newRecoveryCode() {
    let s = '';
    rand(20).forEach(b => { s += CODE_ABC[b & 31]; });
    return s.match(/.{5}/g).join('-');
  }
  /** The recovery proof: your 3 answers plus the recovery code, made the same way as the password's. */
  async function recoveryProof(user, answers, code) {
    const master = await pbkdf2(answers.map(normAnswer).join('\n') + '\n' + normCode(code), 'SIPs recovery v1|' + normUser(user));
    return b64(await hkdf(master, 'SIPs recovery'));
  }

  function deviceName() {
    const ua = navigator.userAgent || '';
    const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
    const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `${b} on ${os}` : b;
  }

  /** One request to the Sheet's Apps Script, for signing in and recovery before the rest of the site has loaded. */
  async function callScript(url, body) {
    let r;
    try {
      r = await fetch(url, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
    } catch (e) { throw Object.assign(new Error("Couldn't reach your Google Sheet. Check that you're online."), { info: {} }); }
    let j = null;
    try { j = JSON.parse(await r.text()); } catch (e) { /* below */ }
    if (!j || j.app !== 'corpus-planner') throw Object.assign(new Error("Your Google Sheet's script didn't answer as expected."), { info: {} });
    if (!j.ok) throw Object.assign(new Error(j.error || 'The Sheet turned the request down.'), { info: j });
    return j;
  }

  /* ---------- the lock's settings (plain: they hold only wrapped keys and salts) ---------- */
  const readMeta = () => { try { const m = JSON.parse(store.raw.get(META)); return m && m.v === 1 && m.pw ? m : null; } catch (e) { return null; } };
  const writeMeta = m => { if (!store.raw.set(META, JSON.stringify(m))) throw new Error("This browser won't save the lock's settings (its storage is full or blocked)."); };
  let meta = readMeta();

  /* ---------- the vault: personal keys, encrypted in localStorage, plain in memory ---------- */
  let dataKey = null, dataBytes = null;
  const mem = new Map(), seq = new Map(), pending = new Set();
  async function encryptValue(v) {
    const iv = rand(12), ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, dataKey, te.encode(v)));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv); out.set(ct, 12);
    return ENC + b64(out);
  }
  async function decryptValue(s) {
    const u = unb64(s.slice(ENC.length));
    return td.decode(await subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, dataKey, u.slice(12)));
  }
  const vault = {
    mem,
    write(k, v) {
      const n = (seq.get(k) || 0) + 1;
      seq.set(k, n);
      const p = encryptValue(v)
        .then(enc => { if (seq.get(k) === n && !store.raw.set(k, enc)) emit('mf:store-full', { key: k }); })
        .catch(() => {})
        .finally(() => pending.delete(p));
      pending.add(p);
    },
    del(k) { seq.set(k, (seq.get(k) || 0) + 1); store.raw.del(k); }
  };
  /** Wait for the last writes to be encrypted and stored (at most a second and a half). */
  const flush = () => Promise.race([Promise.all([...pending]), new Promise(r => setTimeout(r, 1500))]);

  async function openVault(bytes) {
    dataBytes = bytes; dataKey = await aesKey(bytes);
    const plain = [];
    for (const k of store.raw.keys()) {
      if (!store.personal(k)) continue;
      const v = store.raw.get(k);
      if (v == null) continue;
      if (v.startsWith(ENC)) {
        try { mem.set(k, await decryptValue(v)); } catch (e) { /* made under an older key that's gone: left for the next write */ }
      } else { mem.set(k, v); plain.push(k); }          // from before the lock was on
    }
    store.useVault(vault);
    plain.forEach(k => vault.write(k, mem.get(k)));
  }

  // Another tab changed something: decrypt it, then tell the page as if it were plain.
  window.addEventListener('storage', async e => {
    if (e.key === META) {
      const was = !!meta;
      meta = readMeta();
      if (!!meta !== was || (dataKey && !meta)) location.reload();   // the lock was switched on or off elsewhere
      return;
    }
    if (!dataKey || !e.key || !store.personal(e.key)) return;
    if (e.newValue == null) { mem.delete(e.key); emit('mf:storage', { key: e.key }); return; }
    if (!e.newValue.startsWith(ENC)) return;
    try {
      const v = await decryptValue(e.newValue);
      if (store.raw.get(e.key) !== e.newValue) return;           // overtaken while decrypting
      mem.set(e.key, v);
      emit('mf:storage', { key: e.key });
    } catch (err) { /* not ours to read */ }
  });

  /* ---------- starting the site ---------- */
  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    document.documentElement.classList.remove('locked');
    const scr = $('#lockScreen');
    if (scr) { scr.hidden = true; scr.innerHTML = ''; }
    for (const src of APP_SCRIPTS) {
      const s = document.createElement('script');
      s.src = src; s.async = false;
      document.body.appendChild(s);
    }
    if (meta) autoLock();
  }

  /* ---------- locking itself ---------- */
  let idleSince = Date.now(), hiddenAt = 0, autoOn = false;
  const afterMs = () => Math.max(1, Number(meta && meta.after) || 5) * 60e3;
  async function lockNow(reason) {
    try { sessionStorage.setItem(REASON, reason || 'now'); } catch (e) { /* no reason shown */ }
    await flush();
    location.reload();
  }
  function autoLock() {
    if (autoOn) return;
    autoOn = true;
    const touch = () => { idleSince = Date.now(); };
    ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(ev => window.addEventListener(ev, touch, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', () => {
      if (!meta) return;
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt >= afterMs()) lockNow('away');
      hiddenAt = 0; touch();
    });
    setInterval(() => {
      if (meta && document.visibilityState === 'visible' && Date.now() - idleSince >= afterMs()) lockNow('away');
    }, 10e3);
  }

  /* ---------- the lock screen ---------- */
  const scr = () => $('#lockScreen');
  const fine = () => window.matchMedia && window.matchMedia('(pointer: fine)').matches;
  const logo = '<svg class="lock-logo" viewBox="0 0 30 30" aria-hidden="true"><rect width="30" height="30" rx="9" fill="var(--accent)"/><rect x="7" y="16" width="4" height="7" rx="2" fill="var(--on-accent)"/><rect x="13" y="12" width="4" height="11" rx="2" fill="var(--on-accent)"/><rect x="19" y="7" width="4" height="16" rx="2" fill="var(--on-accent)"/></svg>';
  const ic = n => `<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  let mode = 'pin', pinFirst = '', busy = false, pinDone = null;

  function reasonText() {
    let r = null;
    try { r = sessionStorage.getItem(REASON); sessionStorage.removeItem(REASON); } catch (e) { /* none */ }
    const m = meta && meta.after ? meta.after : 5;
    return r === 'away' ? `SIPs locked itself after ${m} minute${m === 1 ? '' : 's'} away.` : r === 'now' ? 'SIPs is locked.' : 'Welcome back.';
  }

  function showLock() {
    document.documentElement.classList.add('locked');
    const el = scr();
    el.hidden = false;
    if (meta.pin) showPin(reasonText()); else showPassword('This device has no PIN. Unlock with your password, then choose a PIN.');
  }

  function keypad(bio) {
    const k = d => `<button type="button" class="key" data-key="${d}">${d}</button>`;
    return `<div class="keys">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(k).join('')}
      ${bio ? `<button type="button" class="key flat" data-key="bio" aria-label="Unlock with fingerprint or face">${ic('finger')}</button>` : '<span></span>'}
      ${k(0)}<button type="button" class="key flat" data-key="del" aria-label="Delete the last digit">${ic('erase')}</button></div>`;
  }

  /** The PIN pad: to unlock, or to choose a new PIN (done(pin) is called with it, twice-checked). */
  /** Each view of the lock screen starts idle. */
  function fresh() { busy = false; const el = scr(); el.classList.remove('busy'); return el; }

  function showPin(sub, choosing, done) {
    mode = choosing ? 'newpin' : 'pin'; pinFirst = ''; pinDone = done || null;
    const el = fresh();
    el.innerHTML = `<div class="lock-in">${logo}
      <h1 id="lockTitle">${choosing ? 'Choose a PIN for this device' : 'Enter your PIN'}</h1>
      <p class="lock-sub" id="lockSub" aria-live="polite">${esc(sub || '')}</p>
      <form class="lock-pin" id="lockPinForm" autocomplete="off">
        <label class="sr-only" for="lockPinIn">${choosing ? 'New 6-digit PIN' : 'Your 6-digit PIN'}</label>
        <input id="lockPinIn" class="lock-pin-in" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" enterkeyhint="done">
        <div class="dots" id="lockDots" role="img" aria-label="0 of 6 digits entered">${'<span></span>'.repeat(6)}</div>
        ${keypad(!choosing && meta && meta.bio && window.PublicKeyCredential)}
      </form>
      <div class="lock-foot">
        ${choosing ? '' : '<button type="button" class="linkish" data-go="password">Use my password</button>'}
        <small>${choosing ? 'Six digits you\'ll type to open SIPs on this device.' : `After ${PIN_TRIES} wrong PINs this device forgets its key and asks for your password.`}</small>
      </div></div>`;
    const input = $('#lockPinIn');
    input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); drawDots(); if (input.value.length === 6) pinEntered(input.value); });
    $('#lockPinForm').addEventListener('submit', e => { e.preventDefault(); if (input.value.length === 6) pinEntered(input.value); });
    $('.keys', el).addEventListener('click', e => {
      const b = e.target.closest('[data-key]');
      if (!b || busy) return;
      const k = b.dataset.key;
      if (k === 'bio') { unlockBio(); return; }
      input.value = k === 'del' ? input.value.slice(0, -1) : (input.value + k).slice(0, 6);
      input.dispatchEvent(new Event('input'));
      if (fine()) input.focus();
    });
    if (fine()) setTimeout(() => input.focus(), 0);
    drawDots();
  }
  function drawDots(err) {
    const n = ($('#lockPinIn') || { value: '' }).value.length, dots = $('#lockDots');
    if (!dots) return;
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i < n));
    dots.setAttribute('aria-label', `${n} of 6 digits entered`);
    dots.classList.toggle('shake', !!err);
  }
  function say(text, bad) { const s = $('#lockSub'); if (s) { s.textContent = text; s.classList.toggle('bad', !!bad); } }
  function setBusy(on) { busy = on; scr().classList.toggle('busy', on); scr().querySelectorAll('button, input').forEach(x => { x.disabled = on; }); }

  async function pinEntered(pin) {
    if (busy) return;
    const input = $('#lockPinIn');
    if (mode === 'newpin') {
      if (!pinFirst) { pinFirst = pin; input.value = ''; drawDots(); $('#lockTitle').textContent = 'Enter the same PIN again'; say(''); return; }
      if (pin !== pinFirst) { pinFirst = ''; input.value = ''; drawDots(true); $('#lockTitle').textContent = 'Choose a PIN for this device'; say("The two PINs didn't match. Choose one again.", true); return; }
      setBusy(true); say('Saving your PIN…');
      try { await setPin(pin); if (pinDone) pinDone(); else boot(); } catch (e) { setBusy(false); say(e.message, true); }
      return;
    }
    setBusy(true); say('Checking…');
    try {
      const key = await aesKey(await pbkdf2(pin, unb64(meta.pin.salt)));
      const bytes = await unseal(key, meta.pin.box);
      meta = readMeta(); meta.tries = 0; writeMeta(meta);
      await openVault(bytes);
      boot();
    } catch (e) {
      setBusy(false);
      meta = readMeta() || meta;
      meta.tries = (meta.tries || 0) + 1;
      input.value = '';
      if (meta.tries >= PIN_TRIES) {
        meta.pin = null; meta.tries = 0; writeMeta(meta);
        showPassword(`${PIN_TRIES} wrong PINs, so this device forgot its PIN key. Unlock with your password, then choose a new PIN.`, true);
        return;
      }
      writeMeta(meta);
      const left = PIN_TRIES - meta.tries;
      drawDots(true);
      say(`Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`, true);
      if (fine()) input.focus();
    }
  }

  async function unlockBio() {
    setBusy(true); say('Waiting for your fingerprint or face…');
    try {
      const bytes = await unseal(await bioKey(meta.bio), meta.bio.box);
      await openVault(bytes);
      boot();
    } catch (e) {
      setBusy(false);
      say(e && e.name === 'NotAllowedError' ? 'Cancelled. Type your PIN instead.' : "That didn't unlock SIPs. Type your PIN instead.", true);
    }
  }

  function showPassword(sub, bad) {
    mode = 'password';
    const el = fresh();
    el.innerHTML = `<div class="lock-in">${logo}
      <h1>Unlock with your password</h1>
      <p class="lock-sub${bad ? ' bad' : ''}" id="lockSub" aria-live="polite">${esc(sub || '')}</p>
      <form class="lock-form" id="lockPwForm">
        <label class="field"><span class="lbl">Your name</span><span class="box"><input id="lockUser" autocomplete="username" spellcheck="false" autocapitalize="off" value="${esc(meta.user || '')}"></span></label>
        <label class="field"><span class="lbl">Password</span><span class="box"><input id="lockPass" type="password" autocomplete="current-password"></span></label>
        <button type="submit" class="btn wide">Unlock</button>
      </form>
      <div class="lock-foot">
        ${meta.pin ? '<button type="button" class="linkish" data-go="pin">Use my PIN</button>' : ''}
        <button type="button" class="linkish" data-go="forgot">Forgot your password?</button>
      </div></div>`;
    $('#lockPwForm').addEventListener('submit', async e => {
      e.preventDefault();
      setBusy(true); say('Checking…');
      try { await unlockPassword($('#lockUser').value, $('#lockPass').value); }
      catch (err) { setBusy(false); say(err.message, true); $('#lockPass').select(); }
    });
    setTimeout(() => $(meta.user ? '#lockPass' : '#lockUser').focus(), 0);
  }

  async function unlockPassword(user, password) {
    if (!normUser(user) || !password) throw new Error('Type your name and password.');
    const k = await passwordKeys(user, password);
    let bytes = null;
    try { bytes = await unseal(k.data, meta.pw); } catch (e) { /* not this device's password; perhaps it changed on another device */ }
    if (bytes) {
      meta = readMeta(); meta.tries = 0; writeMeta(meta);
      await openVault(bytes);
      if (meta.pin) boot(); else showPin('Your password opened SIPs. Now choose a PIN for this device.', true);
      return;
    }
    if (!meta.url) throw new Error("That name and password don't open this device.");
    // A password changed elsewhere: if the Sheet takes it, this device starts again from the Sheet.
    let r;
    try { r = await callScript(meta.url, { action: 'login', user: k.user, auth: k.auth, device: deviceName() }); }
    catch (e) { throw new Error(e.info && (e.info.badLogin || e.info.wait) ? e.message : "That name and password don't open this device, and " + e.message.charAt(0).toLowerCase() + e.message.slice(1)); }
    await rebuild(k, r.session, meta.url);
    showPin('Signed in. This device gets your data from your Google Sheet. Choose a PIN for it.', true);
  }

  /** This device can't open its old copy: start again with a new data key, signed in to the Sheet, which sends everything back. */
  async function rebuild(keys, session, url) {
    const after = meta && meta.after;
    for (const k of store.raw.keys()) if (store.personal(k)) store.raw.del(k);
    const bytes = rand(32);
    meta = { v: 1, user: keys.user, pw: await seal(keys.data, bytes), pin: null, bio: null, tries: 0, after: after || 5, url };
    writeMeta(meta);
    await openVault(bytes);
    store.set('mf-sync:v1', JSON.stringify({ url, session, user: keys.user, secret: '' }));
  }

  /* Forgot the password: the 3 answers plus the recovery code, checked by the Sheet's script. */
  function recoveryForm(host, { url, user, onDone, onCancel }) {
    host.innerHTML = `<form class="lock-form rec-form">
      <p class="muted small rec-msg" aria-live="polite">Your answers and your recovery code set a new password. Every other device is signed out.</p>
      <label class="field"><span class="lbl">Your name</span><span class="box"><input name="user" autocomplete="username" spellcheck="false" autocapitalize="off" value="${esc(user || '')}"></span></label>
      <div class="rec-q" hidden></div>
      <button type="submit" class="btn wide">Next</button>
      ${onCancel ? '<button type="button" class="linkish" data-cancel>Back</button>' : ''}
    </form>`;
    const f = $('form', host), msg = (t, bad) => { const m = $('.rec-msg', host); m.textContent = t; m.classList.toggle('bad', !!bad); };
    let qs = null;
    if (onCancel) $('[data-cancel]', host).addEventListener('click', onCancel);
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = $('button[type="submit"]', f);
      btn.disabled = true;
      try {
        const u = f.user.value;
        if (!qs) {
          msg('Fetching your questions…');
          qs = (await callScript(url, { action: 'questions', user: normUser(u) })).questions;
          $('.rec-q', f).innerHTML = qs.map((q, i) => `<label class="field"><span class="lbl">${esc(q)}</span><span class="box"><input name="a${i}" autocomplete="off" spellcheck="false"></span></label>`).join('') +
            `<label class="field"><span class="lbl">Recovery code <small>the one you wrote down, like 7K2QX-…</small></span><span class="box"><input name="code" autocomplete="off" spellcheck="false" autocapitalize="characters"></span></label>
             <label class="field"><span class="lbl">New password <small>at least 10 characters</small></span><span class="box"><input name="p1" type="password" autocomplete="new-password"></span></label>
             <label class="field"><span class="lbl">New password again</span><span class="box"><input name="p2" type="password" autocomplete="new-password"></span></label>`;
          $('.rec-q', f).hidden = false; f.user.readOnly = true; btn.textContent = 'Set my new password';
          msg('Answer as you did when you made the login. Capitals, spaces and punctuation don\'t matter.');
          f.a0.focus();
          return;
        }
        const answers = qs.map((q, i) => f['a' + i].value);
        if (answers.some(a => !normAnswer(a))) throw new Error('Answer all 3 questions.');
        if (normCode(f.code.value).length !== 20) throw new Error('Type the whole recovery code: 20 letters and digits.');
        if (f.p1.value.length < 10) throw new Error('Choose a new password of at least 10 characters.');
        if (f.p1.value !== f.p2.value) throw new Error("The two new passwords don't match.");
        msg('Checking…');
        const code = newRecoveryCode();
        const [rec, keys, newRec] = await Promise.all([recoveryProof(u, answers, f.code.value), passwordKeys(u, f.p1.value), recoveryProof(u, answers, code)]);
        const r = await callScript(url, { action: 'recover', user: keys.user, rec, newAuth: keys.auth, newRec, device: deviceName() });
        await onDone({ keys, session: r.session, code, url });
      } catch (err) { msg(err.message, true); }
      finally { btn.disabled = false; }
    });
    setTimeout(() => f.user.focus(), 0);
  }

  /** Shows the new recovery code once, until it's been noted down. */
  function showCode(host, code, then) {
    host.innerHTML = `<div class="code-box">
      <p><b>Write down your new recovery code.</b> The old one is used up. With your 3 answers, this code is the only way back in if you forget your password.</p>
      <p class="code" aria-label="Recovery code ${esc(code.split('').join(' '))}">${esc(code)}</p>
      <label class="check"><input type="checkbox"> I've written it down somewhere safe</label>
      <button type="button" class="btn wide" disabled>Continue</button></div>`;
    const cb = $('input', host), go = $('button', host);
    cb.addEventListener('change', () => { go.disabled = !cb.checked; });
    go.addEventListener('click', then);
  }

  function showForgot() {
    mode = 'forgot';
    const el = fresh();
    if (!meta.url) {
      el.innerHTML = `<div class="lock-in">${logo}<h1>Forgot your password?</h1>
        <p class="lock-sub">This device isn't connected to a Google Sheet, so its password can't be reset. If you know your PIN, use it. If not, erase this device's copy and start again: a backup file brings your investments back.</p>
        <div class="lock-foot">${meta.pin ? '<button type="button" class="linkish" data-go="pin">Use my PIN</button>' : ''}
        <button type="button" class="linkish" data-go="password">Try the password again</button>
        <button type="button" class="linkish danger" data-go="erase">Erase this device's copy</button></div></div>`;
      return;
    }
    el.innerHTML = `<div class="lock-in wide">${logo}<h1>Set a new password</h1><div id="lockRec"></div>
      <div class="lock-foot"><button type="button" class="linkish" data-go="password">Back</button></div></div>`;
    recoveryForm($('#lockRec'), {
      url: meta.url, user: meta.user,
      onDone: async ({ keys, session, code, url }) => {
        await rebuild(keys, session, url);
        showCode($('#lockRec'), code, () => showPin('Your new password is set. Choose a PIN for this device.', true));
      }
    });
  }

  function showErase() {
    const el = fresh();
    el.innerHTML = `<div class="lock-in">${logo}<h1>Erase this device's copy?</h1>
      <p class="lock-sub">This removes your investments, plan and settings from this browser. What's in your Google Sheet stays there; sign in again to get it back.</p>
      <button type="button" class="btn wide danger" data-go="erase-yes">Erase this device's copy</button>
      <div class="lock-foot"><button type="button" class="linkish" data-go="back">Keep it</button></div></div>`;
  }

  document.addEventListener('click', e => {
    const g = e.target.closest('#lockScreen [data-go]');
    if (!g || busy) return;
    const go = g.dataset.go;
    if (go === 'password') showPassword('');
    else if (go === 'pin') showPin('');
    else if (go === 'forgot') showForgot();
    else if (go === 'erase') showErase();
    else if (go === 'back') meta.pin ? showPin('') : showPassword('');
    else if (go === 'erase-yes') { eraseDevice(); location.reload(); }
  });

  /* ---------- fingerprint or face (a passkey's PRF secret) ---------- */
  async function bioKey(bio, fresh) {
    const salt = unb64(bio.salt);
    const opts = fresh || {
      publicKey: { challenge: rand(32), allowCredentials: [{ type: 'public-key', id: unb64(bio.id) }], userVerification: 'required', timeout: 60000,
                   extensions: { prf: { eval: { first: salt } } } }
    };
    const a = fresh ? null : await navigator.credentials.get(opts);
    const res = fresh || a.getClientExtensionResults();
    const out = res.prf && res.prf.results && res.prf.results.first;
    if (!out) throw new Error("This browser can't unlock with a fingerprint or face here.");
    return aesKey(await hkdf(new Uint8Array(out), 'SIPs biometric'));
  }
  const bioPossible = async () => {
    try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch (e) { return false; }
  };
  async function addBio() {
    if (!dataBytes || !meta) throw new Error('Turn the lock on first.');
    const salt = rand(32);
    const cred = await navigator.credentials.create({ publicKey: {
      rp: { name: 'SIPs' }, user: { id: rand(16), name: meta.user, displayName: meta.user },
      challenge: rand(32), pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000, extensions: { prf: { eval: { first: salt } } }
    } });
    const ext = cred.getClientExtensionResults();
    if (!ext.prf || !ext.prf.enabled) throw new Error("This browser made a passkey but can't use it to unlock SIPs. Keep using your PIN.");
    const bio = { id: b64(new Uint8Array(cred.rawId)), salt: b64(salt) };
    const key = ext.prf.results && ext.prf.results.first ? await bioKey(bio, ext) : await bioKey(bio);
    bio.box = await seal(key, dataBytes);
    meta = readMeta(); meta.bio = bio; writeMeta(meta);
  }

  /* ---------- for the Security panel ---------- */
  async function setPin(pin) {
    if (!/^\d{6}$/.test(pin)) throw new Error('A PIN is 6 digits.');
    if (!dataBytes) throw new Error('Unlock first.');
    const salt = rand(16);
    const box = await seal(await aesKey(await pbkdf2(pin, salt)), dataBytes);
    meta = readMeta(); meta.pin = { salt: b64(salt), box }; meta.tries = 0; writeMeta(meta);
  }

  /** Turn the lock on: a new data key, wrapped by the PIN and the password, and every personal key encrypted. */
  async function setup({ keys, pin, url }) {
    if (meta) throw new Error('The lock is already on.');
    if (!/^\d{6}$/.test(pin)) throw new Error('A PIN is 6 digits.');
    const bytes = rand(32), salt = rand(16);
    const next = { v: 1, user: keys.user, pw: await seal(keys.data, bytes), pin: { salt: b64(salt), box: await seal(await aesKey(await pbkdf2(pin, salt)), bytes) },
                   bio: null, tries: 0, after: 5, url: url || null };
    writeMeta(next);                         // first, so data is never encrypted under a key nothing can reopen
    meta = next;
    await openVault(bytes);
    await flush();
    autoLock();
  }

  /** Turn the lock off: everything back in plain storage. */
  async function turnOff() {
    if (!meta || !dataKey) return;
    await flush();
    for (const [k, v] of mem) store.raw.set(k, v);
    store.useVault(null);
    store.raw.del(META);
    meta = null; dataKey = null; dataBytes = null;
    mem.clear();
  }

  async function checkPin(pin) {
    try { await unseal(await aesKey(await pbkdf2(pin, unb64(meta.pin.salt))), meta.pin.box); return true; } catch (e) { return false; }
  }
  async function checkPassword(user, password) {
    const k = await passwordKeys(user, password);
    try { await unseal(k.data, meta.pw); return k; } catch (e) { return null; }
  }

  /** After signing in, or a new password: the password's copy of the data key follows it. */
  async function rewrap(keys) {
    if (!meta || !dataBytes) return;
    meta = readMeta(); meta.user = keys.user; meta.pw = await seal(keys.data, dataBytes); writeMeta(meta);
  }
  function setAfter(min) { if (!meta) return; meta = readMeta(); meta.after = min; writeMeta(meta); idleSince = Date.now(); }
  function removeBio() { if (!meta) return; meta = readMeta(); meta.bio = null; writeMeta(meta); }
  /** The Sheet's URL, kept with the lock so "Forgot your password?" works while locked. */
  function noteSheet(url) { if (!meta || meta.url === (url || null)) return; meta = readMeta(); meta.url = url || null; writeMeta(meta); }

  /** Everything this site keeps on this device, gone (the theme stays). */
  function eraseDevice() {
    for (const k of store.raw.keys()) if (store.personal(k) || k === META) store.raw.del(k);
    store.useVault(null);
    meta = null; dataKey = null; dataBytes = null; mem.clear();
  }

  /* ---------- go ---------- */
  if (!subtle) boot();                      // no WebCrypto (not https): the lock can't exist, so neither can its data
  else if (meta) showLock();
  else boot();

  return {
    on: () => !!meta,
    status: () => ({ on: !!meta, user: meta && meta.user, pin: !!(meta && meta.pin), bio: !!(meta && meta.bio), after: meta ? meta.after || 5 : 5, url: meta && meta.url }),
    bioPossible, addBio, removeBio, setPin, setup, turnOff, checkPin, checkPassword, rewrap, setAfter, noteSheet, lockNow, eraseDevice, flush,
    passwordKeys, recoveryProof, newRecoveryCode, normUser, normAnswer, deviceName, callScript, recoveryForm, showCode,
    PIN_TRIES
  };
})();
