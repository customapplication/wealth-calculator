/* The money maths shared by Compare, Portfolio and the Plan forecast. Pure
   functions, no page access, so node's test runner can check them directly
   (tests/calc.test.js). In the page they're window.Calc. */
(function (root, make) {
  const api = make();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Calc = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';
  const DAY = 864e5;
  const STAMP_FROM = Date.UTC(2020, 6, 1);   // 0.005% stamp duty on purchases from 1 July 2020
  const STAMP_RATE = 0.00005;

  const isoToMs = s => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d || 1); };
  const msToIso = ms => new Date(ms).toISOString().slice(0, 10);
  /** 'YYYY-MM' as a month count, so months subtract. */
  const monthNo = ym => { const [y, m] = String(ym).split('-').map(Number); return y * 12 + (m - 1); };
  const monthOf = ms => { const d = new Date(ms); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
  const ymOf = n => `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;

  function idxOnOrBefore(t, x) {
    let lo = 0, hi = t.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (t[mid] <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  function idxOnOrAfter(t, x) {
    let lo = 0, hi = t.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (t[mid] >= x) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
    return ans;
  }

  /** Annualised internal rate of return for dated cash flows [{t: ms, v: amount}]. */
  function xirr(flows) {
    flows = flows.filter(f => f.v !== 0 && isFinite(f.v)).sort((a, b) => a.t - b.t);
    if (flows.length < 2 || !flows.some(f => f.v > 0) || !flows.some(f => f.v < 0)) return null;
    const t0 = flows[0].t, yr = flows.map(f => (f.t - t0) / (365 * DAY));
    const npv = r => flows.reduce((s, f, i) => s + f.v / Math.pow(1 + r, yr[i]), 0);
    let lo = -0.9999, hi = 100, flo = npv(lo), fhi = npv(hi);
    if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
    for (let i = 0; i < 300; i++) {
      const mid = (lo + hi) / 2, fm = npv(mid);
      if (Math.abs(fm) < 1e-9 || hi - lo < 1e-12) return mid;
      if (flo * fm < 0) hi = mid; else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  }

  /** One date a month from `from` (its day of the month, or the month's last day) up to `to`. */
  function monthDates(from, to) {
    const out = [], d = new Date(from), day = d.getUTCDate();
    let y = d.getUTCFullYear(), m = d.getUTCMonth();
    for (let k = 0; k < 1200; k++) {
      const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const t = Date.UTC(y, m, Math.min(day, dim));
      if (t > to) break;
      if (t >= from) out.push(t);
      if (++m > 11) { m = 0; y++; }
    }
    return out;
  }

  /**
   * Invest in a NAV series {t: [ms], v: [nav]}: a lump sum once, or a SIP each
   * month, from o.from (or the series' first NAV, if it starts later) to o.to.
   * Each purchase takes the first NAV on or after its date, less stamp duty from
   * July 2020, as the Portfolio page prices a SIP.
   * o: { mode: 'lump' | 'sip', amount, from, to, grid: [ms] }
   * Returns { start, buys, invested, units, value, gain, xirr, points: [value or null per grid date], put: [...] }.
   */
  function simulate(series, o) {
    const t = series.t, v = series.v, n = t.length;
    const out = { start: null, buys: [], invested: 0, units: 0, value: null, gain: null, xirr: null, points: [], put: [] };
    const grid = o.grid || [];
    if (!n || !(o.amount > 0)) { out.points = grid.map(() => null); out.put = grid.map(() => null); return out; }
    const from = Math.max(o.from, t[0]);
    const targets = from > o.to ? [] : o.mode === 'sip' ? monthDates(from, o.to) : [from];
    for (const target of targets) {
      const i = idxOnOrAfter(t, target);
      if (i < 0 || t[i] > o.to) break;
      const net = t[i] >= STAMP_FROM ? o.amount * (1 - STAMP_RATE) : o.amount;
      out.buys.push({ t: t[i], units: net / v[i], amount: o.amount });
    }
    if (!out.buys.length) { out.points = grid.map(() => null); out.put = grid.map(() => null); return out; }
    out.start = out.buys[0].t;
    let j = 0, u = 0, put = 0;
    for (const g of grid) {
      while (j < out.buys.length && out.buys[j].t <= g) { u += out.buys[j].units; put += out.buys[j].amount; j++; }
      const k = idxOnOrBefore(t, g);
      out.points.push(g < out.start || k < 0 ? null : u * v[k]);
      out.put.push(g < out.start ? null : put);
    }
    out.units = out.buys.reduce((s, b) => s + b.units, 0);
    out.invested = out.buys.reduce((s, b) => s + b.amount, 0);
    const k = idxOnOrBefore(t, o.to);
    out.value = k >= 0 ? out.units * v[k] : null;
    out.gain = out.value == null ? null : out.value - out.invested;
    out.xirr = out.value == null ? null : xirr(out.buys.map(b => ({ t: b.t, v: -b.amount })).concat([{ t: t[k], v: out.value }]));
    return out;
  }

  /** Several series averaged into one, each rebased to 100 on the first date all of them cover. */
  function average(list) {
    list = list.filter(s => s && s.t && s.t.length);
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    const base = Math.max(...list.map(s => s.t[0]));
    const b = list.map(s => s.v[idxOnOrBefore(s.t, base)]);
    const first = list[0], t = [], v = [];
    for (let i = idxOnOrAfter(first.t, base); i >= 0 && i < first.t.length; i++) {
      let sum = 0;
      for (let k = 0; k < list.length; k++) { const j = idxOnOrBefore(list[k].t, first.t[i]); sum += 100 * list[k].v[j] / b[k]; }
      t.push(first.t[i]); v.push(sum / list.length);
    }
    return { t, v };
  }

  const ISO = /^\d{4}-\d{2}-\d{2}/;
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const BUY_TYPES = new Set(['PURCHASE', 'PURCHASE_SIP', 'SWITCH_IN', 'SWITCH_IN_MERGER', 'DIVIDEND_REINVEST']);

  /**
   * A statement fund's SIP instalments, oldest first: [{ date, net, stamp,
   * gross, units, nav }]. gross is what left the bank: the purchase plus its
   * share of that day's stamp duty (shared by amount when a day has several
   * purchases).
   */
  function sipInstalments(h) {
    const all = Array.isArray(h && h.txns) ? h.txns.filter(x => x && ISO.test(x.date)) : [];
    const stamp = new Map(), bought = new Map();
    for (const x of all) {
      if (x.type === 'STAMP_DUTY_TAX') stamp.set(x.date, (stamp.get(x.date) || 0) + Math.abs(x.amount || 0));
      else if (BUY_TYPES.has(x.type)) bought.set(x.date, (bought.get(x.date) || 0) + Math.abs(x.amount || 0));
    }
    return all.filter(x => x.type === 'PURCHASE_SIP').sort(byDate).map(x => {
      const net = Math.abs(x.amount || 0), day = bought.get(x.date) || 0;
      const st = day > 0 ? (stamp.get(x.date) || 0) * net / day : 0;
      return { date: x.date.slice(0, 10), net, stamp: st, gross: net + st, units: Math.abs(x.units || 0), nav: x.nav == null ? null : +x.nav };
    });
  }

  /**
   * Changes in a SIP's amount, read from its instalments (oldest first). A
   * new amount counts once it holds for two instalments, or when it's the
   * latest; a single odd instalment between two runs isn't a change. With
   * several SIPs in one fund (two or more instalments in most months) the
   * amounts can't be told apart, so nothing is read.
   * Returns { changes: [{ date, from, to, up, pct }], ups, several, yearly,
   * pct (the same % each time, when yearly), amt (the same ₹ each time, when yearly) }.
   */
  function sipSteps(inst) {
    const out = { changes: [], ups: [], several: false, yearly: false, pct: null, amt: null };
    const months = new Map();
    inst.forEach(x => months.set(x.date.slice(0, 7), (months.get(x.date.slice(0, 7)) || 0) + 1));
    const multi = [...months.values()].filter(n => n > 1).length;
    out.several = months.size >= 3 && multi * 2 >= months.size;
    if (out.several || inst.length < 2) return out;
    const same = (a, b) => Math.abs(a - b) <= Math.max(1, 0.002 * Math.max(a, b));
    let runs = [];
    for (const x of inst) {
      const a = Math.round(x.gross), r = runs[runs.length - 1];
      if (r && same(r.amount, a)) { r.n++; r.last = x.date; } else runs.push({ amount: a, n: 1, first: x.date, last: x.date });
    }
    runs = runs.filter((r, i) => !(r.n === 1 && i > 0 && i < runs.length - 1));
    const merged = [];
    for (const r of runs) {
      const p = merged[merged.length - 1];
      if (p && same(p.amount, r.amount)) { p.n += r.n; p.last = r.last; } else merged.push(Object.assign({}, r));
    }
    for (let i = 1; i < merged.length; i++) {
      const a = merged[i - 1].amount, b = merged[i].amount;
      out.changes.push({ date: merged[i].first, from: a, to: b, up: b > a, pct: Math.round((b / a - 1) * 1000) / 10 });
    }
    out.ups = out.changes.filter(c => c.up);
    const u = out.ups;
    if (u.length >= 2 && u.every((c, i) => i === 0 || Math.abs(monthNo(c.date.slice(0, 7)) - monthNo(u[i - 1].date.slice(0, 7)) - 12) <= 1)) {
      out.yearly = true;
      const pcts = u.map(c => (c.to / c.from - 1) * 100).sort((a, b) => a - b), mid = pcts[Math.floor(pcts.length / 2)];
      const adds = u.map(c => c.to - c.from);
      if (adds.every(d => Math.abs(d - adds[0]) <= 1)) out.amt = Math.round(adds[0]);
      else if (pcts.every(p => Math.abs(p - mid) <= 1)) out.pct = Math.round(mid * 10) / 10;
    }
    return out;
  }

  /**
   * The SIP a statement shows for a fund, from its SIP purchases: the amount
   * (the last instalment plus its stamp duty, or the last month's together
   * with several SIPs), the usual debit day, the first and last instalments,
   * any step-ups, and whether it was still running when the statement ends
   * (an instalment in its last 40 days). null if the statement has no SIP.
   * startKnown is false when the first instalment is at the very start of a
   * statement that opens with units already held: it may have started earlier.
   */
  function inferSip(h) {
    const inst = sipInstalments(h);
    if (!inst.length) return null;
    const last = inst[inst.length - 1];
    const days = new Map();
    inst.slice(-6).forEach(x => { const d = +x.date.slice(8, 10); days.set(d, (days.get(d) || 0) + 1); });
    const day = [...days].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    const asOf = h.asOf && ISO.test(h.asOf) ? h.asOf : last.date;
    const running = isoToMs(asOf) - isoToMs(last.date) <= 40 * DAY;
    const steps = sipSteps(inst);
    const amount = steps.several ? inst.filter(x => x.date.slice(0, 7) === last.date.slice(0, 7)).reduce((s, x) => s + x.gross, 0) : last.gross;
    const early = +h.openUnits > 0.0005 && h.from && ISO.test(h.from) && isoToMs(inst[0].date) - isoToMs(h.from) <= 40 * DAY;
    return {
      amount: Math.round(amount), day: Math.min(28, Math.max(1, day)),
      start: inst[0].date.slice(0, 7), end: running ? null : last.date.slice(0, 7),
      step: steps.pct || 0, stepAmt: steps.amt || 0,
      stepMonth: steps.ups.length ? steps.ups[steps.ups.length - 1].date.slice(0, 7) : null,
      steps, first: inst[0].date, startKnown: !early,
      running, last: last.date, asOf, count: inst.length, source: 'statement'
    };
  }

  /**
   * A holding's SIP as it stands this month: { amount (after its step-ups so
   * far), day, start, end, step, running, source } or null (a one-time amount,
   * or a statement fund with no SIP). A SIP you entered, or details you gave a
   * statement fund, come first; otherwise what the statement shows.
   */
  function sipOf(h, today) {
    if (!h) return null;
    const now = monthOf(today);
    const own = (s, source) => {
      const start = /^\d{4}-\d{2}$/.test(s.start || '') ? s.start : null;
      const end = /^\d{4}-\d{2}$/.test(s.end || '') ? s.end : null;
      const running = !end || monthNo(end) >= now;
      const upto = running ? now : monthNo(end);
      const k = start ? Math.max(0, upto - monthNo(start)) : 0;
      const step = Math.max(0, +s.step || 0);
      // A SIP you entered keeps its first amount and rises each year; details for a statement fund give today's amount.
      const amount = source === 'you-sip' ? s.amount * Math.pow(1 + step / 100, Math.floor(k / 12)) : +s.amount;
      return { amount, day: s.day || null, start, end, step, running, source: source === 'you-sip' ? 'you' : source };
    };
    if (h.kind === 'sip') return own(h, 'you-sip');
    if (h.kind !== 'cas') return null;
    if (h.sip && h.sip.none) return null;
    if (h.sip && +h.sip.amount > 0) return own(h.sip, 'you');
    const g = inferSip(h);
    if (!g) return null;
    g.running = g.running && !g.end;
    // A step-up seen every year goes on after the statement ends: add the ones due since.
    if (g.running && g.stepMonth && (g.step > 0 || g.stepAmt > 0)) {
      g.seen = g.amount;
      for (let m = monthNo(g.last.slice(0, 7)) + 1; m <= now; m++) {
        if ((m - monthNo(g.stepMonth)) % 12 === 0) g.amount = g.step > 0 ? g.amount * (1 + g.step / 100) : g.amount + g.stepAmt;
      }
      g.amount = Math.round(g.amount);
    }
    return g;
  }

  /**
   * Where today's portfolio could get to. items: [{ id, value, sip }] with sip
   * as sipOf gives it. o: { years, rate (% a year), stepMode 'own' | 'all',
   * step (% a year, for 'all'), today (ms), invested (money in so far, net) }.
   * Month by month: each running SIP goes in at the start of the month (rising
   * by its step-up each year, in the month it started, or in the month a
   * statement showed its last step-up; by a % or, as a statement can show, a
   * fixed ₹ stepAmt), then everything grows
   * by the month's share of the yearly rate. Stopped SIPs add nothing, and a
   * SIP with a stop month ends there.
   */
  function forecast(items, o) {
    const months = Math.max(1, Math.round((+o.years || 0) * 12));
    const i = Math.pow(1 + (+o.rate || 0) / 100, 1 / 12) - 1;
    const now = monthOf(o.today);
    const hs = items.map(x => {
      const s = x.sip && x.sip.running && x.sip.amount > 0 ? x.sip : null;
      return {
        id: x.id, value: Math.max(0, +x.value || 0), put: 0, start: Math.max(0, +x.value || 0),
        sip: s ? { amount: s.amount, first: s.amount, step: o.stepMode === 'all' ? Math.max(0, +o.step || 0) : Math.max(0, +s.step || 0),
                   add: o.stepMode === 'all' ? 0 : Math.max(0, +s.stepAmt || 0),
                   from: s.start ? monthNo(s.start) : now, until: s.end ? monthNo(s.end) : Infinity,
                   base: o.stepMode !== 'all' && s.stepMonth ? monthNo(s.stepMonth) : (s.start ? monthNo(s.start) : now) } : null
      };
    });
    const sum = k => hs.reduce((s, h) => s + h[k], 0);
    const base = +o.invested || 0;
    const rows = [{ month: 0, year: 0, value: sum('value'), put: base, added: 0 }];
    for (let m = 1; m <= months; m++) {
      const cm = now + m;
      for (const h of hs) {
        const s = h.sip;
        if (s && cm >= s.from && cm <= s.until) {
          if (cm > s.from && cm > s.base && (cm - s.base) % 12 === 0) {
            if (s.step > 0) s.amount *= 1 + s.step / 100; else if (s.add > 0) s.amount += s.add;
          }
          h.value += s.amount; h.put += s.amount;
        }
        h.value *= 1 + i;
      }
      if (m % 12 === 0 || m === months) rows.push({ month: m, year: m / 12, value: sum('value'), put: base + sum('put'), added: sum('put') });
    }
    const end = rows[rows.length - 1];
    return {
      rows, months, value: end.value, added: end.added, invested: end.put,
      holdings: hs.map(h => ({ id: h.id, start: h.start, value: h.value, added: h.put, sipNow: h.sip ? h.sip.first : 0, sipLast: h.sip ? h.sip.amount : 0 })),
      monthlyNow: hs.reduce((s, h) => s + (h.sip && h.sip.from <= now + 1 && h.sip.until >= now + 1 ? h.sip.first : 0), 0),
      endMonth: ymOf(now + months)
    };
  }

  /**
   * This month's SIP debits: items [{ id, sip }] with sip as sipOf gives it.
   * One entry per running SIP that has started, on its debit day (or the
   * month's last day), with status 'done' once the day has passed, 'today',
   * or 'due'. Sorted by day. [{ id, t, day, amount, status }]
   */
  function monthSips(items, today) {
    const d = new Date(today), y = d.getUTCFullYear(), m = d.getUTCMonth(), now = y * 12 + m;
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const t0 = Date.UTC(y, m, d.getUTCDate());
    const out = [];
    for (const x of items) {
      const s = x.sip;
      if (!s || !s.running || !(s.amount > 0) || !s.day) continue;
      if (s.start && monthNo(s.start) > now) continue;
      if (s.end && monthNo(s.end) < now) continue;
      const t = Date.UTC(y, m, Math.min(s.day, dim));
      out.push({ id: x.id, t, day: s.day, amount: s.amount, status: t < t0 ? 'done' : t === t0 ? 'today' : 'due' });
    }
    return out.sort((a, b) => a.t - b.t || b.amount - a.amount);
  }

  return { DAY, STAMP_FROM, STAMP_RATE, BUY_TYPES, isoToMs, msToIso, monthNo, monthOf, ymOf, idxOnOrBefore, idxOnOrAfter, xirr, monthDates, simulate, average, sipInstalments, sipSteps, inferSip, sipOf, forecast, monthSips };
});
