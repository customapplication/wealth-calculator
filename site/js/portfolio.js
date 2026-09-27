/* Home and Portfolio: your SIPs from inception, valued with AMFI NAVs. Stored in
   this browser, and in the owner's Google Sheet when sync.js is connected. */
(() => {
  'use strict';
  const { $, $$, esc, full, cmp, pct, units, isoToMs, msToIso, fmtDate, fmtMonth, todayMs, store, hexA, colors,
    loadFunds, loadHistory, idxOnOrBefore, idxOnOrAfter, xirr, timeAxis, tooltip, download, shortCategory, groupLabel, DAY,
    pref, setPref, typeSwitch, picker, refreshPickers, icon, seriesColor, loadLinks, amcSite, shortAmc, searchFunds, combo } = MF;

  const KEY = 'mf-portfolio:v1';
  const CAS_FORMAT = 'mf-corpus-planner/cas-v1';
  const BACKUP_FORMAT = 'mf-corpus-planner/portfolio-v1';
  const STAMP_FROM = Date.UTC(2020, 6, 1);   // 0.005% stamp duty on purchases from 1 July 2020
  const STAMP_RATE = 0.00005;

  let P = store.json(KEY, { holdings: [] });
  if (!P || !Array.isArray(P.holdings)) P = { holdings: [] };
  let D = null, inited = false, chart = null, homeChart = null, mixChart = null, sel = null, results = [], computeToken = 0, lastSnapshot = null;
  const TIME_TYPES = [['line', 'Line', 'line'], ['area', 'Area', 'area'], ['bar', 'Bars', 'bar']];
  const MIX_TYPES = [['donut', 'Donut', 'donut'], ['pie', 'Pie', 'pie'], ['bar', 'Bars', 'hbar']];
  const RANGES = [['1', '1Y'], ['3', '3Y'], ['all', 'All']];
  const charts = {
    time: pref('pfTime', 'area', TIME_TYPES.map(x => x[0])),
    mix: pref('pfMix', 'donut', MIX_TYPES.map(x => x[0])),
    by: pref('pfMixBy', 'cat', ['fund', 'asset', 'cat', 'amc'])
  };
  const view = Object.assign({ scope: 'all', mode: 'value', group: 'cat', range: '3' }, store.json(KEY + ':view', {}));
  if (!['cat', 'amc', 'plan', 'goal', 'sip'].includes(view.group)) view.group = 'cat';
  const Calc = window.Calc;
  /** The holding's SIP this month (yours, or what the statement shows), or null. */
  const sipOf = h => Calc.sipOf(h, todayMs());
  const saveView = () => store.set(KEY + ':view', JSON.stringify(view));
  const opened = new Set();          // groups shown open
  const save = () => {
    if (!store.set(KEY, JSON.stringify(P))) $('#pfAddMsg').textContent = "Couldn't save in this browser (storage is full or blocked). Download a backup.";
    MF.emit('mf:changed', { what: 'portfolio' });
  };
  const synced = () => !!(window.Sync && window.Sync.connected());
  const newId = () => Math.random().toString(36).slice(2, 10);

  /* ---------- building each holding's transactions ---------- */
  function expandSip(h, hist, warn) {
    const out = [], last = hist.t[hist.t.length - 1], first = hist.t[0];
    let [y, m] = h.start.split('-').map(Number);
    const [ey, em] = h.end ? h.end.split('-').map(Number) : [9999, 12];
    let amt = h.amount, k = 0, skipped = 0;
    for (let guard = 0; guard < 1200; guard++) {
      if (y * 12 + m > ey * 12 + em) break;
      const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const target = Date.UTC(y, m - 1, Math.min(h.day, dim));
      if (target > last) break;
      if (k > 0 && k % 12 === 0 && h.step > 0) amt = amt * (1 + h.step / 100);
      k++;
      if (target < first - 5 * DAY) { skipped++; }
      else {
        const i = idxOnOrAfter(hist.t, target);
        if (i < 0) break;
        const t = hist.t[i], nav = hist.v[i];
        const net = t >= STAMP_FROM ? amt * (1 - STAMP_RATE) : amt;
        out.push({ t, du: net / nav, inv: amt, nav });
      }
      m++; if (m > 12) { m = 1; y++; }
    }
    if (skipped) warn.push(`${skipped} SIP instalment${skipped === 1 ? '' : 's'} fell before the fund's first NAV and ${skipped === 1 ? 'was' : 'were'} left out.`);
    return out;
  }
  function expandLump(h, hist, warn) {
    const target = isoToMs(h.date);
    const i = idxOnOrAfter(hist.t, target);
    if (i < 0 || target < hist.t[0] - 5 * DAY) { warn.push(`No NAV on or after ${fmtDate(target)}, so this purchase was left out.`); return []; }
    const t = hist.t[i], nav = hist.v[i];
    const net = t >= STAMP_FROM ? h.amount * (1 - STAMP_RATE) : h.amount;
    return [{ t, du: net / nav, inv: h.amount, nav }];
  }
  const IN_TYPES = new Set(['PURCHASE', 'PURCHASE_SIP', 'SWITCH_IN', 'SWITCH_IN_MERGER']);
  const OUT_TYPES = new Set(['REDEMPTION', 'SWITCH_OUT', 'SWITCH_OUT_MERGER']);
  const TAX_TYPES = new Set(['STAMP_DUTY_TAX', 'STT_TAX', 'TDS_TAX']);
  function casEvents(h, warn) {
    const out = [];
    let odd = 0;
    for (const x of h.txns || []) {
      const t = isoToMs(x.date), a = Math.abs(x.amount || 0), u = Math.abs(x.units || 0);
      if (IN_TYPES.has(x.type)) out.push({ t, du: u, inv: a });
      else if (OUT_TYPES.has(x.type)) out.push({ t, du: -u, inv: -a });
      else if (x.type === 'DIVIDEND_PAYOUT') out.push({ t, du: 0, inv: -a });
      else if (x.type === 'DIVIDEND_REINVEST') out.push({ t, du: u, inv: 0 });
      else if (TAX_TYPES.has(x.type)) out.push({ t, du: 0, inv: a });
      else if (x.type === 'REVERSAL') out.push({ t, du: x.units || 0, inv: x.amount || 0 });
      else if (x.units) { out.push({ t, du: x.units, inv: 0 }); odd++; }
    }
    if (odd) warn.push(`${odd} transfer or adjustment entr${odd === 1 ? 'y' : 'ies'} changed units without a cash amount (gifts, mergers, segregation, bonus units).`);
    return out.sort((a, b) => a.t - b.t);
  }

  /* ELSS units are locked for 3 years from each purchase (reinvested dividends too).
     A redemption can only take free units, so every purchase from the last 3 years is still held. */
  const isElss = r => { const f = fundOf(r); return /\belss\b|tax ?saver/i.test((f && f.k) || '') || /\belss\b|tax ?saver/i.test(r.h.name || (f && f.n) || ''); };
  function elssLock(r) {
    if (!isElss(r) || !r.units) return null;
    const now = todayMs(), until = t => { const d = new Date(t); d.setUTCFullYear(d.getUTCFullYear() + 3); return d.getTime(); };
    const locked = r.events.filter(e => e.du > 0 && until(e.t) > now);
    if (!locked.length) return { units: 0, value: 0, next: null };
    const units = Math.min(r.units, locked.reduce((s, e) => s + e.du, 0));
    return { units, value: units * r.lastNav, next: until(locked[0].t), free: Math.max(0, r.units - units) * r.lastNav };
  }

  function resolveCode(h) {
    if (h.code) return h.code;
    if (D && h.isin && D.byIsin.has(h.isin)) return D.byIsin.get(h.isin).c;
    return null;
  }
  const fundOf = r => (D && r.code ? D.byCode.get(r.code) : null);
  // AMFI's current name for the scheme, so a renamed fund shows its new name; what you saved is the fallback.
  const nameOf = r => (fundOf(r) ? fundOf(r).n : r.h.name || `Scheme ${r.code}`);
  const normName = n => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  /** The name you added (or the statement printed), when AMFI's current name differs. */
  const oldName = r => { const f = fundOf(r); return f && r.h.name && normName(r.h.name) !== normName(f.n) ? r.h.name : null; };
  const amcOf = r => { const f = fundOf(r); return (f && f.a) || r.h.amc || ''; };

  function describe(r) {
    const h = r.h, f = fundOf(r), bits = [];
    if (f) bits.push(f.p);
    if (h.kind === 'sip') {
      bits.push(`SIP ${full(h.amount)} on day ${h.day} since ${fmtMonth(isoToMs(h.start + '-01'))}${h.end ? `, stopped ${fmtMonth(isoToMs(h.end + '-01'))}` : ''}${h.step > 0 ? `, +${h.step}% a year` : ''}`);
    } else if (h.kind === 'lump') bits.push(`one-time ${full(h.amount)} on ${fmtDate(h.date)}`);
    else bits.push(h.folio ? `folio ••••${esc(folioEnd(h.folio))}` : 'from your statement');
    return bits.join(' · ');
  }
  /** "SIP ₹5,000 a month · running" or "SIP stopped Mar 2025", as a chip. */
  function sipChip(r) {
    const h = r.h, s = sipOf(h);
    if (h.kind === 'lump') return '';
    const edit = `data-sip="${esc(h.id)}"`;
    if (!s) return h.kind === 'cas' ? `<button type="button" class="tagchip" ${edit} aria-label="No SIP seen in the statement. Add its details">${icon('edit')}Add SIP details</button>` : '';
    const seen = s.source === 'statement' ? ' (from the statement)' : '';
    const old = s.source === 'statement' && s.asOf && todayMs() - isoToMs(s.asOf) > 45 * DAY ? `, as of ${fmtDate(s.asOf)}` : '';
    return s.running
      ? `<button type="button" class="tagchip sip-on" ${edit} aria-label="SIP of ${full(s.amount)} a month, running${seen}${old}. Edit its details">${icon('refresh')}SIP ${full(s.amount)} a month · running${old}</button>`
      : `<button type="button" class="tagchip sip-off" ${edit} aria-label="SIP stopped${s.end ? ' in ' + fmtMonth(isoToMs(s.end + '-01')) : ''}${seen}. Edit its details">${icon('close')}SIP stopped${s.end ? ' ' + fmtMonth(isoToMs(s.end + '-01')) : ''}</button>`;
  }

  /** A statement fund with no units left (fully sold, or merged into another scheme) needs no NAV to be counted. */
  function closedOut(r) {
    const h = r.h;
    if (h.kind !== 'cas' || h.closeUnits !== 0) return false;
    r.events = casEvents(h, r.warn);
    if (!r.events.length) return false;
    r.hist = null; r.units = 0; r.value = 0; r.lastNav = null;
    r.lastT = r.events[r.events.length - 1].t;
    r.moneyIn = r.events.reduce((s, e) => s + Math.max(0, e.inv), 0);
    r.moneyOut = r.events.reduce((s, e) => s + Math.max(0, -e.inv), 0);
    r.net = r.moneyIn - r.moneyOut; r.gain = -r.net; r.first = r.events[0].t;
    r.xirr = xirr(r.events.map(e => ({ t: e.t, v: -e.inv })));
    r.closed = true;
    r.warn.push("No units left on your statement (sold, or merged into another scheme), and AMFI no longer lists it, so no NAV is needed. Its money in and out still count.");
    return true;
  }

  async function buildOne(h) {
    const code = resolveCode(h);
    const r = { h, code, warn: [], error: null };
    if (!code) {
      if (closedOut(r)) return r;
      r.error = "Couldn't match this fund to an AMFI scheme code, so it can't be valued."; return r;
    }
    let hist;
    try { hist = await loadHistory(code); } catch (e) { if (closedOut(r)) return r; r.error = e.message; return r; }
    r.hist = hist;
    r.events = h.kind === 'sip' ? expandSip(h, hist, r.warn) : h.kind === 'lump' ? expandLump(h, hist, r.warn) : casEvents(h, r.warn);
    r.lastT = hist.t[hist.t.length - 1];
    r.lastNav = hist.v[hist.v.length - 1];
    // The change since the NAV before, on the units held then (a purchase on the last day isn't a gain).
    if (hist.t.length > 1) {
      r.prevT = hist.t[hist.t.length - 2]; r.prevNav = hist.v[hist.v.length - 2];
      const held = r.events.filter(e => e.t <= r.prevT).reduce((s, e) => s + e.du, 0);
      r.dayChange = held > 1e-6 ? held * (r.lastNav - r.prevNav) : 0;
      r.dayBase = held > 1e-6 ? held * r.prevNav : 0;
    }
    r.units = r.events.reduce((s, e) => s + e.du, 0);
    if (Math.abs(r.units) < 1e-6) r.units = 0;
    r.moneyIn = r.events.reduce((s, e) => s + Math.max(0, e.inv), 0);
    r.moneyOut = r.events.reduce((s, e) => s + Math.max(0, -e.inv), 0);
    r.net = r.moneyIn - r.moneyOut;
    r.value = r.units * r.lastNav;
    r.gain = r.value - r.net;
    r.first = r.events.length ? r.events[0].t : null;
    r.xirr = xirr(r.events.map(e => ({ t: e.t, v: -e.inv })).concat(r.value > 0 ? [{ t: r.lastT, v: r.value }] : []));
    r.lock = elssLock(r);
    if (h.kind === 'cas' && h.closeUnits != null) r.unitsMatch = Math.abs((h.openUnits || 0) + r.units - h.closeUnits) < 0.002;
    if (hist.source === 'mfapi') r.warn.push(`NAVs came from MFapi.in because this site doesn't track scheme ${code} yet. Add ${code} to extra_schemes in pipeline/config.json to get checked AMFI NAVs.`);
    if (D && D.navDate && r.lastT < isoToMs(D.navDate) - 4 * DAY && r.units > 0) r.warn.push(`Latest NAV is from ${fmtDate(r.lastT)}, older than the rest of the site's data.`);
    return r;
  }

  function series(list) {
    const valid = list.filter(r => !r.error && r.events.length && r.hist);
    if (!valid.length) return null;
    const start = Math.min(...valid.map(r => r.first)), end = Math.max(...valid.map(r => r.lastT));
    const grid = [];
    for (let t = start; t < end; t += 7 * DAY) grid.push(t);
    grid.push(end);
    const value = new Float64Array(grid.length), inv = new Float64Array(grid.length);
    for (const r of valid) {
      let j = 0, u = 0, c = 0;
      grid.forEach((t, gi) => {
        while (j < r.events.length && r.events[j].t <= t) { u += r.events[j].du; c += r.events[j].inv; j++; }
        const ni = idxOnOrBefore(r.hist.t, t);
        value[gi] += ni >= 0 ? u * r.hist.v[ni] : 0;
        inv[gi] += c;
      });
    }
    return { grid, value, inv };
  }

  function totals(list) {
    const ok = list.filter(r => !r.error);
    const t = { moneyIn: 0, moneyOut: 0, value: 0, flows: [], first: null, last: null, n: ok.length, day: 0, dayBase: 0, prevT: null };
    for (const r of ok) {
      t.moneyIn += r.moneyIn; t.moneyOut += r.moneyOut; t.value += r.value;
      if (r.dayBase) { t.day += r.dayChange; t.dayBase += r.dayBase; t.prevT = t.prevT == null ? r.prevT : Math.max(t.prevT, r.prevT); }
      r.events.forEach(e => t.flows.push({ t: e.t, v: -e.inv }));
      if (r.value > 0) t.flows.push({ t: r.lastT, v: r.value });
      if (r.first != null) t.first = t.first == null ? r.first : Math.min(t.first, r.first);
      t.last = t.last == null ? r.lastT : Math.max(t.last, r.lastT);
    }
    t.net = t.moneyIn - t.moneyOut; t.gain = t.value - t.net; t.xirr = xirr(t.flows);
    return t;
  }

  /* ---------- groups: by category, fund house, plan, goal or asset class ---------- */
  const assetClass = f => f ? groupLabel(f.g) || 'Other' : 'Not in the fund list';
  function groupKey(r, by) {
    const f = fundOf(r);
    if (by === 'amc') return amcOf(r) || 'Fund house not known';
    if (r.closed && (by === 'cat' || by === 'asset' || by === 'plan')) return 'Sold or merged';
    if (by === 'cat') return f ? shortCategory(f.k) : 'Not in the fund list';
    if (by === 'asset') return assetClass(f);
    if (by === 'plan') return f ? `${f.p} plan` : 'Plan not known';
    if (by === 'goal') return (r.h.goal || '').trim() || 'No goal set';
    if (by === 'sip') { const x = sipOf(r.h); return !x ? 'No SIP' : x.running ? 'SIP running' : 'SIP stopped'; }
    return nameOf(r);
  }
  function groups(by, list = results) {
    const map = new Map();
    for (const r of list) {
      // A fund house or goal is known without NAVs, so a fund that couldn't be valued stays in its group.
      const k = r.error && by !== 'amc' && by !== 'goal' && by !== 'sip' ? "Couldn't be valued" : groupKey(r, by);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    const SIP_ORDER = { 'SIP running': 0, 'SIP stopped': 1, 'No SIP': 2 };
    return [...map].map(([name, rs]) => ({ name, rs, t: totals(rs), err: rs.every(r => r.error) }))
      .sort((a, b) => by === 'sip' ? SIP_ORDER[a.name] - SIP_ORDER[b.name] : (a.err - b.err) || b.t.value - a.t.value || a.name.localeCompare(b.name));
  }

  /* ---------- rendering ---------- */
  async function refresh() {
    const token = ++computeToken;
    renderScopeOptions();
    renderGoalList();
    if (!P.holdings.length) { renderEmpty(); return; }
    $('#pfEmpty').hidden = true; $('#homeEmpty').hidden = true;
    $('#pfBody').hidden = false; $('#homeBody').hidden = false;
    if (!results.length) $('#homeWorth').textContent = '…';
    const list = await Promise.all(P.holdings.map(buildOne));
    if (token !== computeToken) return;
    results = list;
    renderHome(); renderSummary(); renderGroups(); renderChart(); renderMix(); renderNotes(); renderStatementCard();
    publishValuation();
  }

  /** The figures on this page, for the Portfolio tab of the Google Sheet. */
  function publishValuation() {
    const r2 = x => (x == null || !isFinite(x)) ? null : Math.round(x * 100) / 100;
    const rate = x => (x == null || !isFinite(x)) ? null : Math.round(x * 1e6) / 1e6;
    const t = totals(results);
    lastSnapshot = {
      navDate: D ? D.navDate : null,
      totals: results.some(r => !r.error) ? { moneyIn: r2(t.moneyIn), moneyOut: r2(t.moneyOut), net: r2(t.net), value: r2(t.value), gain: r2(t.gain), xirr: rate(t.xirr) } : null,
      rows: results.map(r => {
        const name = nameOf(r);
        return r.error ? { id: r.h.id, name, kind: r.h.kind, error: r.error }
          : { id: r.h.id, name, kind: r.h.kind, code: r.code, units: Math.round(r.units * 1000) / 1000, net: r2(r.net), value: r2(r.value), gain: r2(r.gain), xirr: rate(r.xirr), navDate: msToIso(r.lastT), sip: sipText(r.h) };
      })
    };
    MF.emit('mf:valued', lastSnapshot);
  }

  /** For the Sheet: "₹5,000 a month" / "Stopped Mar 2025" / "". */
  function sipText(h) {
    const x = sipOf(h);
    return !x ? '' : x.running ? `${full(x.amount)} a month${x.step > 0 ? `, +${x.step}% a year` : ''}` : `Stopped${x.end ? ' ' + fmtMonth(isoToMs(x.end + '-01')) : ''}`;
  }

  function renderEmpty() {
    results = [];
    $('#pfEmpty').hidden = false; $('#homeEmpty').hidden = false;
    $('#pfBody').hidden = true; $('#homeBody').hidden = true;
    [chart, homeChart, mixChart].forEach(c => c && c.destroy());
    chart = homeChart = mixChart = null;
    $('#pfSum').textContent = 'Nothing added yet';
    publishValuation();
  }

  const signCls = v => v < 0 ? 'loss' : 'gain';
  const signed = (v, f) => (v < 0 ? '−' : '+') + f(Math.abs(v));

  function renderHome() {
    const t = totals(results);
    $('#homeWorth').textContent = t.first == null ? '—' : full(t.value);
    $('#homeAsOf').textContent = t.last ? `Worth today, with NAVs of ${fmtDate(t.last)}` : 'Worth today';
    const g = $('#homeGain');
    g.className = signCls(t.gain);
    g.textContent = t.first == null ? '' : signed(t.gain, full) + (t.net > 0 ? ` (${pct(Math.abs(t.gain) / t.net, 1)})` : '');
    $('#homeIn').textContent = t.first == null ? 'None of these investments could be valued yet.' : `on ${full(t.net)} put in${t.moneyOut > 0 ? `, after ${full(t.moneyOut)} taken out` : ''}`;
    const day = $('#homeDay');
    day.hidden = !(t.dayBase > 0);
    if (t.dayBase > 0) { day.className = 'hero-day ' + signCls(t.day); day.textContent = `${signed(t.day, full)} (${signed(t.day / t.dayBase, x => pct(x, 2))}) since the previous NAV`; }
    const x = $('#homeXirr');
    x.hidden = t.xirr == null;
    if (t.xirr != null) x.textContent = `${t.xirr >= 0 ? 'Growing' : 'Shrinking'} ${pct(Math.abs(t.xirr), 1)} a year (XIRR)`;
    renderHomeChart(); renderNext(); renderHomeTable();
  }

  function renderHomeTable() {
    const gs = groups('cat').filter(g => !g.err);
    const t = totals(results);
    const c = colors();
    const row = (name, col, tt, isTotal) => `<tr class="${isTotal ? 'total' : ''}"><td>${col ? `<span class="dot" style="--c:${col}"></span>` : ''}${esc(name)}</td><td>${tt.n}</td><td class="n">${full(tt.net)}</td><td class="n">${full(tt.value)}</td><td class="n ${signCls(tt.gain)}">${tt.net > 0 ? signed(tt.gain / tt.net, x => pct(x, 1)) : '—'}</td><td class="n">${tt.xirr != null ? pct(tt.xirr, 1) : '—'}</td></tr>`;
    $('#homeTable').innerHTML = '<thead><tr><th>Category</th><th>Funds</th><th>Put in</th><th>Worth today</th><th>Gain</th><th>XIRR</th></tr></thead><tbody>' +
      gs.map((g, i) => row(g.name, seriesColor(c, i), g.t)).join('') + (gs.length > 1 ? row('All', null, t, true) : '') + '</tbody>';
  }

  /** Upcoming instalments: SIPs added by hand, and SIPs seen in a recent statement. */
  function upcoming() {
    const today = todayMs(), out = [];
    const nextOn = (day, from) => {
      const d = new Date(from);
      for (let i = 0; i < 3; i++) {
        const y = d.getUTCFullYear(), m = d.getUTCMonth() + i;
        const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        const t = Date.UTC(y, m, Math.min(day, dim));
        if (t >= from) return t;
      }
      return null;
    };
    for (const r of results) {
      const h = r.h;
      const s = sipOf(h);
      if (h.kind === 'cas' && s && s.source === 'you') {
        // Details you gave a statement fund: its day and amount.
        if (!s.running || !s.day) continue;
        const t = nextOn(s.day, today);
        if (t == null) continue;
        const d = new Date(t), m = d.getUTCFullYear() * 12 + d.getUTCMonth(), from = s.start ? Calc.monthNo(s.start) : m;
        const now = Calc.monthOf(today);
        out.push({ t, amount: s.amount * (m > now && m > from && (m - from) % 12 === 0 && s.step > 0 ? 1 + s.step / 100 : 1), r, est: false });
        continue;
      }
      if (h.kind === 'cas' && s === null && h.sip && h.sip.none) continue;
      if (h.kind === 'sip') {
        if (h.end && h.end < msToIso(today).slice(0, 7)) continue;
        const t = nextOn(h.day, today);
        if (t == null) continue;
        const [sy, sm] = h.start.split('-').map(Number), d = new Date(t);
        const k = (d.getUTCFullYear() - sy) * 12 + (d.getUTCMonth() + 1 - sm);
        if (k < 0) continue;
        out.push({ t, amount: h.amount * Math.pow(1 + (h.step || 0) / 100, Math.floor(k / 12)), r, est: false });
      } else if (h.kind === 'cas' && h.asOf && today - isoToMs(h.asOf) < 45 * DAY) {
        // A statement from the last few weeks: the next SIP should follow its last instalment.
        const sips = (h.txns || []).filter(x => x.type === 'PURCHASE_SIP');
        const last = sips[sips.length - 1];
        if (!last || isoToMs(h.asOf) - isoToMs(last.date) > 40 * DAY) continue;
        const stamp = (h.txns || []).filter(x => x.date === last.date && x.type === 'STAMP_DUTY_TAX').reduce((s, x) => s + Math.abs(x.amount || 0), 0);
        const t = nextOn(+last.date.slice(8, 10), Math.max(today, isoToMs(last.date) + DAY));
        if (t != null) out.push({ t, amount: Math.round(Math.abs(last.amount) + stamp), r, est: true });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }
  function renderNext() {
    const list = upcoming(), soon = list.filter(x => x.t - todayMs() <= 31 * DAY);
    const cas = results.some(r => r.h.kind === 'cas');
    const fresh = results.some(r => r.h.kind === 'cas' && r.h.asOf && todayMs() - isoToMs(r.h.asOf) < 45 * DAY);
    $('#homeNextSum').textContent = soon.length ? `${full(soon.reduce((s, x) => s + x.amount, 0))} in the next month` : '';
    const MON = t => new Date(t).toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' });
    $('#homeNextList').innerHTML = list.slice(0, 5).map(x => {
      const f = fundOf(x.r);
      return `<li><span class="day"><b>${new Date(x.t).getUTCDate()}</b><small>${MON(x.t)}</small></span>
        <span class="who"><b>${esc(nameOf(x.r))}</b><small>${esc(f ? shortCategory(f.k) + ' · ' + f.p : '')}${x.est ? ' · expected, like your last instalment' : ''}</small></span>
        <span class="amt">${full(x.amount)}</span></li>`;
    }).join('') || `<li class="none">${cas && !fresh ? 'Your statement is more than a few weeks old. Import a recent one to see your next SIPs.' : 'No running SIPs yet.'}</li>`;
  }

  function renderHomeChart() {
    const box = $('#homeChartBox'), seg = $('#homeRange');
    if (!seg.dataset.done) {
      seg.dataset.done = '1';
      seg.innerHTML = RANGES.map(([v, l]) => `<button type="button" class="seg-btn" data-range="${v}" aria-pressed="${view.range === v}">${l}</button>`).join('');
      seg.addEventListener('click', e => {
        const b = e.target.closest('[data-range]'); if (!b) return;
        view.range = b.dataset.range; saveView();
        $$('#homeRange [data-range]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.range === view.range)));
        renderHomeChart();
      });
    }
    if (homeChart) { homeChart.destroy(); homeChart = null; }
    if (typeof window.Chart === 'undefined') { box.innerHTML = '<div class="chart-fallback">The chart library did not load. The figures are still accurate.</div>'; return; }
    if (!$('#homeChart')) box.innerHTML = '<canvas id="homeChart" role="img" aria-label="Worth and money put in over time"></canvas>';
    const s = series(results);
    if (!s) return;
    let i0 = 0;
    if (view.range !== 'all') {
      const d = new Date(s.grid[s.grid.length - 1]); d.setUTCFullYear(d.getUTCFullYear() - +view.range);
      i0 = Math.max(0, s.grid.findIndex(t => t >= d.getTime()));
    }
    const c = colors(), xs = s.grid.slice(i0);
    homeChart = new window.Chart($('#homeChart'), {
      type: 'line',
      data: { datasets: [
        { label: 'Worth', data: xs.map((t, i) => ({ x: t, y: s.value[i0 + i] })), borderColor: c.stamp, backgroundColor: hexA(c.stamp, .1), fill: 'origin', borderWidth: 2.4, pointRadius: 0, tension: 0 },
        { label: 'Money put in', data: xs.map((t, i) => ({ x: t, y: s.inv[i0 + i] })), borderColor: c.c2, borderDash: [5, 4], borderWidth: 1.8, pointRadius: 0, stepped: true, fill: false }
      ] },
      options: {
        parsing: false, normalized: true, animation: false, responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: Object.assign(tooltip(c), { callbacks: { title: it => fmtDate(it[0].parsed.x), label: ctx => ` ${ctx.dataset.label}: ${cmp(ctx.parsed.y)}` } }) },
        scales: {
          x: Object.assign(timeAxis(c, xs[xs.length - 1] - xs[0]), { min: xs[0], max: xs[xs.length - 1] }),
          y: { grid: { color: c.rule }, border: { display: false }, beginAtZero: true, ticks: { color: c.muted, maxTicksLimit: 5, font: { family: 'IBM Plex Sans', size: 11.5 }, callback: v => MF.tick(v) } }
        }
      }
    });
  }

  function renderSummary() {
    const t = totals(results);
    $('#pfSum').textContent = t.first == null ? '' : `${cmp(t.value)} today across ${t.n} investment${t.n === 1 ? '' : 's'}`;
    const fig = (k, v, d, cls) => `<div><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;
    $('#pfFigures').innerHTML = t.first == null ? '<p class="muted">None of these investments could be valued yet.</p>' :
      fig('Worth today', full(t.value), t.last ? `NAVs of ${fmtDate(t.last)}` : '') +
      fig('Put in', full(t.net), t.moneyOut > 0 ? `${cmp(t.moneyIn)} in, ${cmp(t.moneyOut)} out` : `since ${fmtMonth(t.first)}`) +
      fig('Gain', signed(t.gain, full), t.net > 0 ? `${pct(t.gain / t.net, 1)} of what you put in` : '', signCls(t.gain)) +
      fig('Yearly return (XIRR)', t.xirr != null ? pct(t.xirr, 1) : '—', 'counts when each rupee went in', t.xirr != null && t.xirr < 0 ? 'loss' : '') +
      sipFigure();
  }

  function sipFigure() {
    const sips = results.map(r => sipOf(r.h)).filter(Boolean);
    if (!sips.length) return '';
    const on = sips.filter(x => x.running), off = sips.length - on.length;
    const monthly = on.reduce((s2, x) => s2 + x.amount, 0);
    return `<div><div class="k">Monthly SIPs</div><div class="v">${full(monthly)}</div><div class="d">${on.length} running${off ? `, ${off} stopped` : ''} · <button type="button" class="linkish" data-group-sip>see which</button></div></div>`;
  }

  /* ---------- SIP details: for a statement fund, or to change a SIP you entered ---------- */
  let sipFor = null;
  function openSip(id) {
    const h = P.holdings.find(x => x.id === id);
    if (!h || h.kind === 'lump') return;
    sipFor = h;
    const cas = h.kind === 'cas', seen = cas ? Calc.inferSip(h) : null, s = sipOf(h);
    const base = cas ? (h.sip && +h.sip.amount > 0 ? h.sip : seen) : h;
    $('#sipFund').textContent = h.name || '';
    $('#sipAmtLbl').textContent = cas ? 'Monthly amount now' : 'Amount of the first SIP';
    $('#sipNote').textContent = cas
      ? (h.sip && h.sip.none ? "You said this fund has no SIP." : h.sip && +h.sip.amount > 0 ? 'These are the details you gave. Your statement still decides the units and value.'
        : seen ? `Your statement shows ${seen.count} SIP instalment${seen.count === 1 ? '' : 's'}, from ${fmtMonth(isoToMs(seen.start + '-01'))} to ${fmtDate(seen.last)}${seen.running ? ', so it looks like it is still running' : ', and none since'}. Check the details and add a step-up; the statement's own units and value don't change.`
        : "Your statement shows no SIP instalments in this fund. If you have one, add it here.")
      : 'Changing these reprices the SIP from its first instalment.';
    $('#sipAmt').value = base ? Math.round(base.amount) : '';
    $('#sipDay').value = base && base.day ? base.day : '';
    $('#sipStart').value = base && base.start ? base.start : '';
    const running = s ? s.running : true;
    $$('input[name="sip-status"]').forEach(x => { x.checked = x.value === (running ? 'on' : 'off'); });
    $('#sipEnd').value = (s && s.end) || (base && base.end) || '';
    $('#sipEndField').hidden = running;
    $('#sipStep').value = base && base.step ? base.step : 0;
    $('#sipCasActs').hidden = !cas;
    $('#sipReset').hidden = !(h.sip);
    $('#sipMsg').textContent = ''; $('#sipMsg').classList.remove('bad');
    window.Shell.openPanel('panelSip', '#sipAmt');
  }
  function saveSip() {
    const h = sipFor; if (!h) return;
    const say = (t, bad) => { $('#sipMsg').textContent = t; $('#sipMsg').classList.toggle('bad', !!bad); };
    const amount = +$('#sipAmt').value, day = Math.round(+$('#sipDay').value), start = $('#sipStart').value;
    const running = ($$('input[name="sip-status"]').find(x => x.checked) || {}).value !== 'off';
    const end = running ? null : $('#sipEnd').value || null, step = Math.max(0, +$('#sipStep').value || 0);
    const nowMonth = msToIso(todayMs()).slice(0, 7);
    if (!(amount >= 100)) { say('Enter an amount of at least ₹100.', true); return; }
    if (!(day >= 1 && day <= 28)) { say('Pick a debit day between 1 and 28.', true); return; }
    if (!/^\d{4}-\d{2}$/.test(start)) { say('Enter the month of the first SIP.', true); return; }
    if (start > nowMonth) { say("The first SIP can't be in the future.", true); return; }
    if (!running && !/^\d{4}-\d{2}$/.test(end || '')) { say('Enter the month it stopped.', true); return; }
    if (end && end < start) { say('The stop month is before the first SIP.', true); return; }
    if (step > 100) { say('A step-up above 100% a year is unlikely. Check the number.', true); return; }
    if (h.kind === 'cas') h.sip = { amount: Math.round(amount), day, start, end, step };
    else Object.assign(h, { amount: Math.round(amount), day, start, end, step });
    save(); refresh();
    window.Shell.closePanel();
  }

  /** A pill that opens the fund house's own website, where you log in. */
  function loginPill(amc) {
    const site = amcSite(amc);
    if (!site) return '';
    return `<a class="login" href="${esc(site.url)}" target="_blank" rel="noopener" aria-label="Log in at ${esc(site.name)}, on its website">Log in at ${esc(shortAmc(site.name))}${icon('out')}</a>`;
  }

  let portals = [];                 // MF Central, CAMS, KFintech from data/links.json
  const RTA_ID = { CAMS: 'cams', KFINTECH: 'kfintech' };
  const RTA_NAME = { CAMS: 'CAMS', KFINTECH: 'KFintech' };

  /* What the statement says about a fund beyond its money: folio, registrar, nominees, KYC, exit load. */
  function casDetails(r) {
    const h = r.h;
    if (h.kind !== 'cas') return '';
    const row = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`, rows = [];
    if (oldName(r)) rows.push(row('Name on your statement', esc(oldName(r))));
    if (h.folio) {
      rows.push(row('Folio', `<span class="folio" data-full="${esc(h.folio)}" data-short="••••${esc(folioEnd(h.folio))}">••••${esc(folioEnd(h.folio))}</span>
        <button type="button" class="linkish" data-folio aria-pressed="false">Show</button>`));
    }
    if (h.rta) {
      const p = portals.find(x => x.id === RTA_ID[h.rta]);
      rows.push(row('Registrar', `${esc(RTA_NAME[h.rta] || h.rta)}${p ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">Service and statements at ${esc(p.name)}${icon('out')}</a>` : ''}`));
    }
    if (h.advisor) rows.push(row('Distributor', h.advisor === 'DIRECT' ? 'None: bought direct' : `${esc(h.advisor)} <small class="muted">is paid a commission out of this plan's expenses</small>`));
    if (Array.isArray(h.nominees)) rows.push(row('Nominees', h.nominees.length ? h.nominees.map(esc).join(', ') : '<span class="warn-text">None on the statement</span>'));
    if (h.kyc || h.panOk != null) rows.push(row('KYC and PAN', [h.kyc ? `KYC ${esc(h.kyc === 'OK' ? 'OK' : h.kyc.toLowerCase())}` : '', h.panOk == null ? '' : h.panOk ? 'PAN OK' : '<span class="warn-text">PAN not OK</span>'].filter(Boolean).join(' · ')));
    if (h.demat) rows.push(row('Held', 'In your demat account'));
    if (h.stmt && h.stmt.value != null) rows.push(row('Statement', `Worth ${full(h.stmt.value)} on ${fmtDate(h.stmt.date)}${h.stmt.cost != null ? `, cost of the units held ${full(h.stmt.cost)}` : ''}`));
    if (h.load) rows.push(row('Exit load', `<span class="load">${esc(h.load)}</span>`));
    if (!rows.length) return '';
    return `<details class="hold-more"><summary>Folio, nominees and exit load</summary><dl>${rows.join('')}</dl></details>`;
  }

  const navText = v => v == null ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  function holdingHtml(r) {
    const h = r.h, name = esc(nameOf(r));
    const goal = (h.goal || '').trim();
    const goalBtn = `<button type="button" class="tagchip" data-goal="${esc(h.id)}" aria-label="${goal ? `Goal: ${esc(goal)}. Change it` : 'Set a goal'}">${icon('tag')}${goal ? esc(goal) : 'Set a goal'}</button>`;
    const actions = `<span class="hold-actions"><button type="button" class="linkish" data-remove="${esc(h.id)}" aria-label="Remove ${name}">Remove</button></span>`;
    const login = loginPill(amcOf(r));
    if (r.error) {
      return `<article class="hold"><div class="hold-top"><span class="hold-name">${name}</span></div>
        <div class="hold-meta"><span>${describe(r)}</span></div><p class="hold-err">${esc(r.error)}</p>
        <div class="hold-tags">${sipChip(r)}${login}${goalBtn}${actions}</div>${casDetails(r)}</article>`;
    }
    const check = r.unitsMatch == null ? '' : r.unitsMatch
      ? `<span class="tagchip ok">${icon('check')}Units match your statement</span>`
      : `<span class="tagchip warn">Statement says ${units(h.closeUnits)} units</span>`;
    const g = r.net > 0 ? r.gain / r.net : null;
    const lock = r.lock && r.lock.units > 0.0005
      ? `<span class="tagchip" title="ELSS units can be sold 3 years after each purchase">${icon('lock')}${cmp(r.lock.value)} locked, next free ${fmtDate(r.lock.next)}</span>`
      : r.lock ? `<span class="tagchip ok">${icon('lock')}No units locked</span>` : '';
    const kyc = r.h.kind === 'cas' && ((r.h.kyc && r.h.kyc !== 'OK') || r.h.panOk === false)
      ? `<span class="tagchip warn">${r.h.panOk === false ? 'PAN not OK' : `KYC ${esc(r.h.kyc.toLowerCase())}`} on the statement</span>` : '';
    return `<article class="hold">
      <div class="hold-top"><span class="hold-name">${name}</span><span class="hold-worth">${full(r.value)}</span></div>
      <div class="hold-meta"><span>${describe(r)}</span><span class="pct ${signCls(r.gain)}">${g != null ? signed(g, x => pct(x, 1)) : ''}</span></div>
      <div class="hold-nums">${r.closed ? `<span>In <b>${full(r.moneyIn)}</b> · out <b>${full(r.moneyOut)}</b></span>` : `<span>Put in <b>${full(r.net)}</b></span>`}<span>Gain <b class="${signCls(r.gain)}">${signed(r.gain, full)}</b></span><span>XIRR <b>${r.xirr != null ? pct(r.xirr, 1) : '—'}</b></span>${r.closed
        ? `<span>No units left · last transaction ${fmtDate(r.lastT)}</span>`
        : `<span>${units(r.units)} units × NAV <b>₹${navText(r.lastNav)}</b> of ${fmtDate(r.lastT)}</span>${r.dayBase > 0 ? `<span>Since ${fmtDate(r.prevT)} <b class="${signCls(r.dayChange)}">${signed(r.dayChange, full)}</b></span>` : ''}`}</div>
      ${oldName(r) && r.h.kind !== 'cas' ? `<p class="muted small">AMFI now calls it this; you added it as “${esc(oldName(r))}”.</p>` : ''}
      ${r.warn.length ? `<p class="muted small">${r.warn.map(esc).join(' ')}</p>` : ''}
      <div class="hold-tags">${sipChip(r)}${check}${lock}${kyc}${login}${goalBtn}${actions}</div>
      ${casDetails(r)}
    </article>`;
  }

  function renderGroups() {
    $$('input[name="pf-group"]').forEach(x => { x.checked = x.value === view.group; });
    const gs = groups(view.group), c = colors();
    const keyOf = g => view.group + ':' + g.name;
    if (!gs.some(g => opened.has(keyOf(g))) && gs.length) opened.add(keyOf(gs[0]));
    $('#pfGroups').innerHTML = gs.map((g, i) => {
      const k = keyOf(g), isOpen = opened.has(k) || gs.length === 1;
      const gain = g.t.net > 0 ? g.t.gain / g.t.net : null;
      const n = g.rs.length;
      const bad = g.rs.filter(r => r.error).length;
      const monthly = view.group === 'sip' && g.name === 'SIP running' ? g.rs.reduce((s2, r) => s2 + (sipOf(r.h) || { amount: 0 }).amount, 0) : 0;
      const sub = g.err ? `${n} investment${n === 1 ? '' : 's'}${g.name === "Couldn't be valued" ? '' : ", couldn't be valued"}`
        : `${n} fund${n === 1 ? '' : 's'}${monthly ? ` · ${full(monthly)} a month` : ''}${g.t.xirr != null ? ` · XIRR ${pct(g.t.xirr, 1)}` : ''}${bad ? ` · ${bad} not valued` : ''}`;
      const login = view.group === 'amc' ? loginPill(g.name) : '';
      return `<section class="card grp" style="--c:${g.err ? 'var(--line-2)' : seriesColor(c, i)}">
        <button type="button" class="grp-head" data-grp="${esc(k)}" aria-expanded="${isOpen}">
          <span class="grp-bar"></span>
          <span class="grp-name"><b>${esc(g.name)}</b><small>${sub}</small></span>
          ${g.err ? '' : `<span class="grp-fig"><b>${full(g.t.value)}</b><small class="${signCls(g.t.gain)}">${gain != null ? signed(gain, x => pct(x, 1)) : ''}</small></span>`}
          ${icon('chev', 'chev')}
        </button>
        ${login ? `<div class="grp-links">${login}</div>` : ''}
        <div class="grp-body"${isOpen ? '' : ' hidden'}>${g.rs.map(holdingHtml).join('')}</div>
      </section>`;
    }).join('');
  }

  function renderNotes() {
    const notes = [];
    if (results.some(r => r.h.kind !== 'cas')) notes.push('SIPs and one-time amounts you enter are priced at the first NAV on or after the date, less 0.005% stamp duty from July 2020. Your real allotment can land a day or two later, so these are close estimates. Import your CAS for exact units.');
    (P.casWarnings || []).forEach(w => notes.push('Statement: ' + esc(w)));
    const noNominee = new Set(results.filter(r => r.h.kind === 'cas' && Array.isArray(r.h.nominees) && !r.h.nominees.length && (r.units > 0 || r.error)).map(r => folioEnd(r.h.folio) + '|' + (r.h.amc || '')));
    if (noNominee.size) notes.push(`${noNominee.size === 1 ? 'One folio shows' : noNominee.size + ' folios show'} no nominee on your statement. If you haven't opted out of nomination, add one at the fund house, its registrar or MF Central. Open <b>Folio, nominees and exit load</b> on a fund to see which.`);
    $('#pfNotes').innerHTML = notes.length ? `<ul class="notes-list">${notes.map(n => `<li>${n}</li>`).join('')}</ul>` : '';
  }

  function renderStatementCard() {
    const cas = results.filter(r => r.h.kind === 'cas');
    $('#pfStatementCard').hidden = !cas.length;
    if (!cas.length) return;
    const per = P.casPeriod || {};
    const tx = cas.reduce((s, r) => s + (r.h.txns || []).length, 0);
    const checked = cas.filter(r => r.unitsMatch != null), ok = checked.filter(r => r.unitsMatch).length;
    $('#pfStatementText').textContent = `${per.from ? `${fmtDate(per.from)} to ${fmtDate(per.to)} · ` : ''}${tx.toLocaleString('en-IN')} transactions · units match for ${ok} of ${checked.length} fund${checked.length === 1 ? '' : 's'}. It was read on your device; the PDF was never uploaded.`;
  }

  function renderScopeOptions() {
    const s = $('#pfScope');
    const opts = ['<option value="all">All investments</option>'].concat(P.holdings.map(h => `<option value="${esc(h.id)}">${esc(h.name || 'Scheme ' + h.code)}${h.kind === 'sip' ? ' (SIP)' : h.kind === 'lump' ? ' (one-time)' : ''}</option>`));
    s.innerHTML = opts.join('');
    if (view.scope !== 'all' && !P.holdings.some(h => h.id === view.scope)) view.scope = 'all';
    s.value = view.scope;
    picker(s, { minWidth: 280, title: 'Show on the chart' });
    refreshPickers();
    $$('input[name="pf-mode"]').forEach(r => { r.checked = r.value === view.mode; });
  }
  function renderGoalList() {
    const goals = [...new Set(P.holdings.map(h => (h.goal || '').trim()).filter(Boolean))].sort();
    $('#pfGoalList').innerHTML = goals.concat(['Retirement', "Child's education", 'House', 'Tax saving', 'Emergency fund'].filter(g => !goals.includes(g)))
      .map(g => `<option value="${esc(g)}"></option>`).join('');
  }

  function renderChart() {
    if (typeof window.Chart === 'undefined') { $('#pfChartBox').innerHTML = '<div class="chart-fallback">The chart library did not load. The figures are still accurate.</div>'; return; }
    if (!$('#pfChart')) $('#pfChartBox').innerHTML = '<canvas id="pfChart" role="img" aria-label="Portfolio value over time"></canvas>';
    const list = view.scope === 'all' ? results : results.filter(r => r.h.id === view.scope);
    const s = series(list);
    if (chart) { chart.destroy(); chart = null; }
    if (!s) return;
    const c = colors(), gain = view.mode === 'gain', type = charts.time, bars = type === 'bar';
    const tip = Object.assign(tooltip(c), { callbacks: { title: it => bars ? it[0].label : fmtDate(it[0].parsed.x), label: ctx => ctx.parsed.y == null ? null : ` ${ctx.dataset.label}: ${cmp(ctx.parsed.y)}` } });
    const legend = { display: !gain, position: 'bottom', labels: { color: c['ink-2'], usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 16, font: { family: 'IBM Plex Sans', size: 12.5 } } };
    const yAxis = { grid: { color: c.rule }, border: { display: false }, ticks: { color: c.muted, maxTicksLimit: 6, font: { family: 'IBM Plex Sans', size: 11.5 }, callback: v => MF.tick(v) } };
    if (bars) {
      // One column per calendar year (its value at the year's end), and today.
      const pts = [];
      s.grid.forEach((t, i) => {
        const y = new Date(t).getUTCFullYear();
        const next = s.grid[i + 1];
        if (next == null || new Date(next).getUTCFullYear() !== y) pts.push({ label: next == null ? 'Today' : String(y), i });
      });
      const val = i => gain ? s.value[i] - s.inv[i] : s.value[i];
      const ds = [{ type: 'bar', label: gain ? 'Gain' : 'Worth', data: pts.map(p => val(p.i)),
        backgroundColor: pts.map(p => gain && val(p.i) < 0 ? c.wd : hexA(c.stamp, .85)), hoverBackgroundColor: c.stamp,
        borderRadius: 4, borderSkipped: 'start', maxBarThickness: 26, order: 2 }];
      if (!gain) ds.push({ type: 'line', label: 'Money put in, net', data: pts.map(p => s.inv[p.i]), borderColor: c.c2, backgroundColor: c.c2, borderWidth: 1.8, pointRadius: 3, pointBackgroundColor: c.sheet, pointBorderWidth: 1.5, tension: 0, order: 1 });
      chart = new window.Chart($('#pfChart'), {
        type: 'bar', data: { labels: pts.map(p => p.label), datasets: ds },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
          plugins: { legend, tooltip: tip },
          scales: { x: { grid: { display: false }, border: { color: c['rule-2'] }, ticks: { color: c.muted, maxRotation: 0, autoSkipPadding: 10, font: { family: 'IBM Plex Sans', size: 11.5 } } }, y: yAxis }
        }
      });
      return;
    }
    const fill = type === 'area';
    const ds = gain
      ? [{ label: 'Gain', data: s.grid.map((t, i) => ({ x: t, y: s.value[i] - s.inv[i] })), borderColor: c.ok, backgroundColor: hexA(c.ok, .12), fill: fill ? 'origin' : false, borderWidth: 2, pointRadius: 0, tension: 0 }]
      : [
        { label: 'Worth', data: s.grid.map((t, i) => ({ x: t, y: s.value[i] })), borderColor: c.stamp, backgroundColor: hexA(c.stamp, .12), fill: fill ? 'origin' : false, borderWidth: 2.2, pointRadius: 0, tension: 0 },
        { label: 'Money put in, net', data: s.grid.map((t, i) => ({ x: t, y: s.inv[i] })), borderColor: c.c2, backgroundColor: c.c2, borderDash: [6, 5], borderWidth: 1.8, pointRadius: 0, stepped: true }
      ];
    chart = new window.Chart($('#pfChart'), {
      type: 'line',
      data: { datasets: ds },
      options: {
        parsing: false, normalized: true, animation: false, responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend, tooltip: tip },
        scales: { x: Object.assign(timeAxis(c, s.grid[s.grid.length - 1] - s.grid[0]), { min: s.grid[0], max: s.grid[s.grid.length - 1] }), y: yAxis }
      }
    });
  }

  /* ---------- what you hold (Home) ---------- */
  function mixGroups() {
    let rows = groups(charts.by).filter(g => !g.err && g.t.value > 0.5).map(g => ({ name: g.name, value: g.t.value }));
    const total = rows.reduce((s, r) => s + r.value, 0);
    // Five named slices at most; the rest fold into Other, so colours stay tellable apart.
    if (rows.length > 6) {
      const tail = rows.slice(5);
      rows = rows.slice(0, 5).concat([{ name: `Other (${tail.length})`, value: tail.reduce((s, r) => s + r.value, 0), other: true }]);
    }
    return { rows, total };
  }

  function renderMix() {
    const { rows, total } = mixGroups();
    const box = $('#homeMix');
    box.hidden = !rows.length;
    if (mixChart) { mixChart.destroy(); mixChart = null; }
    if (!rows.length) return;
    const c = colors(), type = charts.mix, isBar = type === 'bar';
    const col = (r, i) => r.other ? MF.cssVar('--c-other') : c['c' + (i + 1)];
    const share = v => total > 0 ? v / total : 0;
    $('#pfMixLegend').innerHTML = rows.map((r, i) =>
      `<li style="--c:${col(r, i)}"><i></i><span class="nm" title="${esc(r.name)}">${esc(r.name)}</span><span class="v">${cmp(r.value)}</span><span class="s">${pct(share(r.value), 0)}</span></li>`).join('');
    $('.mix-body', box).classList.toggle('bars', isBar);
    if (typeof window.Chart === 'undefined') { $('#pfMixBox').innerHTML = '<div class="chart-fallback">The chart library did not load. The list has every figure.</div>'; return; }
    if (!$('#pfMixChart')) $('#pfMixBox').innerHTML = '<canvas id="pfMixChart" role="img" aria-label="What you hold, by share of today\'s worth"></canvas>';
    const tip = Object.assign(tooltip(c), { callbacks: { title: it => rows[it[0].dataIndex].name, label: ctx => ` ${cmp(rows[ctx.dataIndex].value)}, ${pct(share(rows[ctx.dataIndex].value), 1)} of the total` } });
    if (isBar) {
      $('#pfMixBox').style.height = (rows.length * 40 + 30) + 'px';
      mixChart = new window.Chart($('#pfMixChart'), {
        type: 'bar',
        data: { labels: rows.map(r => r.name.length > 28 ? r.name.slice(0, 26) + '…' : r.name), datasets: [{ data: rows.map(r => r.value), backgroundColor: rows.map(r => r.other ? MF.cssVar('--c-other') : c.c1), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 22 }] },
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: false, layout: { padding: { right: 48 } },
          plugins: { legend: { display: false }, tooltip: tip, barValues: { format: v => pct(share(v), 0), color: c['ink-2'] } },
          scales: {
            x: { grid: { color: c.rule }, border: { display: false }, ticks: { color: c.muted, maxTicksLimit: 4, font: { family: 'IBM Plex Sans', size: 11.5 }, callback: v => MF.tick(v) } },
            y: { grid: { display: false }, border: { color: c['rule-2'] }, ticks: { color: c['ink-2'], autoSkip: false, font: { family: 'IBM Plex Sans', size: 12 } } }
          }
        }
      });
      return;
    }
    $('#pfMixBox').style.height = '';
    mixChart = new window.Chart($('#pfMixChart'), {
      type: 'doughnut',
      data: { labels: rows.map(r => r.name), datasets: [{ data: rows.map(r => r.value), backgroundColor: rows.map(col), borderColor: c.sheet, borderWidth: 2, hoverOffset: 4 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, cutout: type === 'donut' ? '62%' : 0, layout: { padding: 4 },
        plugins: { legend: { display: false }, tooltip: tip, donutCenter: { text: String(results.filter(r => !r.error).length), caption: 'funds', color: c.ink, sub: c.muted, size: 18 } }
      }
    });
  }

  /* ---------- adding a fund by hand ---------- */
  function chooseFund(f) {
    sel = f;
    $('#pfFund').value = f.n;
    $('#pfFundHint').textContent = `${f.p} plan, ${f.o} option, scheme ${f.c}. Latest NAV ₹${f.v} on ${fmtDate(f.d)}.`;
  }
  function msg(t, bad) { const el = $('#pfAddMsg'); el.textContent = t; el.classList.toggle('bad', !!bad); }
  function addFromForm() {
    const raw = $('#pfFund').value.trim();
    if (sel && raw !== sel.n) sel = null;
    if (!sel && /^\d{5,6}$/.test(raw)) sel = (D && D.byCode.get(+raw)) || { c: +raw, n: `Scheme ${raw}` };
    if (!sel) { msg('Pick a fund from the list first, or type its AMFI scheme code.', true); return; }
    const kind = ($$('input[name="pf-kind"]').find(r => r.checked) || {}).value || 'sip';
    const goal = $('#pfGoal').value.trim().slice(0, 40);
    const nowMonth = msToIso(todayMs()).slice(0, 7);
    if (kind === 'sip') {
      const amount = +$('#pfAmt').value, day = Math.round(+$('#pfDay').value), start = $('#pfStart').value, end = $('#pfEnd').value || null, step = Math.max(0, +$('#pfStep').value || 0);
      if (!(amount >= 100)) { msg('Enter a SIP amount of at least ₹100.', true); return; }
      if (!(day >= 1 && day <= 28)) { msg('Pick a debit day between 1 and 28.', true); return; }
      if (!/^\d{4}-\d{2}$/.test(start)) { msg('Enter the month your SIP started.', true); return; }
      if (start > nowMonth) { msg("The start month can't be in the future.", true); return; }
      if (end && end < start) { msg('The stop month is before the start month.', true); return; }
      P.holdings.push(Object.assign({ id: newId(), kind: 'sip', code: sel.c, name: sel.n, amount, day, start, end, step }, sel.a ? { amc: sel.a } : {}, goal ? { goal } : {}));
      msg(`Added a ${full(amount)} SIP in ${sel.n}.`);
    } else {
      const amount = +$('#pfLumpAmt').value, date = $('#pfLumpDate').value;
      if (!(amount > 0)) { msg('Enter the amount you invested.', true); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { msg('Enter the date you invested.', true); return; }
      if (isoToMs(date) > todayMs()) { msg("The date can't be in the future.", true); return; }
      P.holdings.push(Object.assign({ id: newId(), kind: 'lump', code: sel.c, name: sel.n, amount, date }, sel.a ? { amc: sel.a } : {}, goal ? { goal } : {}));
      msg(`Added ${full(amount)} in ${sel.n}.`);
    }
    save(); refresh();
  }

  /* ---------- importing a statement ---------- */
  /* A statement is merged, not swapped in: for each fund and folio it replaces the
     transactions inside its own period and keeps older ones from an earlier
     statement. So importing this year's statement after a full one loses nothing. */
  // The last 4 characters of the folio: statements imported before the whole folio was kept stored only those.
  const folioEnd = f => String(f || '').replace(/[^A-Za-z0-9]/g, '').slice(-4);
  const casKey = h => `${h.isin || h.name}|${folioEnd(h.folio)}`;
  /** What the newest statement says about a fund, beyond its transactions. */
  const casFacts = s => ({
    rta: s.rta || null, advisor: s.advisor || null, demat: s.demat ?? null, kyc: s.kyc || null, panOk: s.pan_ok ?? null,
    nominees: Array.isArray(s.nominees) ? s.nominees.slice(0, 3) : null, load: s.load || null,
    stmt: s.valuation ? { date: s.valuation.date || null, nav: s.valuation.nav ?? null, value: s.valuation.value ?? null, cost: s.cost ?? null } : null
  });
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  function importCas(obj) {
    if (!obj || obj.format !== CAS_FORMAT || !Array.isArray(obj.holdings)) throw new Error("This statement couldn't be read.");
    const per = obj.statement_period || {};
    const from = per.from || '0000-01-01', to = per.to || '9999-12-31';
    const old = P.casPeriod || {};
    const mine = new Map(P.holdings.filter(h => h.kind === 'cas').map(h => [casKey(h), h]));
    let added = 0, updated = 0, txns = 0;
    const idle = [], opening = [];
    for (const s of obj.holdings) {
      const tx = (s.txns || []).map(x => ({ date: x.date, type: x.type, amount: x.amount, units: x.units, nav: x.nav }));
      const h = mine.get(casKey(s));
      if (h) {
        h.txns = (h.txns || []).filter(x => x.date < from || x.date > to).concat(tx).sort(byDate);
        const asOf = h.asOf || old.to || '';
        if (to >= asOf) Object.assign(h, { closeUnits: s.close_units ?? null, asOf: to, name: s.name, amc: s.amc, isin: s.isin || h.isin }, casFacts(s));
        if (s.folio && s.folio.length > String(h.folio || '').replace(/•/g, '').length) h.folio = s.folio;
        const since = h.from || old.from || '9999';
        if (from <= since) Object.assign(h, { from, openUnits: s.open_units || 0 });
        updated++;
      } else {
        if (!tx.length) { if (s.close_units > 0) idle.push(s.name); continue; }
        P.holdings.push({
          id: newId(), kind: 'cas', code: null, isin: s.isin || null, name: s.name, amc: s.amc, folio: s.folio,
          closeUnits: s.close_units ?? null, openUnits: s.open_units || 0, from, asOf: to, txns: tx, ...casFacts(s)
        });
        added++;
      }
      txns += tx.length;
    }
    for (const h of P.holdings) if (h.kind === 'cas' && h.openUnits > 0.0005) opening.push(h.name);
    const warn = (obj.warnings || []).slice();
    if (opening.length) warn.push(`${opening.length === 1 ? 'One fund' : opening.length + ' funds'} already held units when your earliest statement starts (${opening.slice(0, 3).join(', ')}${opening.length > 3 ? '…' : ''}). Their value, money in and gain leave those units out. Import a statement that starts before your first investment.`);
    if (idle.length) warn.push(`${idle.length === 1 ? 'One fund' : idle.length + ' funds'} had no transactions in this statement's period, so ${idle.length === 1 ? "it wasn't" : "they weren't"} added (${idle.slice(0, 3).join(', ')}${idle.length > 3 ? '…' : ''}). A statement from before your first investment includes them.`);
    if (old.from && (from > old.to || to < old.from)) warn.push(`This statement (${fmtDate(isoToMs(from))} to ${fmtDate(isoToMs(to))}) doesn't touch the earlier one (${fmtDate(isoToMs(old.from))} to ${fmtDate(isoToMs(old.to))}). Transactions between them are missing.`);
    P.casWarnings = warn;
    P.casPeriod = { from: old.from && old.from < from ? old.from : from, to: old.to && old.to > to ? old.to : to };
    save();
    return { added, updated, txns, idle: idle.length, check: obj.check || null };
  }

  // The PDF is opened as soon as it's chosen; a password is asked for only if it has one.
  let pendingFile = null, importing = false;
  async function importPdf(password) {
    const out = $('#pfImportMsg'), go = $('#pfCasGo'), pw = $('#pfCasPw');
    if (!pendingFile) { out.textContent = 'Choose your statement PDF first.'; return; }
    if (!window.CasReader) { out.textContent = "The statement reader didn't load. Reload the page and try again."; return; }
    if (importing) return;
    importing = true; go.disabled = true;
    out.classList.remove('bad');
    out.textContent = 'Opening the PDF…';
    try {
      const data = await pendingFile.arrayBuffer();
      const obj = await window.CasReader.read(data, password || '', (p, n) => { out.textContent = `Reading page ${p} of ${n}…`; });
      const r = importCas(obj);
      pendingFile = null; pw.value = '';
      $('#pfCasFile').value = ''; $('#pfCasName').textContent = 'With or without a password'; $('#pfCasStep').hidden = true;
      const c = r.check;
      const checked = c ? ` Units add up for ${c.unitsOk} of ${c.schemes} funds on the statement.` : '';
      out.textContent = `Imported ${r.txns} transactions: ${r.added} new ${r.added === 1 ? 'fund' : 'funds'}, ${r.updated} updated.${checked}`;
      init().then(refresh);
    } catch (e) {
      if (e.code === 'needs-password') {
        $('#pfCasStep').hidden = false;
        out.textContent = 'This PDF is locked. Type its password, then press Open and import.';
        setTimeout(() => pw.focus(), 0);
      } else if (e.code === 'wrong-password') {
        $('#pfCasStep').hidden = false;
        out.textContent = e.message; out.classList.add('bad');
        pw.select(); pw.focus();
      } else { out.textContent = e.message || String(e); out.classList.add('bad'); }
    } finally {
      importing = false; go.disabled = false;
    }
  }

  function readFile(input, fn) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let obj;
      try { obj = JSON.parse(reader.result); } catch (e) { fn(null, new Error('That file isn\'t valid JSON.')); return; }
      fn(obj, null);
    };
    reader.readAsText(file);
  }

  function editGoal(id) {
    const h = P.holdings.find(x => x.id === id);
    const btn = $(`[data-goal="${CSS.escape(id)}"]`);
    if (!h || !btn) return;
    const wrap = document.createElement('span');
    wrap.className = 'goal-edit';
    wrap.innerHTML = `<input type="text" list="pfGoalList" maxlength="40" aria-label="Goal for ${esc(h.name || 'this investment')}" placeholder="e.g. Retirement" value="${esc(h.goal || '')}">`;
    btn.replaceWith(wrap);
    const input = $('input', wrap);
    let done = false;
    const finish = keep => {
      if (done) return;
      done = true;
      if (keep) {
        const v = input.value.trim().slice(0, 40);
        if (v !== (h.goal || '')) { if (v) h.goal = v; else delete h.goal; save(); }
      }
      renderGoalList(); renderGroups();
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.focus(); input.select();
  }

  function bind() {
    combo($('#pfFund'), $('#pfFundList'), {
      find: q => { sel = null; $('#pfFundHint').textContent = D ? '' : "The fund list isn't available yet. You can type an AMFI scheme code instead."; return searchFunds(D, q); },
      html: f => `${esc(f.n)}<span class="tagp">${esc(f.p)}</span><span class="tagp">${esc(f.o)}</span><span class="cl-meta">${esc(f.a)}, ${esc(shortCategory(f.k))}, scheme ${f.c}</span>`,
      pick: chooseFund
    });
    $$('input[name="pf-kind"]').forEach(r => r.addEventListener('change', () => {
      const lump = r.checked && r.value === 'lump';
      if (r.checked) { $('#pfSipFields').hidden = lump; $('#pfLumpFields').hidden = !lump; }
    }));
    $('#pfAdd').addEventListener('click', addFromForm);

    $('#pfCasFile').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      pendingFile = f;
      $('#pfCasName').textContent = f.name;
      $('#pfCasStep').hidden = true; $('#pfCasPw').value = '';
      importPdf('');
    });
    $('#pfCasGo').addEventListener('click', () => importPdf($('#pfCasPw').value));
    $('#pfCasPw').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); importPdf($('#pfCasPw').value); } });

    $('#pfExport').addEventListener('click', () => {
      download(`portfolio-backup-${msToIso(todayMs())}.json`, JSON.stringify({ format: BACKUP_FORMAT, saved: new Date().toISOString(), ...P }, null, 1));
    });
    $('#pfRestore').addEventListener('change', e => readFile(e.target, (obj, err) => {
      const out = $('#pfBackupNote');
      if (err) { out.textContent = err.message; return; }
      if (!obj || obj.format !== BACKUP_FORMAT || !Array.isArray(obj.holdings)) { out.textContent = "That isn't a backup from this page."; return; }
      if (P.holdings.length && !window.confirm(synced() ? 'Replace everything on this page, in your Google Sheet and on your other synced devices with the backup?' : 'Replace everything on this page with the backup?')) return;
      P = { holdings: obj.holdings, casWarnings: obj.casWarnings || [], casPeriod: obj.casPeriod || null };
      save(); out.textContent = `Restored ${P.holdings.length} investments.`; refresh();
    }));
    $('#pfClear').addEventListener('click', () => {
      if (!P.holdings.length) return;
      if (!window.confirm(synced()
        ? 'Remove every investment from this page, your Google Sheet and your other synced devices? Download a backup first if you might want them back.'
        : 'Remove every investment from this page? Download a backup first if you might want them back.')) return;
      P = { holdings: [] }; save(); refresh();
    });
    $('#pfGroups').addEventListener('click', e => {
      const head = e.target.closest('[data-grp]');
      if (head) {
        const k = head.dataset.grp, now = head.getAttribute('aria-expanded') !== 'true';
        if (now) opened.add(k); else opened.delete(k);
        head.setAttribute('aria-expanded', String(now));
        const body = $('.grp-body', head.closest('.grp'));
        if (body) body.hidden = !now;
        return;
      }
      const fb = e.target.closest('[data-folio]');
      if (fb) {
        const f = $('.folio', fb.parentElement), on = fb.getAttribute('aria-pressed') !== 'true';
        f.textContent = on ? f.dataset.full : f.dataset.short;
        fb.setAttribute('aria-pressed', String(on)); fb.textContent = on ? 'Hide' : 'Show';
        return;
      }
      const g = e.target.closest('[data-goal]');
      if (g) { editGoal(g.dataset.goal); return; }
      const sp = e.target.closest('[data-sip]');
      if (sp) { openSip(sp.dataset.sip); return; }
      const b = e.target.closest('[data-remove]');
      if (b) {
        const h = P.holdings.find(x => x.id === b.dataset.remove);
        if (!h || !window.confirm(`Remove ${h.name || 'this investment'} from your portfolio${synced() ? ' and your Google Sheet' : ''}?`)) return;
        P.holdings = P.holdings.filter(x => x.id !== h.id); save(); refresh();
      }
    });
    $$('input[name="pf-group"]').forEach(r => r.addEventListener('change', () => { if (r.checked) { view.group = r.value; saveView(); renderGroups(); } }));
    $('#pfFigures').addEventListener('click', e => {
      if (!e.target.closest('[data-group-sip]')) return;
      view.group = 'sip'; saveView(); renderGroups();
      const first = $('#pfGroups .grp-head'); if (first) { first.scrollIntoView({ block: 'start', behavior: 'smooth' }); first.focus({ preventScroll: true }); }
    });
    $$('input[name="sip-status"]').forEach(x => x.addEventListener('change', () => {
      const off = x.checked && x.value === 'off';
      if (x.checked) { $('#sipEndField').hidden = !off; if (off && !$('#sipEnd').value) $('#sipEnd').value = msToIso(todayMs()).slice(0, 7); }
    }));
    $('#sipSave').addEventListener('click', saveSip);
    $('#sipReset').addEventListener('click', () => { if (!sipFor) return; delete sipFor.sip; save(); refresh(); window.Shell.closePanel(); });
    $('#sipNone').addEventListener('click', () => { if (!sipFor) return; sipFor.sip = { none: true }; save(); refresh(); window.Shell.closePanel(); });
    typeSwitch($('#pfType'), { label: 'Chart type', value: charts.time, types: TIME_TYPES, onChange: v => { charts.time = v; setPref('pfTime', v); renderChart(); } });
    typeSwitch($('#pfMixType'), { label: 'Chart type', value: charts.mix, types: MIX_TYPES, onChange: v => { charts.mix = v; setPref('pfMix', v); renderMix(); } });
    $('#pfMixBy').value = charts.by;
    picker($('#pfMixBy'), { title: 'Group by' });
    $('#pfMixBy').addEventListener('change', e => { charts.by = e.target.value; setPref('pfMixBy', charts.by); renderMix(); });
    $('#pfScope').addEventListener('change', e => { view.scope = e.target.value; saveView(); renderChart(); });
    $$('input[name="pf-mode"]').forEach(r => r.addEventListener('change', () => { if (r.checked) { view.mode = r.value; saveView(); renderChart(); } }));
    document.addEventListener('mf:theme', () => { if (inited && results.length) { renderChart(); renderMix(); renderHomeChart(); } });
    document.addEventListener('mf:add-sip', e => {
      const go = () => {
        const f = D && D.byCode.get(e.detail.code);
        if (!f) return;
        chooseFund(f);
        if (window.Shell) window.Shell.openPanel('panelAdd', '#pfAmt');
      };
      if (D) go(); else init().then(go);
    });
    document.addEventListener('mf:panel', e => { if (e.detail.open && (e.detail.id === 'panelAdd' || e.detail.id === 'panelImport')) init(); });
    // New fund data while the page is open: revalue with the new NAVs.
    document.addEventListener('mf:data', async () => {
      if (!initP) return;
      try { D = await loadFunds(); } catch (e) { /* keep the old list */ }
      refresh();
    });
  }

  let initP = null;
  function init() {
    if (initP) return initP;
    inited = true;
    initP = (async () => {
      const m = new Date(); $('#pfStart').value ||= `${m.getFullYear() - 1}-${String(m.getMonth() + 1).padStart(2, '0')}`;
      try { D = await loadFunds(); } catch (e) { D = null; $('#pfFundHint').textContent = "The fund list isn't available yet (the nightly job hasn't built it). You can type an AMFI scheme code, or import your statement."; }
      const links = await loadLinks();
      if (links.portals && links.portals.length) {
        portals = links.portals;
        const list = ['mfcentral', 'cams', 'kfintech'].map(id => links.portals.find(p => p.id === id)).filter(Boolean);
        if (list.length) $('#pfPortals').innerHTML = list.map(p => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener"><span><b>${esc(p.name)}</b>${p.what ? `<small>${esc(p.what)}</small>` : ''}</span>${icon('out')}</a></li>`).join('');
      }
      await refresh();
    })();
    return initP;
  }

  /* For sync.js: read the portfolio, take one merged from other devices, and the latest figures. */
  window.Portfolio = {
    syncGet: () => P,
    syncSet(next) {
      P = next && Array.isArray(next.holdings) ? next : { holdings: [] };
      if (!store.set(KEY, JSON.stringify(P))) $('#pfAddMsg').textContent = "Couldn't save in this browser (storage is full or blocked). Download a backup.";
      if (inited) refresh(); else renderScopeOptions();
    },
    snapshot: () => lastSnapshot,
    /** Each valued holding with its SIP, for the Plan page's forecast. */
    forecastItems: () => results.filter(r => !r.error).map(r => ({ id: r.h.id, name: nameOf(r), value: r.value, net: r.net, sip: sipOf(r.h), kind: r.h.kind, cat: fundOf(r) ? shortCategory(fundOf(r).k) : '' })),
    load: () => init(),
    /** Funds held, for other pages: [{code, name}] */
    held: () => results.filter(r => !r.error).map(r => ({ code: r.code, name: nameOf(r) }))
  };

  bind();
  document.addEventListener('mf:view', e => { if (e.detail.view === 'portfolio' || e.detail.view === 'home') init(); });
})();
