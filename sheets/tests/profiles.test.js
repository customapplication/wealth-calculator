/* Tests for family profiles (v4) in sheets/Code.gs, against the in-memory
   Google services in fake-google.js: node --test sheets/tests/*.test.js
   The owner invites members; each has their own login and their own data, and
   the Sheet's tabs show everyone's with a Member column. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { load } = require('./fake-google');

const SECRET = 'test-secret-0123456789';
const proof = () => crypto.randomBytes(32).toString('base64url');
const Q = ['Which city was your first school in?', 'What was your first pet called?', "What is your oldest cousin's first name?"];
const holding = (id, name, amount = 1000) => ({ c: 'holdings', id, at: Date.now(), data: { id, kind: 'sip', code: 1, name, amount, day: 5, start: '2024-01', end: null, step: 0 } });
const plan = sip => ({ c: 'settings', id: 'plan', at: Date.now(), data: { monthlySip: sip, sipYears: 20, rates: [12] } });
const snapshot = (value, net) => ({ c: 'snapshot', id: 'latest', at: Date.now(), data: { navDate: '2026-09-25', rows: [{ name: 'A fund', kind: 'sip', units: 10, net, value, gain: value - net, xirr: 0.1, navDate: '2026-09-25' }], totals: { net, value, gain: value - net, xirr: 0.1 } } });

function family() {
  const g = load({ SECRET });
  const owner = { auth: proof(), rec: proof() };
  const r = g.post({ action: 'register', secret: SECRET, user: 'Priya', auth: owner.auth, rec: owner.rec, questions: Q, device: 'Priya laptop' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.role, 'owner');
  owner.session = r.session;
  g.join = (name, over = {}, forName) => {
    const code = g.post({ action: 'invite', session: owner.session, user: forName }).code;
    const m = { auth: proof(), rec: proof() };
    const j = g.post(Object.assign({ action: 'join', invite: code, user: name, auth: m.auth, rec: m.rec, questions: Q, device: name + ' phone' }, over));
    return Object.assign(m, j, { code });
  };
  g.sync = (session, changes = [], since = 0, epoch = null) => g.post({ action: 'sync', session, epoch, since, changes });
  return { g, owner };
}

test('an owner invites a family member, who joins with the code once', () => {
  const { g, owner } = family();
  const inv = g.post({ action: 'invite', session: owner.session });
  assert.match(inv.code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.ok(inv.exp - Date.now() > 6.9 * 86400e3, 'good for 7 days');
  assert.ok(!g.properties.getProperty('invites').includes(inv.code.replace('-', '')), 'only its hash is kept');

  let r = g.post({ action: 'join', invite: 'WRONG-CODE0', user: 'Asha', auth: proof(), rec: proof(), questions: Q });
  assert.equal(r.badInvite, true);
  r = g.post({ action: 'join', invite: inv.code.toLowerCase().replace('-', ' '), user: 'Priya', auth: proof(), rec: proof(), questions: Q });
  assert.match(r.error, /already has that name/, 'names are unique');
  const asha = { auth: proof(), rec: proof() };
  r = g.post({ action: 'join', invite: inv.code.toLowerCase().replace('-', ' '), user: 'Asha', auth: asha.auth, rec: asha.rec, questions: Q, device: 'Asha phone' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([r.user, r.role], ['asha', 'member']);
  assert.match(g.post({ action: 'join', invite: inv.code, user: 'Ravi', auth: proof(), rec: proof(), questions: Q }).error, /already used/, 'an invite works once');
  assert.equal(g.post({ action: 'login', user: 'asha', auth: asha.auth }).role, 'member');
  assert.match(g.post({ action: 'join', invite: g.post({ action: 'invite', session: owner.session }).code, user: 'bad|name', auth: proof(), rec: proof(), questions: Q }).error, /name of 3 to 40/);
});

test('only the owner can invite, list or remove members', () => {
  const { g, owner } = family();
  const asha = g.join('Asha');
  assert.equal(g.post({ action: 'invite', session: asha.session }).notOwner, true);
  assert.equal(g.post({ action: 'members', session: asha.session }).notOwner, true);
  assert.equal(g.post({ action: 'removeMember', session: asha.session, user: 'priya' }).notOwner, true);
  const r = g.post({ action: 'members', session: owner.session });
  assert.deepEqual(r.members.map(m => [m.user, m.role, m.devices, m.you]), [['priya', 'owner', 1, true], ['asha', 'member', 1, false]]);
  assert.match(g.post({ action: 'removeMember', session: owner.session, user: 'priya' }).error, /owner can't be removed/);
  // an invite can't be made without a login, and an old invite runs out
  const s = load({ SECRET });
  assert.equal(s.post({ action: 'invite', secret: SECRET }).notOwner, true);
  const all = JSON.parse(g.properties.getProperty('invites') || '{}');
  const code = g.post({ action: 'invite', session: owner.session }).code;
  const inv = JSON.parse(g.properties.getProperty('invites'));
  Object.keys(inv).filter(h => !(h in all)).forEach(h => { inv[h].exp = Date.now() - 1; });
  g.properties.setProperty('invites', JSON.stringify(inv));
  assert.match(g.post({ action: 'join', invite: code, user: 'Ravi', auth: proof(), rec: proof(), questions: Q }).error, /isn't right, or it was already used/);
});

test('the owner can cancel the invites nobody has used', () => {
  const { g, owner } = family();
  const a = g.post({ action: 'invite', session: owner.session }).code, b = g.post({ action: 'invite', session: owner.session }).code;
  assert.equal(g.post({ action: 'members', session: owner.session }).invites.length, 2);
  const asha = g.join('Asha');
  assert.equal(g.post({ action: 'cancelInvites', session: asha.session }).notOwner, true, 'a member cannot');
  const r = g.post({ action: 'cancelInvites', session: owner.session });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.invites.length, 0);
  for (const code of [a, b]) {
    assert.equal(g.post({ action: 'join', invite: code, user: 'Ravi', auth: proof(), rec: proof(), questions: Q }).badInvite, true);
  }
  assert.equal(g.post({ action: 'login', user: 'asha', auth: asha.auth }).ok, true, 'members who joined stay');
});

test("each person syncs only their own records, even with the same ids", () => {
  const { g, owner } = family();
  const asha = g.join('Asha');
  let r = g.sync(owner.session, [holding('x', 'Owner fund'), plan(30000)]);
  assert.equal(r.ok, true, r.error);
  r = g.sync(asha.session, [holding('x', 'Asha fund', 500), plan(5000)]);
  assert.deepEqual(r.changes.map(c => c.data.name || c.data.monthlySip).sort(), [5000, 'Asha fund'], "Asha sees only hers");
  r = g.sync(owner.session);
  assert.deepEqual(r.changes.map(c => c.data.name || c.data.monthlySip).sort(), [30000, 'Owner fund'], "and the owner only theirs");
  const keys = g.ss.getSheetByName('_data').dump().slice(1).map(row => row[0]).sort();
  assert.deepEqual(keys, ['@asha|holdings/x', '@asha|settings/plan', 'holdings/x', 'settings/plan']);
  // a removal is only ever of your own record
  g.sync(asha.session, [{ c: 'holdings', id: 'x', at: Date.now() + 5, del: 1 }]);
  assert.equal(g.sync(owner.session).changes.find(c => c.id === 'x').del, 0, "the owner's x is untouched");
});

test("the tabs show everyone's, with a Member column, a plan column each and a family total", () => {
  const { g, owner } = family();
  const asha = g.join('Asha');
  g.sync(owner.session, [holding('a', 'Owner fund', 2000), plan(30000), snapshot(150000, 100000)]);
  g.sync(asha.session, [holding('b', 'Asha fund', 500), plan(5000), snapshot(12000, 10000)]);
  const inv = g.ss.getSheetByName('Investments').dump();
  assert.deepEqual(inv[0].slice(0, 2), ['Member', 'Fund']);
  assert.deepEqual(inv.slice(1).map(r => [r[0], r[1]]), [['priya', 'Owner fund'], ['asha', 'Asha fund']], 'the owner first');
  const planTab = g.ss.getSheetByName('Plan').dump();
  assert.deepEqual(planTab[0], ['Setting', 'priya', 'asha']);
  assert.deepEqual(planTab.find(r => r[0] === 'Monthly SIP today (₹)'), ['Monthly SIP today (₹)', 30000, 5000]);
  const pf = g.ss.getSheetByName('Portfolio').dump();
  assert.deepEqual(pf.find(r => r[1] === 'Total for asha').slice(4, 6), [10000, 12000]);
  const fam = pf.find(r => r[0] === 'Family');
  assert.deepEqual([fam[4], fam[5], fam[6], fam[7]], [110000, 162000, 52000, ''], 'sums, and no made-up family XIRR');
});

test('with only the owner, the tabs keep their old columns', () => {
  const { g, owner } = family();
  g.sync(owner.session, [holding('a', 'Owner fund', 2000), plan(30000)]);
  assert.equal(g.ss.getSheetByName('Investments').dump()[0][0], 'Fund');
  assert.deepEqual(g.ss.getSheetByName('Plan').dump()[0], ['Setting', 'Value']);
});

test("devices, sign-outs and wrong tries are each person's own", () => {
  const { g, owner } = family();
  const asha = g.join('Asha');
  const tablet = g.post({ action: 'login', user: 'asha', auth: asha.auth, device: 'Asha tablet' }).session;
  let r = g.post({ action: 'devices', session: asha.session });
  assert.deepEqual(r.devices.map(d => d.name).sort(), ['Asha phone', 'Asha tablet']);
  r = g.post({ action: 'signOut', session: asha.session, which: 'others' });
  assert.equal(r.signedOut, 1);
  assert.equal(g.sync(tablet).signedOut, true);
  assert.equal(g.sync(owner.session).ok, true, "the owner's devices aren't touched");
  for (let i = 0; i < 5; i++) g.post({ action: 'login', user: 'asha', auth: proof() });
  assert.ok(g.post({ action: 'login', user: 'asha', auth: asha.auth }).wait > 0, "Asha's logins pause");
  assert.equal(g.post({ action: 'login', user: 'priya', auth: owner.auth }).ok, true, "the owner's don't");
  // a member's recovery signs out only that member's devices
  const newAuth = proof(), newRec = proof();
  r = g.post({ action: 'recover', user: 'asha', rec: asha.rec, newAuth, newRec, device: 'Asha new phone' });
  assert.equal(r.ok, true, r.error);
  assert.equal(g.sync(asha.session).signedOut, true);
  assert.equal(g.sync(owner.session).ok, true);
});

test('removing a member signs them out and keeps their data, unless it is erased too', () => {
  const { g, owner } = family();
  const asha = g.join('Asha');
  const ravi = g.join('Ravi');
  g.sync(asha.session, [holding('b', 'Asha fund')]);
  g.sync(ravi.session, [holding('c', 'Ravi fund')]);
  let r = g.post({ action: 'removeMember', session: owner.session, user: 'Asha' });
  assert.equal(r.removed, 'asha');
  assert.equal(g.sync(asha.session).signedOut, true);
  assert.equal(g.post({ action: 'login', user: 'asha', auth: asha.auth }).badLogin, true);
  assert.ok(g.ss.getSheetByName('Investments').dump().some(row => row[0] === 'asha'), 'her data stays in the Sheet');
  assert.deepEqual(g.post({ action: 'members', session: owner.session }).kept, ['asha'], 'kept under her name');
  assert.match(g.join('Asha').error, /kept in this Sheet under that name/, 'a plain invite cannot take a kept name');
  assert.match(g.join('Meera', {}, 'asha').error, /This invite is for asha/, 'an invite for a name works only with it');
  const back = g.join('Asha', {}, 'asha');
  assert.equal(back.ok, true, back.error);
  assert.deepEqual(g.sync(back.session).changes.map(c => c.data.name), ['Asha fund'], 'invited again for her name, she gets it back');
  assert.deepEqual(g.post({ action: 'members', session: owner.session }).kept, []);

  r = g.post({ action: 'removeMember', session: owner.session, user: 'ravi', erase: true });
  assert.deepEqual(r.members.map(m => m.user), ['priya', 'asha']);
  const keys = g.ss.getSheetByName('_data').dump().slice(1).map(row => row[0]);
  assert.ok(!keys.some(k => k.startsWith('@ravi|')), "Ravi's records are erased");
  assert.ok(!g.ss.getSheetByName('Investments').dump().some(row => row[0] === 'ravi'));
  assert.equal(g.sync(back.session).changes.length, 1, "and Asha's are still there");

  // someone already removed: their kept data can be erased later
  g.post({ action: 'removeMember', session: owner.session, user: 'asha' });
  assert.match(g.post({ action: 'removeMember', session: owner.session, user: 'asha' }).error, /no one called asha/, 'removing twice needs erase');
  r = g.post({ action: 'removeMember', session: owner.session, user: 'asha', erase: true });
  assert.equal(r.removed, 'asha');
  assert.deepEqual(r.kept, []);
  assert.equal(g.join('Asha').ok, true, 'the name is free again, with nothing in it');
});

test("the owner's new login can't take a name whose data is kept", () => {
  const { g, owner } = family();
  const asha = g.join('Asha');
  g.sync(asha.session, [holding('b', 'Asha fund')]);
  g.ctx.REMOVE_LOGIN();
  const r = g.post({ action: 'register', secret: SECRET, user: 'Asha', auth: proof(), rec: proof(), questions: Q });
  assert.match(r.error, /kept in this Sheet under that name/);
  assert.equal(g.post({ action: 'register', secret: SECRET, user: 'Priya', auth: owner.auth, rec: owner.rec, questions: Q }).ok, true);
});

test("a v3 Sheet's login becomes the owner's, and its devices and data carry on", () => {
  const g = load({ SECRET });
  const auth = proof(), rec = proof();
  const hash = s => crypto.createHash('sha256').update(s).digest('hex');
  const tok = 'a'.repeat(64);
  g.properties.setProperty('account', JSON.stringify({ user: 'priya', auth: hash(auth), rec: hash(rec), q: Q, created: 1, changed: 1 }));
  g.properties.setProperty('sessions', JSON.stringify({ [hash(tok)]: { n: 'Old laptop', c: 1, s: Date.now() } }));
  let r = g.post({ action: 'sync', session: tok, epoch: null, since: 0, changes: [holding('a', 'Owner fund')] });
  assert.equal(r.ok, true, r.error);
  assert.equal(g.properties.getProperty('account'), null, 'moved');
  assert.equal(JSON.parse(g.properties.getProperty('acct:priya')).role, 'owner');
  assert.equal(g.ss.getSheetByName('_data').dump()[1][0], 'holdings/a', "the owner's keys are as before");
  assert.equal(g.post({ action: 'login', user: 'priya', auth }).role, 'owner');
  assert.equal(g.post({ action: 'invite', session: tok }).ok, true, 'and the owner can invite');
});

test("the menu's Remove the login removes everyone's; their data stays", () => {
  const { g, owner } = family();
  const asha = g.join('Asha');
  g.sync(asha.session, [holding('b', 'Asha fund')]);
  g.ctx.REMOVE_LOGIN();
  assert.equal([...g.properties.m.keys()].filter(k => k.startsWith('acct:')).length, 0);
  assert.equal(g.post({ action: 'hello' }).account, false);
  assert.equal(g.sync(owner.session).noAccount, true);
  assert.ok(g.ss.getSheetByName('_data').dump().some(row => row[0] === '@asha|holdings/b'));
});
