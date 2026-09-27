/* Security and devices: the lock on this device (PIN, fingerprint or face,
   locking itself), the login kept by your Google Sheet's script (make it,
   change the password, new questions and recovery code), and the devices
   signed in to it. The keys and the lock itself are in lock.js; talking to
   the Sheet is in sync.js. */
(() => {
  'use strict';
  const { $, $$, esc } = MF;
  const L = window.Lock;
  const S = () => window.Sync;
  const QUESTIONS = [
    'What was the name of your first school?',
    'In which town or city was your mother born?',
    'What was the name of your first pet?',
    "What is your oldest sibling's middle name?",
    'What was the make of your first car or scooter?',
    'In which town did your parents meet?',
    'What was your childhood nickname?',
    'What is the name of the street you grew up on?'
  ];
  const MIN_PW = 10;
  let heldKeys = null;           // right after signing in, so the PIN can be set without the password again
  let busy = false;

  const icon = n => `<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const field = (label, name, type = 'password', extra = '') =>
    `<label class="field"><span class="lbl">${label}</span><span class="box"><input name="${name}" type="${type}" ${extra}></span></label>`;
  const pinFields = (first = 'New PIN') => `<div class="row2">
    ${field(`${first} <small>6 digits</small>`, 'pin1', 'password', 'inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" class="pin-in"')}
    ${field('The same PIN again', 'pin2', 'password', 'inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" class="pin-in"')}</div>`;
  const pwFields = () => field(`Password <small>at least ${MIN_PW} characters</small>`, 'pw1', 'password', 'autocomplete="new-password"') +
    field('The same password again', 'pw2', 'password', 'autocomplete="new-password"');
  const nameField = (v, ro) => field('Your name <small>the same on every device</small>', 'user', 'text',
    `autocomplete="username" spellcheck="false" autocapitalize="off" value="${esc(v || '')}"${ro ? ' readonly' : ''}`);
  const qRows = () => [0, 1, 2].map(i => `<div class="qrow">
      <label class="field"><span class="lbl">Question ${i + 1}</span><span class="box sel"><select name="q${i}">
        ${QUESTIONS.map((q, j) => `<option${j === i ? ' selected' : ''}>${esc(q)}</option>`).join('')}<option value="">Write my own question</option></select></span></label>
      <label class="field" hidden><span class="lbl">Your question</span><span class="box"><input name="own${i}" type="text" maxlength="150" autocomplete="off"></span></label>
      <label class="field"><span class="lbl">Answer</span><span class="box"><input name="a${i}" type="text" autocomplete="off" spellcheck="false"></span></label></div>`).join('');

  /* ---------- checking what was typed ---------- */
  const fail = m => { throw new Error(m); };
  function pinOf(f) {
    const a = f.pin1.value.trim(), b = f.pin2.value.trim();
    if (!/^\d{6}$/.test(a)) fail('A PIN is 6 digits.');
    if (/^(\d)\1{5}$/.test(a) || '0123456789'.includes(a) || '9876543210'.includes(a)) fail('Choose a PIN that is harder to guess than a row or a repeat.');
    if (a !== b) fail("The two PINs don't match.");
    return a;
  }
  function pwOf(f) {
    if (f.pw1.value.length < MIN_PW) fail(`Choose a password of at least ${MIN_PW} characters.`);
    if (f.pw1.value !== f.pw2.value) fail("The two passwords don't match.");
    return f.pw1.value;
  }
  function userOf(f) {
    const u = L.normUser(f.user.value);
    if (u.length < 3 || u.length > 40) fail('Choose a name of 3 to 40 characters.');
    return u;
  }
  function questionsOf(f) {
    const qs = [0, 1, 2].map(i => (f['q' + i].value || f['own' + i].value).replace(/\s+/g, ' ').trim());
    const as = [0, 1, 2].map(i => f['a' + i].value);
    if (qs.some(q => q.length < 5)) fail('Choose or write 3 questions.');
    if (new Set(qs).size < 3) fail('Choose 3 different questions.');
    if (as.some(a => L.normAnswer(a).length < 2)) fail('Answer all 3 questions.');
    return { qs, as };
  }

  /* ---------- the panel ---------- */
  function render() {
    const body = $('#secBody');
    $$('.lock-now').forEach(x => { x.hidden = !L.on(); });
    if (!body || busy) return;
    const lk = L.status(), sy = S() ? S().status() : {}, connected = S() && S().connected();
    const signedIn = connected && sy.session;
    const canMake = connected && sy.secret && sy.version >= 3 && !sy.account;
    const parts = [];

    // the lock
    if (lk.on) {
      parts.push(`<section class="sec"><h3>The lock on this device</h3>
        <p class="state-line">${icon('okcircle')}SIPs opens with your PIN${lk.bio ? ', fingerprint or face' : ''}, or your password.</p>
        <label class="field"><span class="lbl">Lock SIPs after</span><span class="box sel"><select id="secAfter">
          ${[1, 5, 15, 30, 60].map(m => `<option value="${m}"${m === lk.after ? ' selected' : ''}>${m} minute${m === 1 ? '' : 's'} away</option>`).join('')}</select></span></label>
        <div class="btn-row"><button type="button" class="btn quiet sm" data-sec="lock">${icon('lock')}Lock now</button>
          <button type="button" class="btn quiet sm" data-sec="pin">Change the PIN</button>
          <button type="button" class="btn quiet sm" data-sec="bio" hidden>${icon('finger')}${lk.bio ? 'Stop using fingerprint or face' : 'Use fingerprint or face'}</button></div>
        <form id="secPinForm" hidden>${field('Your PIN now', 'cur', 'password', 'inputmode="numeric" maxlength="6" autocomplete="off" class="pin-in"')}${pinFields()}
          <button type="submit" class="btn wide">Change the PIN</button></form>
        <p><button type="button" class="linkish danger" data-sec="off">Turn off the lock</button></p>
        <form id="secOffForm" hidden><p class="hint">Your data goes back to being stored unencrypted in this browser.</p>
          ${field('Your PIN', 'cur', 'password', 'inputmode="numeric" maxlength="6" autocomplete="off" class="pin-in"')}
          <button type="submit" class="btn wide danger">Turn off the lock</button></form>
      </section>`);
    } else if (sy.hold === 'login') {
      parts.push(`<section class="sec"><h3>Sign in first</h3><p class="note">Your Google Sheet has a login. Sign in on this device, then choose its PIN here.</p>
        <button type="button" class="btn wide" data-open-panel="panelSheet">Sign in</button></section>`);
    } else if (signedIn) {
      parts.push(`<section class="sec"><h3>Choose a PIN for this device</h3>
        <p class="note">Your investments, plan and Sheet connection are then kept encrypted here. The PIN opens SIPs; after ${L.PIN_TRIES} wrong tries only your password does.</p>
        <form id="secSetup">${heldKeys ? '' : field('Your password', 'pw', 'password', 'autocomplete="current-password"')}${pinFields('PIN')}
          <button type="submit" class="btn wide">${icon('lock')}Lock SIPs with this PIN</button></form></section>`);
    } else if (canMake) {
      parts.push(`<section class="sec"><h3>Make your login</h3>
        <p class="note">One name and password for every device, kept by your Sheet's script (only a scrambled proof of it, never the password). From then on, the secret alone no longer opens your data: each device signs in, and you can sign any of them out. If you forget the password, your 3 answers plus a recovery code set a new one. You'll be the Sheet's owner, and can then invite family members, each with their own login and portfolio.</p>
        <form id="secMake">${nameField(sy.user)}${pwFields()}<p class="lbl">3 security questions <small>answers aren't stored anywhere</small></p>${qRows()}
          ${pinFields('PIN for this device')}
          <button type="submit" class="btn wide">${icon('shield')}Make the login and lock this device</button></form></section>`);
    } else {
      const old = connected && sy.version && sy.version < 3;
      parts.push(`<section class="sec"><h3>Lock SIPs on this device</h3>
        <p class="note">Your investments and plan are kept encrypted here. A 6-digit PIN opens SIPs; after ${L.PIN_TRIES} wrong tries only your password does.
        ${old ? '<br><b>Your Sheet runs an older script.</b> Paste the new <code>sheets/Code.gs</code> and deploy a new version to get a login shared by all your devices, with recovery by security questions.'
              : connected ? '' : '<br>Connect your Google Sheet first if you want one login for all your devices, and a way to reset a forgotten password.'}</p>
        <form id="secLocal">${nameField('')}${pwFields()}${pinFields('PIN')}
          <button type="submit" class="btn wide">${icon('lock')}Lock SIPs on this device</button></form></section>`);
    }

    // the login
    if (signedIn) {
      parts.push(`<section class="sec"><h3>Your login</h3><p class="state-line">${icon('okcircle')}<span>Signed in as <b>${esc(sy.user)}</b>${sy.role === 'owner' ? ', the Sheet\'s owner' : sy.role === 'member' ? ', a family member' : ''}</span></p>
        <details><summary class="linkish">Change the password</summary><form id="secPw">
          ${field('Your password now', 'cur', 'password', 'autocomplete="current-password"')}${pwFields()}
          <label class="check"><input type="checkbox" name="others"> Sign out every other device</label>
          <button type="submit" class="btn wide">Change the password</button></form></details>
        <details><summary class="linkish">New security questions and recovery code</summary><form id="secRec">
          ${field('Your password', 'cur', 'password', 'autocomplete="current-password"')}${qRows()}
          <button type="submit" class="btn wide">Save and show the new code</button></form></details>
        <div id="secCode"></div></section>`);
      parts.push(`<section class="sec"><h3>Devices signed in</h3><ul class="devices" id="secDevices"><li>Loading…</li></ul>
        <div class="btn-row"><button type="button" class="btn quiet sm" data-sec="others">Sign out every other device</button>
          <button type="button" class="btn quiet sm" data-sec="here">Sign out this device</button></div>
        <p class="hint">A device that's signed out loses its copy of your data (the Sheet keeps it) at its next sync.</p></section>`);
      if (sy.role === 'owner') {
        parts.push(`<section class="sec"><h3>Family</h3>
          <p class="note">Each family member has their own name, password and portfolio, and sees only their own in SIPs. You see everyone's in your Google Sheet, with a Member column.</p>
          <ul class="devices" id="secMembers"><li>Loading…</li></ul>
          <div class="btn-row"><button type="button" class="btn quiet sm" data-sec="invite">${icon('plus')}Add a family member</button></div>
          <div id="secInvite"></div></section>`);
      }
    } else if (lk.on && canMake) {
      parts.push(`<section class="sec"><h3>Make your login</h3>
        <p class="note">One name and password for every device, kept by your Sheet's script. Use the password that opens this device, so it keeps opening it.</p>
        <form id="secMake">${nameField(lk.user)}${pwFields()}<p class="lbl">3 security questions <small>answers aren't stored anywhere</small></p>${qRows()}
          <button type="submit" class="btn wide">${icon('shield')}Make the login</button></form></section>`);
    }
    parts.push('<p class="hint" id="secMsg" role="status" aria-live="polite"></p>');
    body.innerHTML = parts.join('');

    $$('#secBody .qrow select').forEach(sel => sel.addEventListener('change', () => { sel.closest('.qrow').querySelectorAll('.field')[1].hidden = !!sel.value; }));
    if (lk.on) L.bioPossible().then(ok => { const b = $('#secBody [data-sec="bio"]'); if (b) b.hidden = !(ok || lk.bio); });
    if (signedIn) loadDevices();
    if (signedIn && sy.role === 'owner') loadMembers();
  }

  const msg = (t, bad) => { const m = $('#secMsg'); if (m) { m.textContent = t; m.classList.toggle('bad', !!bad); } };

  async function loadDevices() {
    const ul = $('#secDevices');
    try {
      const r = await S().call('devices', {});
      const when = ms => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      ul.innerHTML = r.devices.map(d => `<li><span>${esc(d.name)}${d.current ? ' <b>(this one)</b>' : ''}<small>Signed in ${when(d.created)} · last seen ${when(d.seen)}</small></span>
        ${d.current ? '' : `<button type="button" class="linkish danger" data-out="${esc(d.id)}">Sign out</button>`}</li>`).join('') || '<li>None</li>';
    } catch (e) { if (ul) ul.innerHTML = `<li class="bad">${esc(e.message)}</li>`; }
  }

  const when = ms => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  async function loadMembers() {
    const ul = $('#secMembers');
    try {
      const r = await S().call('members', {});
      ul.innerHTML = r.members.map(m => `<li><span>${esc(m.user)}${m.you ? ' <b>(you, the owner)</b>' : m.role === 'owner' ? ' (owner)' : ''}
          <small>${m.devices} device${m.devices === 1 ? '' : 's'} signed in${m.seen ? ` · last seen ${when(m.seen)}` : ''}</small></span>
          ${m.role === 'owner' ? '' : `<button type="button" class="linkish danger" data-member="${esc(m.user)}">Remove</button>`}</li>`).join('') +
        (r.kept || []).map(u => `<li><span>${esc(u)} <small>Removed. Their investments and plan are kept in your Sheet.</small></span>
          <span class="acts"><button type="button" class="linkish" data-reinvite="${esc(u)}">Invite again</button>
          <button type="button" class="linkish danger" data-erase="${esc(u)}">Erase</button></span></li>`).join('') +
        (r.invites.length ? `<li><span class="muted small">${r.invites.length} invite${r.invites.length === 1 ? '' : 's'} not used yet</span>
          <button type="button" class="linkish danger" data-sec="uninvite">Cancel ${r.invites.length === 1 ? 'it' : 'them'}</button></li>` : '');
    } catch (e) { if (ul) ul.innerHTML = `<li class="bad">${esc(e.message)}</li>`; }
  }

  /** The invite as a link that opens SIPs with the Sheet and the code filled in. */
  function inviteLink(url, code) {
    const u = btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${location.origin}${location.pathname}#join=${u}.${code.replace(/-/g, '')}`;
  }
  function showInvite(code, exp, user) {
    const link = inviteLink(S().status().url, code), until = new Date(exp).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    $('#secInvite').innerHTML = `<div class="code-box">
      ${user ? `<p><b>Send this to ${esc(user)}.</b> It works once, until ${esc(until)}, and only with the name ${esc(user)}: they choose a new password and PIN, and get their investments back.</p>`
        : `<p><b>Send this to the family member.</b> It works once, until ${esc(until)}. They open it on their phone or computer and choose their own name, password and PIN.</p>`}
      <label class="field"><span class="lbl">Invite link</span><span class="box"><input readonly id="secInviteLink" value="${esc(link)}"></span></label>
      <div class="btn-row"><button type="button" class="btn sm" data-sec="copy">Copy the link</button></div>
      <p class="hint">Or give them your Sheet's web app URL and this code: in SIPs they open Google Sheet, paste the URL, press Continue, and choose Join with an invite.</p>
      <p class="code">${esc(code)}</p></div>`;
  }

  /** Run a form's work with its button disabled and errors shown. */
  async function work(form, fn) {
    const btn = form && $('button[type="submit"]', form);
    if (btn) btn.disabled = true;
    busy = true;
    try { await fn(); }
    catch (e) { msg(e.message, true); }
    finally { busy = false; if (btn) btn.disabled = false; }
  }

  /** Make the login (with the secret), and lock this device if it isn't already. */
  async function makeLogin(f) {
    const user = userOf(f), pw = pwOf(f), { qs, as } = questionsOf(f), pin = L.on() ? null : pinOf(f);
    msg('Making your login… this takes a few seconds.');
    const code = L.newRecoveryCode();
    const [keys, rec] = await Promise.all([L.passwordKeys(user, pw), L.recoveryProof(user, as, code)]);
    const r = await S().call('register', { user, auth: keys.auth, rec, questions: qs, device: L.deviceName() });
    S().useSession(r.session, r.user, r.role);
    if (pin) await L.setup({ keys, pin, url: S().status().url }); else await L.rewrap(keys);
    busy = false; render();
    msg('Your login is made, and this device is signed in.');
    L.showCode($('#secCode') || $('#secBody'), code, () => { render(); msg('Done. On your other devices, open Google Sheet and sign in with your name and password.'); });
  }

  document.addEventListener('submit', e => {
    const f = e.target;
    if (!f.closest || !f.closest('#secBody')) return;
    e.preventDefault();
    if (f.id === 'secMake') work(f, () => makeLogin(f));
    else if (f.id === 'secLocal') work(f, async () => {
      const user = userOf(f), pw = pwOf(f), pin = pinOf(f);
      msg('Locking… this takes a few seconds.');
      await L.setup({ keys: await L.passwordKeys(user, pw), pin, url: null });
      busy = false; render(); msg('SIPs is locked with your PIN on this device.');
    });
    else if (f.id === 'secSetup') work(f, async () => {
      const pin = pinOf(f), st = S().status();
      let keys = heldKeys;
      if (!keys) {
        if (!f.pw.value) fail('Type your password.');
        msg('Checking your password…');
        keys = await L.passwordKeys(st.user, f.pw.value);
        const r = await S().callOpen('login', { user: keys.user, auth: keys.auth, device: L.deviceName() });
        try { await S().call('logout', {}); } catch (err) { /* the old session goes either way */ }
        S().useSession(r.session, r.user);
      }
      msg('Locking… this takes a few seconds.');
      await L.setup({ keys, pin, url: st.url });
      heldKeys = null;
      busy = false; render(); msg('SIPs is locked with your PIN on this device.');
    });
    else if (f.id === 'secRemove') work(f, async () => {
      const user = f.dataset.user, r = await S().call('removeMember', { user, erase: f.erase.checked });
      $('#secInvite').innerHTML = '';
      msg(f.erase.hidden ? `${r.removed}'s investments and plan are erased from the Sheet.`
        : `${r.removed} is removed and signed out.${f.erase.checked ? ' Their data is erased from the Sheet.' : ' Their data stays in the Sheet.'}`);
      loadMembers();
    });
    else if (f.id === 'secPinForm') work(f, async () => {
      const pin = pinOf(f);
      if (!(await L.checkPin(f.cur.value.trim()))) fail("That isn't your PIN now.");
      await L.setPin(pin);
      f.reset(); f.hidden = true; msg('Your new PIN is set.');
    });
    else if (f.id === 'secOffForm') work(f, async () => {
      if (!(await L.checkPin(f.cur.value.trim()))) fail("That isn't your PIN.");
      await L.turnOff();
      busy = false; render(); msg('The lock is off on this device.');
    });
    else if (f.id === 'secPw') work(f, async () => {
      const st = S().status(), pw = pwOf(f);
      msg('Changing your password…');
      const [cur, next] = await Promise.all([L.passwordKeys(st.user, f.cur.value), L.passwordKeys(st.user, pw)]);
      await S().call('changePassword', { auth: cur.auth, newAuth: next.auth, others: f.others.checked });
      await L.rewrap(next);
      f.reset(); f.closest('details').open = false;
      msg('Your password is changed.' + (f.others.checked ? ' Every other device is signed out.' : ' Your other devices ask for it the next time they need your password.'));
      loadDevices();
    });
    else if (f.id === 'secRec') work(f, async () => {
      const st = S().status(), { qs, as } = questionsOf(f);
      msg('Saving…');
      const code = L.newRecoveryCode();
      const [keys, rec] = await Promise.all([L.passwordKeys(st.user, f.cur.value), L.recoveryProof(st.user, as, code)]);
      await S().call('newRecovery', { auth: keys.auth, questions: qs, rec });
      f.reset(); f.closest('details').open = false; msg('');
      L.showCode($('#secCode'), code, () => { $('#secCode').innerHTML = ''; msg('Your new questions and recovery code are saved. The old code no longer works.'); });
    });
  });

  document.addEventListener('click', async e => {
    const b = e.target.closest('#secBody [data-sec], #secBody [data-out], #secBody [data-member], #secBody [data-reinvite], #secBody [data-erase]');
    if (!b || busy) return;
    const what = b.dataset.sec;
    if (b.dataset.member) {
      const u = esc(b.dataset.member);
      $('#secInvite').innerHTML = `<form id="secRemove" data-user="${u}" class="code-box">
        <p><b>Remove ${u}?</b> Their login goes and their devices are signed out. Their investments and plan stay in your Sheet, and come back when you choose Invite again next to their name.</p>
        <label class="check"><input type="checkbox" name="erase"> Also erase their investments and plan from the Sheet</label>
        <div class="btn-row"><button type="submit" class="btn sm danger">Remove ${u}</button><button type="button" class="btn quiet sm" data-sec="cancel">Cancel</button></div></form>`;
      return;
    }
    if (b.dataset.reinvite) {
      try { const r = await S().call('invite', { user: b.dataset.reinvite }); showInvite(r.code, r.exp, r.user); msg(''); loadMembers(); } catch (err) { msg(err.message, true); }
      return;
    }
    if (b.dataset.erase) {
      const u = esc(b.dataset.erase);
      $('#secInvite').innerHTML = `<form id="secRemove" data-user="${u}" class="code-box">
        <p><b>Erase ${u}'s investments and plan?</b> They go from your Sheet for good.</p>
        <input type="checkbox" name="erase" checked hidden>
        <div class="btn-row"><button type="submit" class="btn sm danger">Erase</button><button type="button" class="btn quiet sm" data-sec="cancel">Cancel</button></div></form>`;
      return;
    }
    if (what === 'cancel') { $('#secInvite').innerHTML = ''; return; }
    if (what === 'uninvite') {
      try { await S().call('cancelInvites', {}); $('#secInvite').innerHTML = ''; msg('Unused invites cancelled. Their links no longer work.'); loadMembers(); } catch (err) { msg(err.message, true); }
      return;
    }
    if (what === 'invite') {
      try { const r = await S().call('invite', {}); showInvite(r.code, r.exp); msg(''); loadMembers(); } catch (err) { msg(err.message, true); }
      return;
    }
    if (what === 'copy') {
      const box = $('#secInviteLink');
      try { await navigator.clipboard.writeText(box.value); msg('Copied the invite link.'); } catch (err) { box.select(); msg('Select the link and copy it.'); }
      return;
    }
    if (b.dataset.out) {
      try { await S().call('signOut', { which: b.dataset.out }); msg('That device is signed out.'); loadDevices(); } catch (err) { msg(err.message, true); }
    } else if (what === 'lock') L.lockNow('now');
    else if (what === 'pin') { const f = $('#secPinForm'); f.hidden = !f.hidden; if (!f.hidden) f.cur.focus(); }
    else if (what === 'off') { const f = $('#secOffForm'); f.hidden = !f.hidden; if (!f.hidden) f.cur.focus(); }
    else if (what === 'bio') {
      busy = true;
      let said = '', bad = false;
      try {
        if (L.status().bio) { L.removeBio(); said = 'Fingerprint or face no longer opens SIPs here.'; }
        else { msg('Follow your device\'s prompt…'); await L.addBio(); said = 'Your fingerprint or face now opens SIPs on this device.'; }
      } catch (err) { said = err.name === 'NotAllowedError' ? 'Cancelled.' : err.message; bad = true; }
      busy = false; render(); msg(said, bad);
    } else if (what === 'others') {
      try { const r = await S().call('signOut', { which: 'others' }); msg(`${r.signedOut} other device${r.signedOut === 1 ? '' : 's'} signed out.`); loadDevices(); } catch (err) { msg(err.message, true); }
    } else if (what === 'here') {
      if (!window.confirm('Sign out this device? Its copy of your data is removed; your Sheet keeps it.')) return;
      S().signOutHere();
    }
  });
  document.addEventListener('change', e => { if (e.target.id === 'secAfter') { L.setAfter(+e.target.value); msg('Saved.'); } });

  /* ---------- after signing in: the lock follows the password ---------- */
  document.addEventListener('mf:account', async e => {
    const d = e.detail || {};
    if (d.signedIn && d.keys) {
      if (L.on()) { const was = L.status().user; await L.rewrap(d.keys, !!was && was !== d.keys.user); L.noteSheet(S().status().url); }
      else { heldKeys = d.keys; setTimeout(() => { if (window.Shell) window.Shell.openPanel('panelSecurity'); }, 600); }
    }
    render(); note();
  });
  document.addEventListener('mf:panel', e => { if (e.detail.id === 'panelSecurity' && e.detail.open) render(); });

  /* ---------- Home: say so when this device needs to sign in ---------- */
  function note() {
    const box = $('#acctNote'), st = S() && S().status();
    $$('.lock-now').forEach(b => { b.hidden = !L.on(); });
    if (!box || !st) return;
    box.hidden = st.hold !== 'login' && st.hold !== 'secret';
    if (box.hidden) return;
    $('#acctNoteTitle').textContent = st.out ? 'This device was signed out' : st.hold === 'login' ? 'Sign in to keep syncing' : 'Connect again to keep syncing';
    $('#acctNoteText').textContent = st.out ? 'Its copy of your data was removed. Sign in to get it back from your Google Sheet.'
      : st.hold === 'login' ? 'Your Google Sheet now has a login. Sign in on this device with your name and password.'
      : 'The login on your Google Sheet was removed. Connect this device again with the secret.';
  }
  $$('.lock-now').forEach(b => b.addEventListener('click', () => L.lockNow('now')));

  /* ---------- joining a family's Sheet with an invite ---------- */
  function joinForm(host, { url, code, onCancel }) {
    host.hidden = false;
    host.innerHTML = `<form class="lock-form join-form">
      <h3>Join with an invite</h3>
      <p class="hint join-msg" aria-live="polite">You get your own name, password and portfolio in this family's Sheet. Nobody else sees your password.</p>
      ${field('Invite code', 'invite', 'text', `autocomplete="off" spellcheck="false" autocapitalize="characters" value="${esc(code ? code.slice(0, 5) + '-' + code.slice(5) : '')}"`)}
      ${nameField('')}${pwFields()}<p class="lbl">3 security questions <small>answers aren't stored anywhere</small></p>${qRows()}
      <button type="submit" class="btn wide">${icon('plus')}Join</button>
      ${onCancel ? '<button type="button" class="linkish" data-cancel>Back</button>' : ''}</form>`;
    const f = $('form', host), say = (t, bad) => { const m = $('.join-msg', host); m.textContent = t; m.classList.toggle('bad', !!bad); };
    $$('.qrow select', host).forEach(sel => sel.addEventListener('change', () => { sel.closest('.qrow').querySelectorAll('.field')[1].hidden = !!sel.value; }));
    if (onCancel) $('[data-cancel]', host).addEventListener('click', onCancel);
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = $('button[type="submit"]', f);
      btn.disabled = true;
      try {
        const invite = f.invite.value.trim(), user = userOf(f), pw = pwOf(f), { qs, as } = questionsOf(f);
        if (invite.replace(/[^0-9A-Za-z]/g, '').length !== 10) fail('Type the whole invite code: 10 letters and digits.');
        say('Joining… this takes a few seconds.');
        const recCode = L.newRecoveryCode();
        const [keys, rec] = await Promise.all([L.passwordKeys(user, pw), L.recoveryProof(user, as, recCode)]);
        const r = await S().join(url, { invite, user, auth: keys.auth, rec, questions: qs });
        L.showCode(host, recCode, async () => {
          host.innerHTML = '<p class="hint">Signing you in…</p>';
          try {
            const text = await S().enter(url, r, keys);
            host.innerHTML = `<p class="hint">${esc(text)}</p>`;
            document.dispatchEvent(new CustomEvent('mf:account', { detail: { signedIn: true, keys, joined: true } }));
          } catch (err) { host.innerHTML = `<p class="hint bad">${esc(err.message)}</p>`; }
        });
      } catch (err) { say(err.message, true); }
      finally { btn.disabled = false; }
    });
    setTimeout(() => (code ? f.user : f.invite).focus(), 0);
  }

  /** An invite link: #join=<the web app URL, base64url>.<the code>. It opens the join form. */
  (function joinLink() {
    const m = /^#join=([A-Za-z0-9_-]+)\.([0-9A-Za-z]{10})$/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search + '#home');
    let url = '';
    try { url = S().checkUrl(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return; }
    const open = () => {
      if (!window.Shell) { setTimeout(open, 50); return; }
      window.Shell.openPanel('panelSheet');
      $('#syncUrl').value = url;
      ['#syncNext', '#syncSecretBox', '#syncLoginBox', '#syncRec'].forEach(sel => { $(sel).hidden = true; });
      joinForm($('#syncJoin'), { url, code: m[2].toUpperCase() });
    };
    open();
  })();

  window.Security = { joinForm };
  note();
  render();
})();
