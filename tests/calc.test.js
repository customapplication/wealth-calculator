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

/** Monthly SIP rows on the 10th from `from` ('YYYY-MM'), with amounts [gross...], stamp duty on its own row. */
function sipTxns(from, amounts, day = 10) {
  const out = [];
  let n = C.monthNo(from);
  for (const a of amounts) {
    const date = `${C.ymOf(n)}-${String(day).padStart(2, '0')}`, stamp = Math.round(a * 0.00005 * 100) / 100;
    out.push({ date, type: 'PURCHASE_SIP', amount: a - stamp, units: (a - stamp) / 50, nav: 50 }, { date, type: 'STAMP_DUTY_TAX', amount: stamp });
    n++;
  }
  return out;
}
const rep = (a, k) => Array(k).fill(a);

test('SIP instalments carry their stamp duty, shared by amount on a day with two purchases', () => {
  const tx = sipTxns('2025-01', [5000, 5000]).concat([{ date: '2025-02-10', type: 'PURCHASE', amount: 14999.25, units: 300, nav: 50 }]);
  tx.find(x => x.date === '2025-02-10' && x.type === 'STAMP_DUTY_TAX').amount = 1;   // 0.25 + 0.75
  const inst = C.sipInstalments({ txns: tx });
  assert.equal(inst.length, 2);
  near(inst[0].gross, 5000, 1e-9);
  near(inst[1].stamp, 1 * 4999.75 / (4999.75 + 14999.25), 1e-9);
  assert.equal(inst[1].nav, 50);
});

test('a step-up SIP: the same % every year is read from the statement', () => {
  const amts = rep(2000, 12).concat(rep(2200, 12), rep(2420, 12), rep(2662, 5));
  const s = C.inferSip({ kind: 'cas', asOf: '2024-05-31', txns: sipTxns('2021-01', amts) });
  assert.deepEqual(s.steps.ups.map(c => [c.date, c.from, c.to]), [['2022-01-10', 2000, 2200], ['2023-01-10', 2200, 2420], ['2024-01-10', 2420, 2662]]);
  assert.equal(s.steps.yearly, true);
  assert.equal(s.step, 10);
  assert.equal(s.stepMonth, '2024-01');
  assert.equal(s.amount, 2662);
  assert.equal(s.first, '2021-01-10');
  // Carried on after the statement: the step-ups due each January since.
  const h = { kind: 'cas', asOf: '2024-05-31', txns: sipTxns('2021-01', amts) };
  assert.equal(C.sipOf(h, Date.parse('2024-12-20')).amount, 2662, 'nothing to add before the next January');
  assert.equal(C.sipOf(h, Date.parse('2025-02-01')).amount, Math.round(2662 * 1.1), 'Jan 2025 added');
  const now = C.sipOf(h, Date.parse('2026-09-15'));
  assert.equal(now.amount, Math.round(2662 * 1.1 * 1.1), 'Jan 2025 and Jan 2026');
  assert.equal(now.seen, 2662);
  const gone = C.sipOf(Object.assign({}, h, { asOf: '2024-12-31' }), Date.parse('2026-09-15'));
  assert.equal(gone.running, false, 'no instalment in the statement\'s last 40 days: stopped');
  assert.equal(gone.amount, 2662, 'a stopped SIP keeps its last amount');
});

test('a step-up of the same ₹ each year, a single raise, and one odd instalment', () => {
  const fixed = C.inferSip({ kind: 'cas', asOf: '2023-03-20', txns: sipTxns('2021-03', rep(1000, 12).concat(rep(1500, 12), rep(2000, 1))) });
  assert.equal(fixed.steps.yearly, true);
  assert.deepEqual([fixed.step, fixed.stepAmt], [0, 500]);
  const once = C.inferSip({ kind: 'cas', asOf: '2026-03-31', txns: sipTxns('2025-04', rep(3000, 11).concat([3500])) });
  assert.deepEqual(once.steps.ups.map(c => [c.from, c.to, c.pct]), [[3000, 3500, 16.7]], 'the latest instalment counts on its own');
  assert.equal(once.steps.yearly, false);
  assert.equal(once.step, 0, 'one raise says nothing about next year');
  const blip = C.inferSip({ kind: 'cas', asOf: '2026-03-31', txns: sipTxns('2025-04', rep(3000, 5).concat([6000], rep(3000, 6))) });
  assert.equal(blip.steps.changes.length, 0, 'a one-off amount between two runs is not a change');
  const cut = C.inferSip({ kind: 'cas', asOf: '2026-03-31', txns: sipTxns('2025-04', rep(3000, 6).concat(rep(2000, 6))) });
  assert.deepEqual(cut.steps.changes.map(c => c.up), [false]);
  assert.equal(cut.steps.ups.length, 0);
});

test('two SIPs in one fund: no step-ups read, the month\'s amounts added', () => {
  const tx = sipTxns('2025-01', rep(1000, 6), 5).concat(sipTxns('2025-01', rep(2000, 6), 20));
  const s = C.inferSip({ kind: 'cas', asOf: '2025-06-30', txns: tx });
  assert.equal(s.steps.several, true);
  assert.equal(s.steps.changes.length, 0);
  assert.equal(s.amount, 3000);
});

test('a SIP in a statement that opens with units held may have started earlier', () => {
  const tx = sipTxns('2025-04', rep(2500, 12));
  assert.equal(C.inferSip({ kind: 'cas', from: '2025-04-01', openUnits: 120.5, asOf: '2026-03-31', txns: tx }).startKnown, false);
  assert.equal(C.inferSip({ kind: 'cas', from: '2025-04-01', openUnits: 0, asOf: '2026-03-31', txns: tx }).startKnown, true);
  assert.equal(C.inferSip({ kind: 'cas', from: '2024-01-01', openUnits: 50, asOf: '2026-03-31', txns: tx }).startKnown, true, 'first SIP well after the statement starts');
});

test('the forecast adds a fixed ₹ step-up in the month the statement showed it', () => {
  const today = Date.parse('2026-01-15');
  const sip = { amount: 1000, running: true, start: '2024-04', end: null, step: 0, stepAmt: 500, stepMonth: '2025-03' };
  const f = C.forecast([{ id: 'a', value: 0, sip }], { years: 1, rate: 0, today });
  // Feb 2026 at 1000, Mar 2026 to Jan 2027 at 1500.
  assert.equal(f.added, 1000 + 11 * 1500);
  const all = C.forecast([{ id: 'a', value: 0, sip }], { years: 1, rate: 0, today, stepMode: 'all', step: 0 });
  assert.equal(all.added, 12 * 1000, 'one step-up for all replaces the statement\'s');
});

test("this month's SIPs: each running SIP on its day, done or due by today's date", () => {
  const today = Date.parse('2026-02-14');
  const list = C.monthSips([
    { id: 'a', sip: { amount: 2000, day: 5, start: '2025-01', running: true } },
    { id: 'b', sip: { amount: 3000, day: 14, start: '2025-01', running: true } },
    { id: 'c', sip: { amount: 1000, day: 30, start: '2025-01', running: true } },
    { id: 'd', sip: { amount: 1000, day: 10, start: '2026-03', running: true } },
    { id: 'e', sip: { amount: 1000, day: 10, start: '2025-01', end: '2025-12', running: false } },
    { id: 'f', sip: null }
  ], today);
  assert.deepEqual(list.map(x => [x.id, new Date(x.t).toISOString().slice(0, 10), x.status]),
    [['a', '2026-02-05', 'done'], ['b', '2026-02-14', 'today'], ['c', '2026-02-28', 'due']]);
});
