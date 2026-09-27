/* Tests for sheets/Code.gs, run against the in-memory Google services in
   fake-google.js:  node --test sheets/tests/ */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./fake-google');

const SECRET = 'test-secret-0123456789';

function setup() {
  const g = load({ SECRET });
  g.sync = (body = {}) => g.post(Object.assign({ secret: SECRET, action: 'sync' }, body));
  return g;
}

const sip = (id, over) => Object.assign({ id, kind: 'sip', code: 122639, name: 'Parag Parikh Flexi Cap Fund', amount: 5000, day: 5, start: '2021-04', end: null, step: 10 }, over);
// Dates made inside the script's sandbox aren't `instanceof` this realm's Date.
const isDate = v => Object.prototype.toString.call(v) === '[object Date]';
const change = (c, id, at, data, del) => ({ c, id, at, del: del ? 1 : 0, data: del ? null : data });

test('refuses every request until SECRET is set, and a wrong or missing secret', () => {
  const bare = load({});
  let r = bare.post({ secret: 'anything-at-all-123', action: 'ping' });
  assert.equal(r.ok, false); assert.equal(r.setup, true); assert.equal(r.app, 'corpus-planner');
  assert.match(r.error, /Script properties/);

  const short = load({ SECRET: 'short' });
  assert.equal(short.post({ secret: 'short', action: 'ping' }).setup, true);

  const g = setup();
  r = g.post({ secret: 'wrong-secret-0123456789', action: 'sync', changes: [change('holdings', 'a', 5, sip('a'))] });
  assert.equal(r.ok, false); assert.equal(r.badSecret, true);
  assert.equal(g.post({ action: 'ping' }).badSecret, true);
  assert.equal(g.ss.getSheetByName('_data'), null, 'nothing is written for a bad secret');
  assert.equal(g.lock.held, 0);
});

test('ping answers with the epoch and the Sheet URL', () => {
  const g = setup();
  const r = g.post({ secret: SECRET, action: 'ping' });
  assert.equal(r.ok, true);
  assert.match(r.epoch, /^e[0-9a-z]{8,}$/);
  assert.equal(r.sheetUrl, 'https://docs.google.com/spreadsheets/d/TEST-SHEET/edit');
  assert.equal(r.version, 2);
});

test("a first sync stores the device's records and says to resync", () => {
  const g = setup();
  const r = g.sync({ epoch: null, since: 0, changes: [change('holdings', 'a', 1, sip('a')), change('settings', 'plan', 1, { monthlySip: 46000, rates: [8, 12] })] });
  assert.equal(r.ok, true);
  assert.equal(r.resync, true);
  assert.equal(r.cursor, 2);
  assert.deepEqual(r.changes.map(d => d.c + '/' + d.id).sort(), ['holdings/a', 'settings/plan']);
  assert.deepEqual(r.changes.find(d => d.id === 'a').data, sip('a'));
  const data = g.ss.getSheetByName('_data');
  assert.equal(data.isSheetHidden(), true);
  assert.equal(data.getMaxColumns(), 14, 'the data tab is cut to its 14 columns');
  assert.equal(g.lock.held, 0);
});

test('a second device gets everything, then only what changed', () => {
  const g = setup();
  const a = g.sync({ changes: [change('holdings', 'a', 1, sip('a')), change('holdings', 'b', 1, sip('b', { amount: 2000 }))] });
  const b1 = g.sync({ epoch: null, since: 0, changes: [] });
  assert.equal(b1.changes.length, 2);
  const b2 = g.sync({ epoch: b1.epoch, since: b1.cursor, changes: [] });
  assert.equal(b2.resync, false);
  assert.deepEqual(b2.changes, [], 'nothing new');
  g.sync({ epoch: a.epoch, since: a.cursor, changes: [change('holdings', 'c', 50, sip('c'))] });
  const b3 = g.sync({ epoch: b1.epoch, since: b2.cursor, changes: [] });
  assert.deepEqual(b3.changes.map(d => d.id), ['c']);
});

test('the newest edit wins, and an older or equal one gets the stored copy back', () => {
  const g = setup();
  const first = g.sync({ changes: [change('settings', 'plan', 100, { monthlySip: 1000 })] });
  let r = g.sync({ epoch: first.epoch, since: first.cursor, changes: [change('settings', 'plan', 200, { monthlySip: 2000 })] });
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.changes[0].data, { monthlySip: 2000 });

  r = g.sync({ epoch: first.epoch, since: r.cursor, changes: [change('settings', 'plan', 150, { monthlySip: 1500 })] });
  assert.deepEqual(r.changes, []);
  assert.equal(r.rejected.length, 1);
  assert.deepEqual(r.rejected[0], { c: 'settings', id: 'plan', at: 200, del: 0, data: { monthlySip: 2000 } });

  r = g.sync({ epoch: first.epoch, since: r.cursor, changes: [change('settings', 'plan', 200, { monthlySip: 9999 })] });
  assert.deepEqual(r.rejected[0].data, { monthlySip: 2000 }, 'a tie keeps what is stored');
});

test('a deletion is kept as a marker and reaches other devices', () => {
  const g = setup();
  const a = g.sync({ changes: [change('holdings', 'a', 10, sip('a')), change('holdings', 'b', 10, sip('b'))] });
  const b = g.sync({ epoch: null, since: 0 });
  const del = g.sync({ epoch: a.epoch, since: a.cursor, changes: [change('holdings', 'a', 20, null, true)] });
  assert.deepEqual(del.changes, [{ c: 'holdings', id: 'a', at: 20, del: 1, data: null }]);
  const b2 = g.sync({ epoch: b.epoch, since: b.cursor });
  assert.deepEqual(b2.changes.map(d => [d.id, d.del]), [['a', 1]]);
  // an older edit from a device that missed the deletion doesn't bring it back
  const late = g.sync({ epoch: b.epoch, since: b2.cursor, changes: [change('holdings', 'a', 15, sip('a', { amount: 1 }))] });
  assert.equal(late.rejected[0].del, 1);
  const inv = g.ss.getSheetByName('Investments').dump();
  assert.equal(inv.length, 2, 'only the remaining investment is listed');
  assert.equal(inv[1][0], 'Parag Parikh Flexi Cap Fund');
});

test('awkward text comes back exactly as sent', () => {
  const g = setup();
  const awkward = { name: '=IMPORTXML("http://x","//a")', folio: '+91 12345 67890', note: '-5,"qty":2}', at: '@home',
                    zeros: '0012345', sci: '1e5', day: '2026-09-25', isin: 'INF846K01WO1', uni: '₹ ✓ “quotes” \u0000' };
  const r1 = g.sync({ changes: [change('holdings', 'x', 1, Object.assign(sip('x'), awkward))] });
  const back = g.sync({ epoch: null, since: 0 }).changes.find(d => d.id === 'x').data;
  assert.deepEqual(back, Object.assign(sip('x'), awkward));
  assert.equal(r1.ok, true);
  // and the readable tab doesn't run a formula-looking name
  const inv = g.ss.getSheetByName('Investments').dump();
  assert.equal(inv[1][0], awkward.name);
});

test('a record longer than one cell is split across cells, and one too big is refused', () => {
  const g = setup();
  const txns = [];
  for (let i = 0; i < 1500; i++) txns.push({ date: `20${10 + (i % 15)}-0${1 + (i % 9)}-1${i % 9}`, type: 'PURCHASE_SIP', amount: 4999.75, units: 12.345 + i, nav: 40.4958 });
  const cas = { id: 'cas1', kind: 'cas', code: 122639, isin: 'INF879O01027', name: 'Parag Parikh Flexi Cap Fund', amc: 'PPFAS', folio: '••••1234', closeUnits: 1, txns };
  assert.ok(JSON.stringify(cas).length > 100000);
  g.sync({ changes: [change('holdings', 'cas1', 5, cas)] });
  const row = g.ss.getSheetByName('_data').dump()[1];
  assert.ok(row.slice(6).filter(Boolean).length >= 3, 'spread over several json cells');
  assert.ok(row.slice(6).every(c => !c || String(c).length <= 45001));
  assert.deepEqual(g.sync({ epoch: null, since: 0 }).changes[0].data, cas);
  assert.equal(g.ss.getSheetByName('Transactions').getLastRow(), 1501);

  const huge = { id: 'big', blob: 'x'.repeat(8 * 45000 + 1) };
  const r = g.sync({ changes: [change('holdings', 'big', 5, huge)] });
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0].error, /Too large/);
});

test('refuses records it does not keep', () => {
  const g = setup();
  const r = g.sync({ changes: [change('secrets', 'a', 1, {}), change('holdings', '../x', 1, {}), change('holdings', 'ok', 0, {}), change('holdings', '', 1, {})] });
  assert.equal(r.refused.length, 4);
  assert.equal(r.changes.length, 0);
});

test('the valuation fills the Portfolio tab, is never sent back, and an older one never replaces a newer one', () => {
  const g = setup();
  const snap = (navDate, value) => ({
    navDate,
    totals: { moneyIn: 100000, moneyOut: 0, net: 100000, value, gain: value - 100000, xirr: 0.1234 },
    rows: [{ id: 'a', name: 'Parag Parikh Flexi Cap Fund', kind: 'sip', code: 122639, units: 1234.567, net: 100000, value, gain: value - 100000, xirr: 0.1234, navDate },
           { id: 'b', name: 'Old Fund', kind: 'lump', error: "Couldn't match this fund to an AMFI scheme code." }]
  });
  let r = g.sync({ changes: [change('snapshot', 'latest', 100, snap('2026-09-25', 150000))] });
  assert.deepEqual(r.changes, [], 'the snapshot is not pulled by devices');
  let tab = g.ss.getSheetByName('Portfolio').dump();
  assert.deepEqual(tab[0].slice(0, 3), ['Investment', 'Kind', 'Units']);
  assert.equal(tab[1][4], 150000);
  assert.equal(tab[2][8], "Couldn't match this fund to an AMFI scheme code.");
  assert.equal(tab[3][0], 'Total');
  assert.match(tab[5][0], /^Valued 1970-01-01T00:00:00\.100Z, using NAVs up to 2026-09-25\./, 'dated by the record, not the data');

  r = g.sync({ changes: [change('snapshot', 'latest', 200, snap('2026-09-20', 1))] });
  assert.equal(g.ss.getSheetByName('Portfolio').dump()[1][4], 150000, 'older NAVs are ignored');
  g.sync({ changes: [change('snapshot', 'latest', 300, snap('2026-09-26', 160000))] });
  assert.equal(g.ss.getSheetByName('Portfolio').dump()[1][4], 160000);
});

test('the readable tabs show the plan and the investments in the right order', () => {
  const g = setup();
  g.sync({ changes: [
    change('holdings', 'l', 1, { id: 'l', kind: 'lump', code: 120001, name: 'Beta Fund', amount: 25000, date: '2024-03-15' }),
    change('holdings', 's', 1, sip('s')),
    change('settings', 'plan', 1, { monthlySip: 46000, rates: [8, 10, 12], swpEnabled: true, timing: 'end', stepUpType: 'pct', currentAge: '' })
  ] });
  const names = g.ss.getSheets().map(s => s.getName());
  assert.deepEqual(names, ['Portfolio', 'Investments', 'Transactions', 'Plan', 'Sheet1', '_data']);
  const inv = g.ss.getSheetByName('Investments').dump();
  assert.deepEqual(inv.slice(1).map(r => r[1]), ['Monthly SIP', 'One-time']);
  assert.ok(isDate(inv[1][6]) && inv[1][6].getFullYear() === 2021 && inv[1][6].getMonth() === 3, 'first SIP is a real date');
  assert.ok(isDate(inv[2][9]) && inv[2][9].getDate() === 15);
  const plan = Object.fromEntries(g.ss.getSheetByName('Plan').dump().slice(1));
  assert.equal(plan['Monthly SIP today (₹)'], 46000);
  assert.equal(plan['Rates to compare (% a year)'], '8, 10, 12');
  assert.equal(plan['Withdrawals (SWP)'], 'On');
  assert.equal(plan['SIP and SWP happen at the'], 'End of month');
  assert.equal(plan['Raise the SIP every year by'], 'a percentage');
});

test('erasing starts a new epoch, and a device that still has data sends it back', () => {
  const g = setup();
  const a = g.sync({ changes: [change('holdings', 'a', 5, sip('a'))] });
  assert.equal(g.ctx.RESET_EVERYTHING(), true);
  assert.equal(g.ss.getSheetByName('_data'), null);
  assert.equal(g.ss.getSheetByName('Investments'), null);
  const r = g.sync({ epoch: a.epoch, since: a.cursor, changes: [] });
  assert.equal(r.resync, true);
  assert.notEqual(r.epoch, a.epoch);
  assert.deepEqual(r.changes, []);
  const back = g.sync({ epoch: r.epoch, since: r.cursor, changes: [change('holdings', 'a', 5, sip('a'))] });
  assert.equal(back.changes.length, 1);
});

test('a rev counter that fell behind the rows never reuses a rev', () => {
  const g = setup();
  const a = g.sync({ changes: [change('holdings', 'a', 5, sip('a')), change('holdings', 'b', 5, sip('b'))] });
  g.properties.deleteProperty('rev');                // as if a run died before saving it
  const r = g.sync({ epoch: a.epoch, since: a.cursor, changes: [change('holdings', 'c', 5, sip('c'))] });
  assert.equal(r.cursor, 3);
  assert.deepEqual(r.changes.map(d => d.id), ['c']);
});

test('grows the data tab past its first 1000 rows', () => {
  const g = setup();
  const changes = [];
  for (let i = 0; i < 1100; i++) changes.push(change('holdings', 'h' + i, 5, sip('h' + i)));
  const r = g.sync({ changes });
  assert.equal(r.ok, true, r.error);
  assert.equal(g.ss.getSheetByName('_data').getLastRow(), 1101);
  assert.equal(g.ss.getSheetByName('Investments').getLastRow(), 1101);
});

test('TEST_STORAGE passes on a Sheet that behaves like Google Sheets', () => {
  const g = setup();
  const r = g.ctx.TEST_STORAGE();
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.equal(g.ss.getSheetByName('_storage_test'), null, 'cleans up after itself');
});

test('the fake Sheet really does mangle unprotected text, so the tests above mean something', () => {
  const { typed } = require('./fake-google');
  assert.equal(typed('=1+1'), '#ERROR!');
  assert.equal(typed('+91 12345 67890'), '#ERROR!');
  assert.equal(typed('0012345'), 12345);
  assert.ok(isDate(typed('2026-09-25')));
});

test('bad JSON in the request is reported, not thrown', () => {
  const g = setup();
  const out = g.ctx.doPost({ postData: { contents: '{not json' } });
  const r = JSON.parse(out.getContent());
  assert.equal(r.ok, false);
  assert.equal(r.app, 'corpus-planner');
  assert.equal(g.lock.held, 0);
});
