/* Tests for the login (v3) and the fund data update in sheets/Code.gs, against
   the in-memory Google services in fake-google.js: node --test sheets/tests/*.test.js
   The site derives its proofs from a name and password; here they're random
   32-byte values, which is all the script sees. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { load } = require('./fake-google');

const SECRET = 'test-secret-0123456789';
const proof = () => crypto.randomBytes(32).toString('base64url');
const Q = ['Which city was your first school in?', 'What was your first pet called?', 'What is your oldest cousin\'s first name?'];

function setup(props = { SECRET }) {
  const g = load(props);
  g.register = (over = {}) => {
    const auth = proof(), rec = proof();
    const r = g.post(Object.assign({ action: 'register', secret: SECRET, user: '  Family  Account ', auth, rec, questions: Q, device: 'Chrome on a laptop' }, over));
    return Object.assign(r, { auth, rec });
  };
  return g;
}
const holding = id => ({ c: 'holdings', id, at: Date.now(), data: { id, kind: 'sip', code: 1, name: 'Fund ' + id, amount: 1000, day: 5, start: '2024-01', end: null, step: 0 } });

test('hello says only whether there is a login, and needs nothing', () => {
  assert.equal(load({}).post({ action: 'hello' }).setup, true);
  const g = setup();
  let r = g.post({ action: 'hello' });
  assert.deepEqual([r.ok, r.version, r.account, r.setup], [true, 3, false, false]);
  g.register();
  r = g.post({ action: 'hello' });
  assert.equal(r.account, true);
  assert.ok(!JSON.stringify(r).includes('family'), 'the name is not given out');
});

test('making the login needs the secret, and then the secret alone no longer opens the data', () => {
  const g = setup();
  assert.equal(g.register({ secret: 'wrong-secret-000000000' }).badSecret, true);
  assert.match(g.register({ questions: [Q[0], Q[0], Q[1]] }).error, /3 different/);
  assert.match(g.register({ user: 'x' }).error, /name of 3 to 40/);
  assert.match(g.register({ auth: 'short' }).error, /incomplete/);
  assert.equal(g.properties.getProperty('account'), null, 'nothing kept from refused attempts');

  const r = g.register();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.user, 'family account', 'trimmed, lower case, single spaces');
  assert.match(r.session, /^[0-9a-f]{64}$/);
  assert.equal(g.register().hasAccount, true, 'only one login per Sheet');

  const stored = g.properties.getProperty('account') + g.properties.getProperty('sessions');
  for (const s of [r.auth, r.rec, r.session]) assert.ok(!stored.includes(s), 'only hashes are stored');

  let s = g.post({ action: 'sync', secret: SECRET, changes: [holding('a')] });
  assert.equal(s.login, true);
  assert.equal(g.ss.getSheetByName('_data'), null, 'nothing written with the secret alone');
  s = g.post({ action: 'sync', session: r.session, changes: [holding('a')] });
  assert.equal(s.ok, true, s.error);
  assert.equal(s.changes.length, 1);
  assert.equal(g.post({ action: 'ping', session: r.session }).user, 'family account');
});

test('signing in: the right name and password, 5 wrong tries pause it, and a right one clears the count', () => {
  const g = setup();
  const acct = g.register();
  let r = g.post({ action: 'login', user: 'FAMILY ACCOUNT', auth: acct.auth, device: 'Phone' });
  assert.equal(r.ok, true, 'the name in any case');
  const phone = r.session;
  assert.notEqual(phone, acct.session);

  for (let i = 1; i <= 4; i++) {
    r = g.post({ action: 'login', user: 'family account', auth: proof() });
    assert.equal(r.badLogin, true); assert.equal(r.left, 5 - i); assert.equal(r.wait, 0);
  }
  assert.match(r.error, /1 more try/);
  r = g.post({ action: 'login', user: 'someone else', auth: acct.auth });
  assert.equal(r.badLogin, true, 'a wrong name counts too');
  assert.ok(r.wait > 14 * 60 && r.wait <= 15 * 60, 'the fifth wrong try pauses logins for 15 minutes');
  r = g.post({ action: 'login', user: 'family account', auth: acct.auth });
  assert.equal(r.ok, false, 'even the right password waits');
  assert.match(r.error, /Try again in 15 minutes/);
  assert.equal(g.post({ action: 'sync', session: phone }).ok, true, 'devices already signed in carry on');

  const guard = JSON.parse(g.properties.getProperty('guard'));
  guard.login.until = Date.now() - 1;
  g.properties.setProperty('guard', JSON.stringify(guard));
  r = g.post({ action: 'login', user: 'family account', auth: proof() });
  assert.ok(r.wait > 29 * 60 && r.wait <= 30 * 60, 'the next wrong try pauses twice as long');
  guard.login.until = Date.now() - 1; guard.login.n = 5;
  g.properties.setProperty('guard', JSON.stringify(guard));
  assert.equal(g.post({ action: 'login', user: 'family account', auth: acct.auth }).ok, true);
  assert.equal(JSON.parse(g.properties.getProperty('guard')).login, undefined, 'the count is cleared');
});

test('forgot the password: the answers and recovery code set a new one, once, and sign out every device', () => {
  const g = setup();
  const acct = g.register();
  const phone = g.post({ action: 'login', user: 'family account', auth: acct.auth, device: 'Phone' }).session;
  let r = g.post({ action: 'questions', user: 'Family Account' });
  assert.deepEqual(r.questions, Q);
  assert.match(g.post({ action: 'questions', user: 'nobody here' }).error, /no login with that name/);

  const newAuth = proof(), newRec = proof();
  r = g.post({ action: 'recover', user: 'family account', rec: proof(), newAuth, newRec });
  assert.equal(r.badRecovery, true); assert.equal(r.left, 2);
  r = g.post({ action: 'recover', user: 'family account', rec: acct.rec, newAuth, newRec, device: 'New phone' });
  assert.equal(r.ok, true, r.error);
  const fresh = r.session;

  assert.equal(g.post({ action: 'sync', session: phone }).signedOut, true, 'the other devices are signed out');
  assert.equal(g.post({ action: 'sync', session: acct.session }).signedOut, true);
  assert.equal(g.post({ action: 'sync', session: fresh }).ok, true);
  assert.equal(g.post({ action: 'login', user: 'family account', auth: acct.auth }).badLogin, true, 'the old password is gone');
  assert.equal(g.post({ action: 'login', user: 'family account', auth: newAuth }).ok, true);
  r = g.post({ action: 'recover', user: 'family account', rec: acct.rec, newAuth: proof(), newRec: proof() });
  assert.equal(r.badRecovery, true, 'a recovery code works once');
});

test('3 wrong recovery tries pause recovery for an hour', () => {
  const g = setup();
  const acct = g.register();
  let r;
  for (let i = 0; i < 3; i++) r = g.post({ action: 'recover', user: 'family account', rec: proof(), newAuth: proof(), newRec: proof() });
  assert.ok(r.wait > 59 * 60 && r.wait <= 3600);
  r = g.post({ action: 'recover', user: 'family account', rec: acct.rec, newAuth: proof(), newRec: proof() });
  assert.equal(r.ok, false);
  assert.match(r.error, /Try again in 60 minutes/);
});

test('devices: listed by name, the others signed out, and this one signs out itself', () => {
  const g = setup();
  const acct = g.register();
  const phone = g.post({ action: 'login', user: 'family account', auth: acct.auth, device: 'Phone' }).session;
  g.post({ action: 'login', user: 'family account', auth: acct.auth, device: 'Tablet' });
  let r = g.post({ action: 'devices', session: phone });
  assert.deepEqual(r.devices[0], Object.assign({}, r.devices[0], { name: 'Phone', current: true }), 'this device first');
  assert.deepEqual(r.devices.slice(1).map(d => [d.name, d.current]).sort(), [['Chrome on a laptop', false], ['Tablet', false]]);
  assert.ok(r.devices.every(d => /^[0-9a-f]{12}$/.test(d.id)));

  r = g.post({ action: 'signOut', session: phone, which: r.devices.find(d => d.name === 'Tablet').id });
  assert.equal(r.signedOut, 1);
  r = g.post({ action: 'signOut', session: phone, which: 'others' });
  assert.equal(r.signedOut, 1);
  assert.deepEqual(r.devices.map(d => d.name), ['Phone']);
  assert.equal(g.post({ action: 'sync', session: acct.session }).signedOut, true);
  assert.equal(g.post({ action: 'logout', session: phone }).ok, true);
  assert.equal(g.post({ action: 'sync', session: phone }).signedOut, true);
});

test('a new password needs the current one; new questions and code too', () => {
  const g = setup();
  const acct = g.register();
  const phone = g.post({ action: 'login', user: 'family account', auth: acct.auth, device: 'Phone' }).session;
  const next = proof();
  assert.equal(g.post({ action: 'changePassword', session: acct.session, auth: proof(), newAuth: next }).badLogin, true);
  assert.equal(g.post({ action: 'changePassword', session: acct.session, auth: acct.auth, newAuth: next }).ok, true);
  assert.equal(g.post({ action: 'sync', session: phone }).ok, true, 'other devices stay in unless asked');
  assert.equal(g.post({ action: 'login', user: 'family account', auth: next }).ok, true);
  const again = proof();
  assert.equal(g.post({ action: 'changePassword', session: acct.session, auth: next, newAuth: again, others: true }).ok, true);
  assert.equal(g.post({ action: 'sync', session: phone }).signedOut, true);

  const rec = proof(), q = ['Where did your parents meet?', Q[1], Q[2]];
  assert.equal(g.post({ action: 'newRecovery', session: acct.session, auth: next, questions: q, rec }).badLogin, true);
  assert.equal(g.post({ action: 'newRecovery', session: acct.session, auth: again, questions: q, rec }).ok, true);
  assert.deepEqual(g.post({ action: 'questions', user: 'family account' }).questions, q);
  assert.equal(g.post({ action: 'recover', user: 'family account', rec: acct.rec, newAuth: proof(), newRec: proof() }).badRecovery, true);
  assert.equal(g.post({ action: 'recover', user: 'family account', rec, newAuth: proof(), newRec: proof() }).ok, true);
});

test("the Sheet's owner can sign out every device, or remove the login", () => {
  const g = setup();
  const acct = g.register();
  g.ctx.SIGN_OUT_EVERY_DEVICE();
  assert.equal(g.post({ action: 'sync', session: acct.session }).signedOut, true);
  const s = g.post({ action: 'login', user: 'family account', auth: acct.auth }).session;
  g.ctx.REMOVE_LOGIN();
  assert.equal(g.post({ action: 'sync', session: s }).noAccount, true, 'the device is told to connect with the secret');
  assert.equal(g.post({ action: 'sync', secret: SECRET }).ok, true, 'the secret works again');
  assert.equal(g.post({ action: 'hello' }).account, false);
});

test('a session that has not been used for 400 days is signed out', () => {
  const g = setup();
  const acct = g.register();
  const all = JSON.parse(g.properties.getProperty('sessions'));
  Object.values(all).forEach(v => { v.s = Date.now() - 401 * 86400000; });
  g.properties.setProperty('sessions', JSON.stringify(all));
  assert.equal(g.post({ action: 'sync', session: acct.session }).signedOut, true);
});

/* ---------- fund data: starting the nightly workflow on GitHub ---------- */

function github(g, { state = 'active', runs = [], codes = {} } = {}) {
  g.web.handler = ({ url, method }) => {
    const path = url.replace('https://api.github.com', '');
    if (codes[method + ' ' + path]) return { code: codes[method + ' ' + path], body: { message: 'nope' } };
    if (method === 'get' && path === '/repos/o/r/actions/workflows/nightly.yml') return { code: 200, body: { state } };
    if (method === 'get' && path === '/repos/o/r/actions/workflows/nightly.yml/runs?per_page=10') return { code: 200, body: { workflow_runs: runs } };
    if (method === 'put' && path === '/repos/o/r/actions/workflows/nightly.yml/enable') return { code: 204 };
    if (method === 'post' && path === '/repos/o/r/actions/workflows/nightly.yml/dispatches') return { code: 204 };
    return { code: 404, body: { message: 'Not Found' } };
  };
}
const run = (hoursAgo, status = 'completed', conclusion = 'success') => {
  const t = new Date(Date.now() - hoursAgo * 3600e3).toISOString();
  return { status, conclusion, event: 'schedule', created_at: t, updated_at: t, html_url: 'https://github.com/o/r/actions/runs/1' };
};
const calls = g => g.fetches.map(f => `${f.method} ${f.url.replace('https://api.github.com/repos/o/r/actions/workflows/nightly.yml', '')}`);

test('without a token the site is told how to set it up; the repository comes from GITHUB_REPO or the site', () => {
  const g = setup();
  let r = g.post({ action: 'dataStatus', secret: SECRET });
  assert.deepEqual(r.github, { configured: false });
  assert.match(g.post({ action: 'dataRefresh', secret: SECRET }).error, /GITHUB_TOKEN/);
  assert.equal(g.fetches.length, 0);

  g.properties.setProperty('GITHUB_TOKEN', 'github_pat_TEST');
  github(g);
  assert.match(g.post({ action: 'dataStatus', secret: SECRET }).github.error, /GITHUB_REPO/);
  r = g.post({ action: 'dataStatus', secret: SECRET, repo: 'o/r' });
  assert.equal(r.github.repo, 'o/r');
  assert.equal(g.properties.getProperty('repo'), 'o/r', 'kept for the daily check');
  assert.equal(g.post({ action: 'dataStatus', secret: SECRET, repo: 'not a repo!' }).github.repo, 'o/r');
  assert.equal(g.fetches[0].headers.Authorization, 'Bearer github_pat_TEST');
  g.properties.setProperty('GITHUB_REPO', 'x/y');
  assert.equal(g.post({ action: 'dataStatus', secret: SECRET, repo: 'o/r' }).github.repo, 'x/y', 'GITHUB_REPO wins');
});

test('Update now: switches a paused workflow back on and starts it, but not twice', () => {
  const g = setup({ SECRET, GITHUB_TOKEN: 't', GITHUB_REPO: 'o/r' });
  github(g, { state: 'disabled_inactivity', runs: [run(70 * 24)] });
  let r = g.post({ action: 'dataRefresh', secret: SECRET });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([r.started, r.enabled], [true, true]);
  assert.deepEqual(calls(g), ['get ', 'get /runs?per_page=10', 'put /enable', 'post /dispatches']);
  assert.deepEqual(g.fetches[3].payload, { ref: 'main' });

  g.fetches.length = 0;
  github(g, { runs: [run(0.05, 'in_progress', null), run(24)] });
  r = g.post({ action: 'dataRefresh', secret: SECRET });
  assert.deepEqual([r.ok, r.started, r.reason], [true, false, 'running']);
  assert.equal(r.github.lastOk > 0, true);
  github(g, { runs: [run(0.1)] });
  assert.equal(g.post({ action: 'dataRefresh', secret: SECRET }).reason, 'recent');
  github(g, { state: 'disabled_manually', runs: [run(30)] });
  r = g.post({ action: 'dataRefresh', secret: SECRET });
  assert.equal(r.started, true, 'pressing the button switches even a hand-disabled workflow on');
});

test('GitHub errors are explained', () => {
  const g = setup({ SECRET, GITHUB_TOKEN: 't', GITHUB_REPO: 'o/r' });
  github(g, { codes: { 'get /repos/o/r/actions/workflows/nightly.yml': 401 } });
  assert.match(g.post({ action: 'dataStatus', secret: SECRET }).github.error, /refused the token/);
  github(g, { runs: [run(30)], codes: { 'post /repos/o/r/actions/workflows/nightly.yml/dispatches': 403 } });
  assert.match(g.post({ action: 'dataRefresh', secret: SECRET }).error, /Actions: Read and write/);
  github(g, { codes: { 'get /repos/o/r/actions/workflows/nightly.yml': 404 } });
  assert.match(g.post({ action: 'dataStatus', secret: SECRET }).github.error, /couldn't find o\/r/);
});

test('the daily check: back on after a pause, a run when the last good one is old, hands off a workflow turned off by hand', () => {
  const g = setup({ SECRET, GITHUB_TOKEN: 't', GITHUB_REPO: 'o/r' });
  github(g, { runs: [run(3)] });
  assert.match(g.ctx.checkNightly(), /All well/);
  assert.deepEqual(calls(g), ['get ', 'get /runs?per_page=10']);

  g.fetches.length = 0;
  github(g, { state: 'disabled_inactivity', runs: [run(3)] });
  assert.match(g.ctx.checkNightly(), /Switched the paused workflow back on/);
  assert.deepEqual(calls(g).slice(2), ['put /enable'], 'no extra run when the data is fresh');

  g.fetches.length = 0;
  github(g, { state: 'disabled_inactivity', runs: [run(30)] });
  assert.equal(g.ctx.checkNightly(), 'Switched the paused workflow back on. Started a data update.');
  assert.deepEqual(calls(g).slice(2), ['put /enable', 'post /dispatches']);

  g.fetches.length = 0;
  github(g, { state: 'disabled_manually', runs: [run(30)] });
  assert.match(g.ctx.checkNightly(), /turned off on GitHub by hand/);
  assert.deepEqual(calls(g).slice(2), []);
  assert.match(JSON.parse(g.properties.getProperty('watch')).did, /by hand/);
  assert.match(g.post({ action: 'dataStatus', secret: SECRET }).github.watch.did, /by hand/, 'the site can show the last check');

  g.ctx.KEEP_NIGHTLY(); g.ctx.KEEP_NIGHTLY();
  assert.equal(g.triggers.length, 1, 'one daily trigger, however often it is switched on');
  assert.deepEqual(g.triggers[0].spec, { fn: 'checkNightly', days: 1, hour: 5 });
  assert.equal(g.post({ action: 'dataStatus', secret: SECRET }).github.checking, true);
  g.ctx.STOP_NIGHTLY_CHECK();
  assert.equal(g.triggers.length, 0);
});

test('with a login, the data update needs a signed-in device too', () => {
  const g = setup({ SECRET, GITHUB_TOKEN: 't', GITHUB_REPO: 'o/r' });
  github(g, { runs: [run(30)] });
  const acct = g.register();
  assert.equal(g.post({ action: 'dataRefresh', secret: SECRET }).login, true);
  assert.equal(g.post({ action: 'dataRefresh', session: acct.session }).started, true);
});
