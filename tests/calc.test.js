/* Tests for site/js/calc.js: node --test tests/*.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../site/js/calc.js');

const DAY = 864e5;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} is not within ${tol} of ${b}`);
/** A NAV every weekday from `from` to `to`, growing `rate` a year. */
function series(from, to, rate, start = 10) {
  const t = [], v = [], t0 = Date.parse(from), t1 = Date.parse(to);
  for (let x = t0; x <= t1; x += DAY) {
    const wd = new Date(x).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    t.push(x); v.push(start * Math.pow(1 + rate, (x - t0) / (365 * DAY)));
  }
  return { t, v };
}

test('a lump sum grows with the NAV, less stamp duty from July 2020', () => {
  const s = series('2021-01-01', '2026-01-01', 0.12);
  const r = C.simulate(s, { mode: 'lump', amount: 10000, from: Date.parse('2021-01-01'), to: Date.parse('2026-01-01'), grid: [Date.parse('2020-06-01'), Date.parse('2026-01-01')] });
  assert.equal(r.buys.length, 1);
  assert.equal(r.invested, 10000);
  near(r.value, 10000 * (1 - 0.00005) * Math.pow(1.12, (s.t[s.t.length - 1] - s.t[0]) / (365 * DAY)), 0.01);
  near(r.xirr, 0.12, 0.0005, 'about 12% a year');
  assert.deepEqual(r.points.map(p => p == null), [true, false], 'nothing before the purchase');
});

test('a SIP buys once a month on the same day, at the first NAV on or after it', () => {
  const s = series('2024-01-01', '2024-12-31', 0);
  const r = C.simulate(s, { mode: 'sip', amount: 5000, from: Date.parse('2024-01-06'), to: Date.parse('2024-12-31'), grid: [] });
  assert.equal(r.buys.length, 12);
  assert.equal(new Date(r.buys[0].t).toISOString().slice(0, 10), '2024-01-08', 'the 6th was a Saturday');
  assert.equal(new Date(r.buys[1].t).toISOString().slice(0, 10), '2024-02-06');
  assert.equal(r.invested, 60000);
  near(r.value, 60000 * (1 - 0.00005), 0.01, 'a flat NAV keeps the money, less stamp duty');
  assert.ok(r.xirr < 0 && r.xirr > -0.001);
});

test('a fund younger than the period starts with its first NAV', () => {
  const s = series('2023-03-01', '2026-01-01', 0.1);
  const r = C.simulate(s, { mode: 'lump', amount: 10000, from: Date.parse('2021-01-01'), to: Date.parse('2026-01-01'), grid: [Date.parse('2022-01-01'), Date.parse('2024-01-01')] });
  assert.equal(r.start, s.t[0]);
  assert.equal(r.points[0], null);
  assert.ok(r.points[1] > 10000);
  const sip = C.simulate(s, { mode: 'sip', amount: 1000, from: Date.parse('2021-01-01'), to: Date.parse('2026-01-01'), grid: [] });
  assert.equal(sip.buys.length, 35, '1 Mar 2023 to 1 Jan 2026');
});

test('several benchmark funds average into one series', () => {
  const a = series('2020-01-01', '2021-01-01', 0.1), b = series('2020-06-01', '2021-01-01', 0.3);
  const avg = C.average([a, b]);
  assert.equal(avg.t[0], b.t[0], 'starts when both have NAVs');
  near(avg.v[0], 100, 1e-9);
  const last = avg.v[avg.v.length - 1];
  near(last, 100 * (a.v[a.v.length - 1] / a.v[C.idxOnOrBefore(a.t, b.t[0])] + b.v[b.v.length - 1] / b.v[0]) / 2, 1e-6);
});

test('the SIP a statement shows: amount with stamp duty, usual day, running or stopped', () => {
  const tx = [];
  for (let m = 1; m <= 8; m++) {
    const date = `2025-${String(m).padStart(2, '0')}-${m === 3 ? '06' : '05'}`;
    tx.push({ date, type: 'PURCHASE_SIP', amount: 4999.75, units: 10 }, { date, type: 'STAMP_DUTY_TAX', amount: 0.25 });
  }
  const running = C.inferSip({ kind: 'cas', asOf: '2025-08-31', txns: tx });
  assert.deepEqual([running.amount, running.day, running.start, running.end, running.running], [5000, 5, '2025-01', null, true]);
  const stopped = C.inferSip({ kind: 'cas', asOf: '2025-12-31', txns: tx });
  assert.deepEqual([stopped.end, stopped.running], ['2025-08', false]);
  assert.equal(C.inferSip({ kind: 'cas', txns: [{ date: '2025-01-05', type: 'PURCHASE', amount: 10000 }] }), null, 'no SIP, no guess');
});

test("a holding's SIP: yours first, then the statement's; step-ups so far", () => {
  const today = Date.parse('2026-09-15');
  const mine = C.sipOf({ kind: 'sip', amount: 10000, day: 5, start: '2024-03', end: null, step: 10 }, today);
  assert.equal(mine.running, true);
  near(mine.amount, 10000 * 1.1 * 1.1, 1e-6, 'raised in Mar 2025 and Mar 2026');
  assert.equal(C.sipOf({ kind: 'sip', amount: 1000, day: 5, start: '2020-01', end: '2022-06', step: 0 }, today).running, false);
  const tx = [{ date: '2026-08-05', type: 'PURCHASE_SIP', amount: 3000 }];
  const cas = { kind: 'cas', asOf: '2026-08-31', txns: tx };
  assert.equal(C.sipOf(cas, today).source, 'statement');
  cas.sip = { amount: 3500, day: 7, start: '2023-01', end: null, step: 5 };
  assert.deepEqual(['amount', 'day', 'step', 'running', 'source'].map(k => C.sipOf(cas, today)[k]), [3500, 7, 5, true, 'you']);
  cas.sip = { none: true };
  assert.equal(C.sipOf(cas, today), null, 'you said it has no SIP');
  assert.equal(C.sipOf({ kind: 'lump', amount: 5000, date: '2024-01-01' }, today), null);
});

test('the forecast grows today\'s worth and adds running SIPs, with each step-up in its month', () => {
  const today = Date.parse('2026-09-15');
  let f = C.forecast([{ id: 'a', value: 100000, sip: null }], { years: 10, rate: 12, today });
  near(f.value, 100000 * Math.pow(1.12, 10), 0.01, 'compounds back to exactly 12% a year');
  // No growth: the money in is easy to count. Started in March, so it rises from March 2027.
  f = C.forecast([{ id: 'a', value: 0, sip: { amount: 10000, running: true, step: 10, start: '2025-03', end: null } }], { years: 1, rate: 0, today, invested: 50000 });
  assert.equal(f.added, 5 * 10000 + 7 * 11000);
  assert.equal(f.invested, 50000 + f.added);
  f = C.forecast([{ id: 'a', value: 0, sip: { amount: 10000, running: true, step: 10, start: '2025-03', end: null } }], { years: 1, rate: 0, today, stepMode: 'all', step: 0 });
  assert.equal(f.added, 120000, 'one step-up for every SIP overrides each one\'s own');
  f = C.forecast([
    { id: 'a', value: 0, sip: { amount: 1000, running: true, step: 0, start: '2020-01', end: '2027-02' } },
    { id: 'b', value: 0, sip: { amount: 1000, running: false, step: 0, start: '2020-01', end: '2024-01' } }
  ], { years: 2, rate: 0, today });
  assert.equal(f.added, 5 * 1000, 'Oct 2026 to Feb 2027, and nothing from the stopped one');
  assert.equal(f.rows.length, 3, 'today and each year');
  assert.equal(f.endMonth, '2028-09');
});
