/* My portfolio: your SIPs from inception, valued with AMFI NAVs. Stored in this browser, and in the owner's Google Sheet when sync.js is connected. */
(() => {
  'use strict';
  const { $, $$, esc, full, cmp, pct, units, isoToMs, msToIso, fmtDate, fmtMonth, todayMs, store, hexA, colors,
    loadFunds, loadHistory, idxOnOrBefore, idxOnOrAfter, xirr, timeAxis, tooltip, download, shortCategory, groupLabel, DAY,
    narrow, pref, setPref, typeSwitch, picker, refreshPickers } = MF;

  const KEY = 'mf-portfolio:v1';
  const CAS_FORMAT = 'mf-corpus-planner/cas-v1';
  const BACKUP_FORMAT = 'mf-corpus-planner/portfolio-v1';
  const STAMP_FROM = Date.UTC(2020, 6, 1);   // 0.005% stamp duty on purchases from 1 July 2020
  const STAMP_RATE = 0.00005;

  let P = store.json(KEY, { holdings: [] });
  if (!P || !Array.isArray(P.holdings)) P = { holdings: [] };
  let D = null, inited = false, chart = null, mixChart = null, sel = null, results = [], computeToken = 0, lastSnapshot = null;
  const TIME_TYPES = [['line', 'Line', 'line'], ['area', 'Area', 'area'], ['bar', 'Bars', 'bar']];
  const MIX_TYPES = [['donut', 'Donut', 'donut'], ['pie', 'Pie', 'pie'], ['bar', 'Bars', 'hbar']];
  const charts = {
    time: pref('pfTime', 'area', TIME_TYPES.map(x => x[0])),
    mix: pref('pfMix', 'donut', MIX_TYPES.map(x => x[0])),
    by: pref('pfMixBy', 'fund', ['fund', 'asset', 'cat', 'amc'])
  };
  const view = Object.assign({ scope: 'all', mode: 'value' }, store.json(KEY + ':view', {}));
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
    if (odd) warn.push(`${odd} transfer or adjustment entr${odd === 1 ? 'y' : 'ies'} changed units without a cash amount (gifts, mergers, segregation).`);
    return out.sort((a, b) => a.t - b.t);
  }

  function resolveCode(h) {
    if (h.code) return h.code;
    if (D && h.isin && D.byIsin.has(h.isin)) return D.byIsin.get(h.isin).c;
    return null;
  }

  function describe(h) {
    if (h.kind === 'sip') {
      const since = fmtMonth(isoToMs(h.start + '-01'));
      const until = h.end ? `, stopped ${fmtMonth(isoToMs(h.end + '-01'))}` : '';
      return `SIP ${full(h.amount)} on day ${h.day} from ${since}${until}${h.step > 0 ? `, +${h.step}% a year` : ''}`;
    }
    if (h.kind === 'lump') return `One-time ${full(h.amount)} on ${fmtDate(h.date)}`;
    return `From your statement${h.folio ? `, folio ${esc(h.folio)}` : ''}`;
  }

  async function buildOne(h) {
    const code = resolveCode(h);
    const r = { h, code, warn: [], error: null };
    if (!code) { r.error = "Couldn't match this fund to an AMFI scheme code."; return r; }
    let hist;
    try { hist = await loadHistory(code); } catch (e) { r.error = e.message; return r; }
    r.hist = hist;
    r.events = h.kind === 'sip' ? expandSip(h, hist, r.warn) : h.kind === 'lump' ? expandLump(h, hist, r.warn) : casEvents(h, r.warn);
    r.lastT = hist.t[hist.t.length - 1];
    r.lastNav = hist.v[hist.v.length - 1];
    r.units = r.events.reduce((s, e) => s + e.du, 0);
    if (Math.abs(r.units) < 1e-6) r.units = 0;
    r.moneyIn = r.events.reduce((s, e) => s + Math.max(0, e.inv), 0);
    r.moneyOut = r.events.reduce((s, e) => s + Math.max(0, -e.inv), 0);
    r.net = r.moneyIn - r.moneyOut;
    r.value = r.units * r.lastNav;
    r.gain = r.value - r.net;
    r.first = r.events.length ? r.events[0].t : null;
    r.xirr = xirr(r.events.map(e => ({ t: e.t, v: -e.inv })).concat(r.value > 0 ? [{ t: r.lastT, v: r.value }] : []));
    if (h.kind === 'cas' && h.closeUnits != null) r.unitsMatch = Math.abs((h.openUnits || 0) + r.units - h.closeUnits) < 0.002;
    if (hist.source === 'mfapi') r.warn.push(`NAVs came from MFapi.in because this site doesn't track scheme ${code} yet. Add ${code} to extra_schemes in pipeline/config.json to get checked AMFI NAVs.`);
    if (D && D.navDate && r.lastT < isoToMs(D.navDate) - 4 * DAY && r.units > 0) r.warn.push(`Latest NAV is from ${fmtDate(r.lastT)}, older than the rest of the site's data.`);
    return r;
  }

  function series(list) {
    const valid = list.filter(r => !r.error && r.events.length);
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

  /* ---------- rendering ---------- */
  async function refresh() {
    const token = ++computeToken;
    renderScopeOptions();
    if (!P.holdings.length) { renderEmpty(); return; }
    $('#pfStatement').innerHTML = 'Working out your portfolio…';
    const list = await Promise.all(P.holdings.map(buildOne));
    if (token !== computeToken) return;
    results = list;
    renderSummary(); renderTable(); renderChart(); renderMix(); renderNotes();
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
        const name = r.h.name || (D && D.byCode.get(r.code) ? D.byCode.get(r.code).n : `Scheme ${r.code}`);
        return r.error ? { id: r.h.id, name, kind: r.h.kind, error: r.error }
          : { id: r.h.id, name, kind: r.h.kind, code: r.code, units: Math.round(r.units * 1000) / 1000, net: r2(r.net), value: r2(r.value), gain: r2(r.gain), xirr: rate(r.xirr), navDate: msToIso(r.lastT) };
      })
    };
    MF.emit('mf:valued', lastSnapshot);
  }

  function renderEmpty() {
    results = [];
    $('#pfStatement').innerHTML = 'Nothing here yet.';
    $('#pfStatement2').innerHTML = 'Add a SIP on the left and it will be valued with AMFI NAVs from its first instalment. For exact units and amounts, import your CAS statement instead.';
    $('#pfFigures').innerHTML = ''; $('#pfTable').innerHTML = ''; $('#pfNotes').innerHTML = '';
    $('#pfChartWrap').hidden = true; $('#pfHoldings').hidden = true; $('#pfMix').hidden = true;
    if (chart) { chart.destroy(); chart = null; }
    if (mixChart) { mixChart.destroy(); mixChart = null; }
    $('#pfSum').textContent = 'Nothing added yet';
    publishValuation();
  }

  function totals(list) {
    const ok = list.filter(r => !r.error);
    const t = { moneyIn: 0, moneyOut: 0, value: 0, flows: [], first: null, last: null };
    for (const r of ok) {
      t.moneyIn += r.moneyIn; t.moneyOut += r.moneyOut; t.value += r.value;
      r.events.forEach(e => t.flows.push({ t: e.t, v: -e.inv }));
      if (r.value > 0) t.flows.push({ t: r.lastT, v: r.value });
      if (r.first != null) t.first = t.first == null ? r.first : Math.min(t.first, r.first);
      t.last = t.last == null ? r.lastT : Math.max(t.last, r.lastT);
    }
    t.net = t.moneyIn - t.moneyOut; t.gain = t.value - t.net; t.xirr = xirr(t.flows);
    return t;
  }

  function renderSummary() {
    const t = totals(results);
    $('#pfChartWrap').hidden = false; $('#pfHoldings').hidden = false;
    const count = results.filter(r => !r.error).length;
    $('#pfSum').textContent = t.first == null ? '' : `${cmp(t.value)} today across ${count} investment${count === 1 ? '' : 's'}`;
    if (t.first == null) { $('#pfStatement').innerHTML = "None of these investments could be valued yet."; $('#pfStatement2').innerHTML = ''; $('#pfFigures').innerHTML = ''; return; }
    const out = t.moneyOut > 0 ? ` and taken out <span class="out">${cmp(t.moneyOut)}</span>` : '';
    const g = t.gain >= 0 ? `a gain of <span class="out">${cmp(t.gain)}</span>` : `a loss of <span class="out bad">${cmp(-t.gain)}</span>`;
    $('#pfStatement').innerHTML = `Since ${fmtMonth(t.first)} you've put in <span class="out">${cmp(t.moneyIn)}</span>${out}. It's worth <span class="out">${cmp(t.value)}</span> today, ${g}.`;
    $('#pfStatement2').innerHTML = t.xirr != null
      ? `That's a return of <b>${pct(t.xirr, 1)} a year</b> (XIRR), counting when each rupee went in. Values use NAVs up to ${fmtDate(t.last)}.`
      : `Values use NAVs up to ${fmtDate(t.last)}.`;
    const fig = (k, v, d, cls) => `<div class="fig"><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;
    $('#pfFigures').innerHTML = '<div class="figs">' +
      fig('Money put in, net', cmp(t.net), t.moneyOut > 0 ? `${cmp(t.moneyIn)} in, ${cmp(t.moneyOut)} out` : (n => `across ${n} investment${n === 1 ? '' : 's'}`)(results.filter(r => !r.error).length)) +
      fig('Worth today', cmp(t.value), full(t.value)) +
      fig('Gain', cmp(t.gain), t.net > 0 ? `${pct(t.gain / t.net, 1)} of net money in` : '', t.gain >= 0 ? 'good' : 'bad') +
      fig('XIRR', t.xirr != null ? pct(t.xirr, 2) : '—', 'yearly return, timing-weighted', t.xirr != null && t.xirr < 0 ? 'bad' : '') +
      '</div>';
  }

  function renderTable() {
    const head = '<thead><tr><th>Investment</th><th>Units</th><th>Put in, net</th><th>Worth</th><th>Gain</th><th>XIRR</th><th>NAV date</th><th><span class="sr-only">Remove</span></th></tr></thead>';
    const rows = results.map(r => {
      const h = r.h;
      const name = esc(h.name || (D && D.byCode.get(r.code) ? D.byCode.get(r.code).n : `Scheme ${r.code}`));
      const first = `<td class="fund"><span class="fn">${name}</span><span class="fa">${describe(h)}</span></td>`;
      const remove = `<td class="rm"><button type="button" class="btn-x" data-remove="${h.id}" aria-label="Remove ${name}" title="Remove">${MF.icon('close')}</button></td>`;
      if (r.error) return `<tr>${first}<td colspan="6" class="bad err">${esc(r.error)}</td>${remove}</tr>`;
      const check = r.unitsMatch == null ? '' : r.unitsMatch
        ? '<small class="chk">matches statement</small>'
        : `<small class="chk bad">statement says ${units(h.closeUnits)}</small>`;
      return `<tr>${first}<td data-label="Units">${units(r.units)}${check}</td><td data-label="Put in, net">${full(r.net)}</td><td class="strong" data-label="Worth">${full(r.value)}</td>
        <td class="${r.gain < 0 ? 'neg' : ''}" data-label="Gain">${full(r.gain)}</td><td class="${r.xirr != null && r.xirr < 0 ? 'neg' : ''}" data-label="XIRR">${r.xirr != null ? pct(r.xirr, 1) : '—'}</td>
        <td data-label="NAV date">${fmtDate(r.lastT)}</td>${remove}</tr>`;
    }).join('');
    $('#pfTable').innerHTML = head + '<tbody>' + rows + '</tbody>';
  }

  function renderNotes() {
    const notes = [];
    if (results.some(r => r.h.kind !== 'cas')) notes.push('SIPs and one-time amounts you enter are priced at the first NAV on or after the date, less 0.005% stamp duty from July 2020. Your real allotment can land a day or two later, so these are close estimates. Import your CAS for exact units.');
    results.forEach(r => r.warn.forEach(w => notes.push(`${esc(r.h.name || 'Scheme ' + r.code)}: ${esc(w)}`)));
    (P.casWarnings || []).forEach(w => notes.push('Statement: ' + esc(w)));
    $('#pfNotes').innerHTML = notes.length ? `<ul class="notes-list">${notes.map(n => `<li>${n}</li>`).join('')}</ul>` : '';
  }

  function renderScopeOptions() {
    const s = $('#pfScope');
    const opts = ['<option value="all">All investments</option>'].concat(P.holdings.map(h => `<option value="${h.id}">${esc(h.name || 'Scheme ' + h.code)}${h.kind === 'sip' ? ' (SIP)' : h.kind === 'lump' ? ' (one-time)' : ''}</option>`));
    s.innerHTML = opts.join('');
    if (view.scope !== 'all' && !P.holdings.some(h => h.id === view.scope)) view.scope = 'all';
    s.value = view.scope;
    picker(s, { minWidth: 280, title: 'Show on the chart' });
    refreshPickers();
    $$('input[name="pf-mode"]').forEach(r => { r.checked = r.value === view.mode; });
  }

  function renderChart() {
    if (typeof window.Chart === 'undefined') { $('#pfChartBox').innerHTML = '<div class="chart-fallback">The chart library did not load. The figures and table are still accurate.</div>'; return; }
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

  /* ---------- what you hold ---------- */
  const assetClass = f => f ? groupLabel(f.g) || 'Other' : 'Not in the fund list';
  function mixGroups() {
    const map = new Map();
    for (const r of results) {
      if (r.error || !(r.value > 0.5)) continue;
      const f = D && r.code ? D.byCode.get(r.code) : null;
      const key = charts.by === 'amc' ? (r.h.amc || (f ? f.a : 'Fund house not known'))
        : charts.by === 'cat' ? (f ? shortCategory(f.k) : 'Not in the fund list')
        : charts.by === 'asset' ? assetClass(f)
        : (r.h.name || (f ? f.n : `Scheme ${r.code}`));
      map.set(key, (map.get(key) || 0) + r.value);
    }
    let rows = [...map].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
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
    const box = $('#pfMix');
    box.hidden = !rows.length;
    if (mixChart) { mixChart.destroy(); mixChart = null; }
    if (!rows.length) return;
    const c = colors(), type = charts.mix, isBar = type === 'bar';
    const col = (r, i) => r.other ? MF.cssVar('--c-other') : c['c' + (i + 1)];
    const share = v => total > 0 ? v / total : 0;
    $('#pfMixLegend').innerHTML = rows.map((r, i) =>
      `<li style="--c:${col(r, i)}"><i></i><span class="nm" title="${esc(r.name)}">${esc(r.name)}</span><span class="v">${cmp(r.value)}</span><span class="s">${pct(share(r.value), 1)}</span></li>`).join('') +
      `<li class="tot"><i></i><span class="nm">Total</span><span class="v">${cmp(total)}</span><span class="s">100%</span></li>`;
    $('.mix-body', box).classList.toggle('bars', isBar);
    if (typeof window.Chart === 'undefined') { $('#pfMixBox').innerHTML = '<div class="chart-fallback">The chart library did not load. The list has every figure.</div>'; return; }
    if (!$('#pfMixChart')) $('#pfMixBox').innerHTML = '<canvas id="pfMixChart" role="img" aria-label="What you hold, by share of today\'s value"></canvas>';
    const tip = Object.assign(tooltip(c), { callbacks: { title: it => rows[it[0].dataIndex].name, label: ctx => ` ${cmp(rows[ctx.dataIndex].value)}, ${pct(share(rows[ctx.dataIndex].value), 1)} of the total` } });
    if (isBar) {
      $('#pfMixBox').style.height = (rows.length * 40 + 30) + 'px';
      mixChart = new window.Chart($('#pfMixChart'), {
        type: 'bar',
        data: { labels: rows.map(r => r.name.length > 30 ? r.name.slice(0, 28) + '…' : r.name), datasets: [{ data: rows.map(r => r.value), backgroundColor: rows.map(r => r.other ? MF.cssVar('--c-other') : c.c1), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 22 }] },
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: false, layout: { padding: { right: 64 } },
          plugins: { legend: { display: false }, tooltip: tip, barValues: { format: v => pct(share(v), 0), color: c['ink-2'] } },
          scales: {
            x: { grid: { color: c.rule }, border: { display: false }, ticks: { color: c.muted, maxTicksLimit: 5, font: { family: 'IBM Plex Sans', size: 11.5 }, callback: v => MF.tick(v) } },
            y: { grid: { display: false }, border: { color: c['rule-2'] }, ticks: { color: c['ink-2'], autoSkip: false, font: { family: 'IBM Plex Sans', size: 12.5 } } }
          }
        }
      });
      return;
    }
    $('#pfMixBox').style.height = '';
    mixChart = new window.Chart($('#pfMixChart'), {
      type: 'doughnut',
      data: { labels: rows.map(r => r.name), datasets: [{ data: rows.map(r => r.value), backgroundColor: rows.map(col), borderColor: c.sheet, borderWidth: 2, hoverOffset: 6 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, cutout: type === 'donut' ? '64%' : 0, layout: { padding: 8 },
        plugins: { legend: { display: false }, tooltip: tip, donutCenter: { text: cmp(total), caption: 'worth today', color: c.ink, sub: c.muted, size: narrow() ? 21 : 24 } }
      }
    });
  }

  /* ---------- fund search ---------- */
  let matches = [], active = -1;
  function search(q) {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length || !D) return [];
    const out = [];
    for (const f of D.funds) {
      const hay = (f.n + ' ' + f.a + ' ' + f.c).toLowerCase();
      if (words.every(w => hay.includes(w))) {
        const score = (f.o === 'Growth' ? 0 : 2) + (f.p === 'Direct' ? 0 : 1) + (f.n.toLowerCase().startsWith(words[0]) ? 0 : 0.5);
        out.push([score, f]);
      }
    }
    return out.sort((a, b) => a[0] - b[0] || a[1].n.localeCompare(b[1].n)).slice(0, 30).map(x => x[1]);
  }
  function renderList() {
    const ul = $('#pfFundList'), input = $('#pfFund');
    if (!matches.length) { ul.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }
    ul.innerHTML = matches.map((f, i) => `<li role="option" id="pf-opt-${i}" data-i="${i}" aria-selected="${i === active}">
      ${esc(f.n)}<span class="tagp">${esc(f.p)}</span><span class="tagp">${esc(f.o)}</span>
      <span class="cl-meta">${esc(f.a)}, ${esc(shortCategory(f.k))}, scheme ${f.c}</span></li>`).join('');
    ul.hidden = false; input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', active >= 0 ? `pf-opt-${active}` : '');
  }
  function choose(f) {
    sel = f; matches = []; active = -1; renderList();
    $('#pfFund').value = f.n;
    $('#pfFundHint').textContent = `${f.p} plan, ${f.o} option, scheme ${f.c}. Latest NAV ₹${f.v} on ${fmtDate(f.d)}.`;
  }

  /* ---------- adding, importing, backup ---------- */
  function msg(t, bad) { const el = $('#pfAddMsg'); el.textContent = t; el.classList.toggle('bad', !!bad); }
  function addFromForm() {
    const raw = $('#pfFund').value.trim();
    if (!sel && /^\d{5,6}$/.test(raw)) sel = { c: +raw, n: `Scheme ${raw}` };
    if (!sel) { msg('Pick a fund from the list first, or type its AMFI scheme code.', true); return; }
    const kind = ($$('input[name="pf-kind"]').find(r => r.checked) || {}).value || 'sip';
    const nowMonth = msToIso(todayMs()).slice(0, 7);
    if (kind === 'sip') {
      const amount = +$('#pfAmt').value, day = Math.round(+$('#pfDay').value), start = $('#pfStart').value, end = $('#pfEnd').value || null, step = Math.max(0, +$('#pfStep').value || 0);
      if (!(amount >= 100)) { msg('Enter a SIP amount of at least ₹100.', true); return; }
      if (!(day >= 1 && day <= 28)) { msg('Pick a debit day between 1 and 28.', true); return; }
      if (!/^\d{4}-\d{2}$/.test(start)) { msg('Enter the month your SIP started.', true); return; }
      if (start > nowMonth) { msg("The start month can't be in the future.", true); return; }
      if (end && end < start) { msg('The stop month is before the start month.', true); return; }
      P.holdings.push({ id: newId(), kind: 'sip', code: sel.c, name: sel.n, amount, day, start, end, step });
      msg(`Added a ${full(amount)} SIP in ${sel.n}.`);
    } else {
      const amount = +$('#pfLumpAmt').value, date = $('#pfLumpDate').value;
      if (!(amount > 0)) { msg('Enter the amount you invested.', true); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { msg('Enter the date you invested.', true); return; }
      if (isoToMs(date) > todayMs()) { msg("The date can't be in the future.", true); return; }
      P.holdings.push({ id: newId(), kind: 'lump', code: sel.c, name: sel.n, amount, date });
      msg(`Added ${full(amount)} in ${sel.n}.`);
    }
    save(); refresh();
  }

  /* A statement is merged, not swapped in: for each fund and folio it replaces the
     transactions inside its own period and keeps older ones from an earlier
     statement. So importing this year's statement after a full one loses nothing. */
  const casKey = h => `${h.isin || h.name}|${h.folio || ''}`;
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
        if (to >= asOf) Object.assign(h, { closeUnits: s.close_units ?? null, asOf: to, name: s.name, amc: s.amc, isin: s.isin || h.isin });
        const since = h.from || old.from || '9999';
        if (from <= since) Object.assign(h, { from, openUnits: s.open_units || 0 });
        updated++;
      } else {
        if (!tx.length) { if (s.close_units > 0) idle.push(s.name); continue; }
        P.holdings.push({
          id: newId(), kind: 'cas', code: null, isin: s.isin || null, name: s.name, amc: s.amc, folio: s.folio,
          closeUnits: s.close_units ?? null, openUnits: s.open_units || 0, from, asOf: to, txns: tx
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

  async function importPdf() {
    const file = $('#pfCasFile').files && $('#pfCasFile').files[0];
    const out = $('#pfImportMsg'), go = $('#pfCasGo'), pw = $('#pfCasPw');
    if (!file) { out.textContent = 'Choose your statement PDF first.'; return; }
    if (!window.CasReader) { out.textContent = "The statement reader didn't load. Reload the page and try again."; return; }
    go.disabled = true;
    out.textContent = 'Opening the PDF…';
    try {
      const data = await file.arrayBuffer();
      const obj = await window.CasReader.read(data, pw.value, (p, n) => { out.textContent = `Reading page ${p} of ${n}…`; });
      const r = importCas(obj);
      pw.value = '';
      $('#pfCasFile').value = ''; $('#pfCasName').textContent = ''; $('#pfCasStep').hidden = true;
      const c = r.check;
      const checked = c ? ` Units add up for ${c.unitsOk} of ${c.schemes} funds on the statement.` : '';
      out.textContent = `Imported ${r.txns} transactions: ${r.added} new ${r.added === 1 ? 'fund' : 'funds'}, ${r.updated} updated.${checked}`;
      refresh();
    } catch (e) {
      out.textContent = e.message || String(e);
      if (e.code === 'needs-password' || e.code === 'wrong-password') { pw.select(); pw.focus(); }
    } finally {
      go.disabled = false;
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

  function bind() {
    const input = $('#pfFund');
    input.addEventListener('input', () => {
      sel = null; $('#pfFundHint').textContent = '';
      if (!D) { $('#pfFundHint').textContent = "The fund list isn't available yet. You can type an AMFI scheme code instead."; return; }
      matches = search(input.value); active = matches.length ? 0 : -1; renderList();
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' && matches.length) { e.preventDefault(); active = (active + 1) % matches.length; renderList(); }
      else if (e.key === 'ArrowUp' && matches.length) { e.preventDefault(); active = (active - 1 + matches.length) % matches.length; renderList(); }
      else if (e.key === 'Enter' && active >= 0 && matches[active]) { e.preventDefault(); choose(matches[active]); }
      else if (e.key === 'Escape') { matches = []; renderList(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { matches = []; renderList(); }, 150));
    $('#pfFundList').addEventListener('mousedown', e => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); choose(matches[+li.dataset.i]); } });

    $$('input[name="pf-kind"]').forEach(r => r.addEventListener('change', () => {
      const lump = r.checked && r.value === 'lump';
      if (r.checked) { $('#pfSipFields').hidden = lump; $('#pfLumpFields').hidden = !lump; }
    }));
    $('#pfAdd').addEventListener('click', addFromForm);

    $('#pfCasFile').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      $('#pfCasName').textContent = f ? f.name : '';
      $('#pfCasStep').hidden = !f;
      $('#pfImportMsg').textContent = '';
      if (f) $('#pfCasPw').focus();
    });
    $('#pfCasGo').addEventListener('click', importPdf);
    $('#pfCasPw').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); importPdf(); } });
    $('#pfExport').addEventListener('click', () => {
      download(`portfolio-backup-${msToIso(todayMs())}.json`, JSON.stringify({ format: BACKUP_FORMAT, saved: new Date().toISOString(), ...P }, null, 1));
    });
    $('#pfRestore').addEventListener('change', e => readFile(e.target, (obj, err) => {
      const out = $('#pfImportMsg');
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
    $('#pfTable').addEventListener('click', e => {
      const b = e.target.closest('[data-remove]'); if (!b) return;
      P.holdings = P.holdings.filter(h => h.id !== b.dataset.remove); save(); refresh();
    });
    typeSwitch($('#pfType'), { label: 'Chart type', value: charts.time, types: TIME_TYPES, onChange: v => { charts.time = v; setPref('pfTime', v); renderChart(); } });
    typeSwitch($('#pfMixType'), { label: 'Chart type', value: charts.mix, types: MIX_TYPES, onChange: v => { charts.mix = v; setPref('pfMix', v); renderMix(); } });
    $('#pfMixBy').value = charts.by;
    picker($('#pfMixBy'), { title: 'Group by' });
    $('#pfMixBy').addEventListener('change', e => { charts.by = e.target.value; setPref('pfMixBy', charts.by); renderMix(); });
    $('#pfScope').addEventListener('change', e => { view.scope = e.target.value; store.set(KEY + ':view', JSON.stringify(view)); renderChart(); });
    $$('input[name="pf-mode"]').forEach(r => r.addEventListener('change', () => { if (r.checked) { view.mode = r.value; store.set(KEY + ':view', JSON.stringify(view)); renderChart(); } }));
    document.addEventListener('mf:theme', () => { if (inited && results.length) { renderChart(); renderMix(); } });
    document.addEventListener('mf:add-sip', e => {
      const go = () => {
        const f = D && D.byCode.get(e.detail.code);
        if (!f) return;
        choose(f);
        if (window.Shell && window.Shell.sheetMode()) { window.Shell.openDrawer('pfRail'); setTimeout(() => $('#pfAmt').focus({ preventScroll: true }), 80); }
        else $('#pfAmt').focus();
      };
      if (D) go(); else init().then(go);
    });
  }

  async function init() {
    if (inited) return;
    inited = true;
    const m = new Date(); $('#pfStart').value ||= `${m.getFullYear() - 1}-${String(m.getMonth() + 1).padStart(2, '0')}`;
    try { D = await loadFunds(); } catch (e) { D = null; $('#pfFundHint').textContent = "The fund list isn't available yet (the nightly job hasn't built it). You can type an AMFI scheme code, or import a CAS file."; }
    refresh();
  }

  /* For sync.js: read the portfolio, take one merged from other devices, and the latest figures. */
  window.Portfolio = {
    syncGet: () => P,
    syncSet(next) {
      P = next && Array.isArray(next.holdings) ? next : { holdings: [] };
      if (!store.set(KEY, JSON.stringify(P))) $('#pfAddMsg').textContent = "Couldn't save in this browser (storage is full or blocked). Download a backup.";
      if (inited) refresh(); else renderScopeOptions();
    },
    snapshot: () => lastSnapshot
  };

  bind();
  document.addEventListener('mf:view', e => { if (e.detail.view === 'portfolio') init(); });
})();
