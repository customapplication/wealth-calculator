/* My portfolio: your SIPs from inception, valued with AMFI NAVs. Stored only in this browser. */
(() => {
  'use strict';
  const { $, $$, esc, full, cmp, pct, units, isoToMs, msToIso, fmtDate, fmtMonth, todayMs, store, hexA, colors,
    loadFunds, loadHistory, idxOnOrBefore, idxOnOrAfter, xirr, timeAxis, tooltip, download, shortCategory, DAY } = MF;

  const KEY = 'mf-portfolio:v1';
  const CAS_FORMAT = 'mf-corpus-planner/cas-v1';
  const BACKUP_FORMAT = 'mf-corpus-planner/portfolio-v1';
  const STAMP_FROM = Date.UTC(2020, 6, 1);   // 0.005% stamp duty on purchases from 1 July 2020
  const STAMP_RATE = 0.00005;

  let P = store.json(KEY, { holdings: [] });
  if (!P || !Array.isArray(P.holdings)) P = { holdings: [] };
  let D = null, inited = false, chart = null, sel = null, results = [], computeToken = 0;
  const view = Object.assign({ scope: 'all', mode: 'value' }, store.json(KEY + ':view', {}));
  const save = () => {
    if (!store.set(KEY, JSON.stringify(P))) $('#pfAddMsg').textContent = "Couldn't save in this browser (storage is full or blocked). Download a backup.";
  };
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
    if (h.kind === 'cas' && h.closeUnits != null) r.unitsMatch = Math.abs(r.units - h.closeUnits) < 0.002;
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
    renderSummary(); renderTable(); renderChart(); renderNotes();
  }

  function renderEmpty() {
    results = [];
    $('#pfStatement').innerHTML = 'Nothing here yet.';
    $('#pfStatement2').innerHTML = 'Add a SIP on the left and it will be valued with AMFI NAVs from its first instalment. For exact units and amounts, import your CAS statement instead.';
    $('#pfFigures').innerHTML = ''; $('#pfTable').innerHTML = ''; $('#pfNotes').innerHTML = '';
    $('#pfChartWrap').hidden = true; $('#pfHoldings').hidden = true;
    if (chart) { chart.destroy(); chart = null; }
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
    const head = '<thead><tr><th>Investment</th><th>Units</th><th>Put in, net</th><th>Worth</th><th>Gain</th><th>XIRR</th><th>NAV date</th><th></th></tr></thead>';
    const rows = results.map(r => {
      const h = r.h;
      const name = esc(h.name || (D && D.byCode.get(r.code) ? D.byCode.get(r.code).n : `Scheme ${r.code}`));
      const first = `<td class="fund"><span class="fn">${name}</span><span class="fa">${describe(h)}</span></td>`;
      const remove = `<td><button type="button" class="btn-x" data-remove="${h.id}" aria-label="Remove ${name}">Remove</button></td>`;
      if (r.error) return `<tr>${first}<td colspan="6" class="bad">${esc(r.error)}</td>${remove}</tr>`;
      const check = r.unitsMatch == null ? '' : r.unitsMatch
        ? '<small class="chk">matches statement</small>'
        : `<small class="chk bad">statement says ${units(h.closeUnits)}</small>`;
      return `<tr>${first}<td>${units(r.units)}${check}</td><td>${full(r.net)}</td><td class="strong">${full(r.value)}</td>
        <td class="${r.gain < 0 ? 'neg' : ''}">${full(r.gain)}</td><td class="${r.xirr != null && r.xirr < 0 ? 'neg' : ''}">${r.xirr != null ? pct(r.xirr, 1) : '—'}</td>
        <td>${fmtDate(r.lastT)}</td>${remove}</tr>`;
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
    $$('input[name="pf-mode"]').forEach(r => { r.checked = r.value === view.mode; });
  }

  function renderChart() {
    if (typeof window.Chart === 'undefined') { $('#pfChartBox').innerHTML = '<div class="chart-fallback">The chart library did not load. The figures and table are still accurate.</div>'; return; }
    if (!$('#pfChart')) $('#pfChartBox').innerHTML = '<canvas id="pfChart" role="img" aria-label="Portfolio value over time"></canvas>';
    const list = view.scope === 'all' ? results : results.filter(r => r.h.id === view.scope);
    const s = series(list);
    if (chart) { chart.destroy(); chart = null; }
    if (!s) return;
    const c = colors();
    const ds = view.mode === 'gain'
      ? [{ label: 'Gain', data: s.grid.map((t, i) => ({ x: t, y: s.value[i] - s.inv[i] })), borderColor: c.ok, backgroundColor: hexA(c.ok, .14), fill: 'origin', borderWidth: 2, pointRadius: 0, tension: 0 }]
      : [
        { label: 'Worth', data: s.grid.map((t, i) => ({ x: t, y: s.value[i] })), borderColor: c.stamp, backgroundColor: hexA(c.stamp, .14), fill: 'origin', borderWidth: 2.2, pointRadius: 0, tension: 0 },
        { label: 'Money put in, net', data: s.grid.map((t, i) => ({ x: t, y: s.inv[i] })), borderColor: c.c2, backgroundColor: c.c2, borderDash: [6, 5], borderWidth: 1.8, pointRadius: 0, stepped: true }
      ];
    chart = new window.Chart($('#pfChart'), {
      type: 'line',
      data: { datasets: ds },
      options: {
        parsing: false, normalized: true, animation: false, responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: view.mode !== 'gain', position: 'bottom', labels: { color: c['ink-2'], usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 16, font: { family: 'IBM Plex Sans', size: 12.5 } } },
          tooltip: Object.assign(tooltip(c), { callbacks: { title: it => fmtDate(it[0].parsed.x), label: ctx => ` ${ctx.dataset.label}: ${cmp(ctx.parsed.y)}` } })
        },
        scales: {
          x: Object.assign(timeAxis(c, s.grid[s.grid.length - 1] - s.grid[0]), { min: s.grid[0], max: s.grid[s.grid.length - 1] }),
          y: { grid: { color: c.rule }, border: { display: false }, ticks: { color: c.muted, maxTicksLimit: 6, font: { family: 'IBM Plex Sans', size: 11.5 }, callback: v => MF.tick(v) } }
        }
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

  function importCas(obj) {
    if (!obj || obj.format !== CAS_FORMAT || !Array.isArray(obj.holdings)) throw new Error('This isn\'t a file from tools/cas_to_json.py. Convert your CAS PDF with that script first.');
    const hs = obj.holdings.filter(h => Array.isArray(h.txns) && h.txns.length).map(h => ({
      id: newId(), kind: 'cas', code: h.amfi || null, isin: h.isin || null, name: h.name, amc: h.amc, folio: h.folio,
      closeUnits: typeof h.close_units === 'number' ? h.close_units : null,
      txns: h.txns.map(x => ({ date: x.date, type: x.type, amount: x.amount, units: x.units, nav: x.nav }))
    }));
    const hadCas = P.holdings.some(h => h.kind === 'cas');
    if (hadCas && !window.confirm('Replace the statement you imported earlier with this one? SIPs you added by hand stay.')) return null;
    P.holdings = P.holdings.filter(h => h.kind !== 'cas').concat(hs);
    P.casWarnings = obj.warnings || [];
    P.casPeriod = obj.statement_period || null;
    save();
    return { funds: hs.length, txns: hs.reduce((s, h) => s + h.txns.length, 0) };
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

    $('#pfImport').addEventListener('change', e => readFile(e.target, (obj, err) => {
      const out = $('#pfImportMsg');
      if (err) { out.textContent = err.message; return; }
      try {
        const r = importCas(obj);
        if (r) { out.textContent = `Imported ${r.funds} funds and ${r.txns} transactions.`; refresh(); }
      } catch (ex) { out.textContent = ex.message; }
    }));
    $('#pfExport').addEventListener('click', () => {
      download(`portfolio-backup-${msToIso(todayMs())}.json`, JSON.stringify({ format: BACKUP_FORMAT, saved: new Date().toISOString(), ...P }, null, 1));
    });
    $('#pfRestore').addEventListener('change', e => readFile(e.target, (obj, err) => {
      const out = $('#pfImportMsg');
      if (err) { out.textContent = err.message; return; }
      if (!obj || obj.format !== BACKUP_FORMAT || !Array.isArray(obj.holdings)) { out.textContent = "That isn't a backup from this page."; return; }
      if (P.holdings.length && !window.confirm('Replace everything on this page with the backup?')) return;
      P = { holdings: obj.holdings, casWarnings: obj.casWarnings || [], casPeriod: obj.casPeriod || null };
      save(); out.textContent = `Restored ${P.holdings.length} investments.`; refresh();
    }));
    $('#pfClear').addEventListener('click', () => {
      if (!P.holdings.length) return;
      if (!window.confirm('Remove every investment from this page? Download a backup first if you might want them back.')) return;
      P = { holdings: [] }; save(); refresh();
    });
    $('#pfTable').addEventListener('click', e => {
      const b = e.target.closest('[data-remove]'); if (!b) return;
      P.holdings = P.holdings.filter(h => h.id !== b.dataset.remove); save(); refresh();
    });
    $('#pfScope').addEventListener('change', e => { view.scope = e.target.value; store.set(KEY + ':view', JSON.stringify(view)); renderChart(); });
    $$('input[name="pf-mode"]').forEach(r => r.addEventListener('change', () => { if (r.checked) { view.mode = r.value; store.set(KEY + ':view', JSON.stringify(view)); renderChart(); } }));
    document.addEventListener('mf:theme', () => { if (inited && results.length) renderChart(); });
    document.addEventListener('mf:add-sip', e => {
      const go = () => { const f = D && D.byCode.get(e.detail.code); if (f) { choose(f); $('#pfAmt').focus(); } };
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

  bind();
  document.addEventListener('mf:view', e => { if (e.detail.view === 'portfolio') init(); });
})();
