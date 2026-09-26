/* Explore funds: rank each category's funds by a measure you choose, from AMFI NAVs. */
(() => {
  'use strict';
  const { $, $$, esc, full2, pct, fmtDate, fmtMonth, store, hexA, colors, loadFunds, loadHistory,
    idxOnOrBefore, timeAxis, tooltip, reducedMotion, emit, shortCategory, groupLabel, DAY } = MF;

  const KEY = 'mf-explore:v1';
  const MEASURES = [
    { key: 'rr3med', label: 'Typical 3-year return (rolling median)', col: '3Y rolling', desc: true },
    { key: 'cons', label: 'How often it beat the category median', col: 'Beat peers', desc: true, share: true },
    { key: 'r1', label: '1-year return', col: '1Y', desc: true },
    { key: 'r3', label: '3-year return (CAGR)', col: '3Y', desc: true },
    { key: 'r5', label: '5-year return (CAGR)', col: '5Y', desc: true },
    { key: 'r10', label: '10-year return (CAGR)', col: '10Y', desc: true },
    { key: 'si', label: 'Return since launch (CAGR)', col: 'Since launch', desc: true },
    { key: 'rr3min', label: 'Best worst-case 3-year return', col: 'Worst 3Y', desc: true },
    { key: 'mdd5', label: 'Smallest fall from a peak, 5 years', col: 'Max fall 5Y', desc: true },
    { key: 'vol3', label: 'Lowest volatility, 3 years', col: 'Volatility 3Y', desc: false },
    { key: 'sh3', label: 'Sharpe ratio, 3 years', col: 'Sharpe 3Y', desc: true, num: true }
  ];
  const COLS = ['r1', 'r3', 'r5', 'r10', 'si', 'rr3med', 'rr3min', 'cons', 'mdd5', 'vol3', 'sh3'];
  const RANGES = [['1', '1Y'], ['3', '3Y'], ['5', '5Y'], ['10', '10Y'], ['all', 'All']];

  let D = null, inited = false, loading = false, chart = null, detailToken = 0, lastShown = [];
  const state = Object.assign({ cat: '', plan: 'Direct', metric: 'rr3med', top: 10, age: 0, q: '', sel: null, range: '5' }, store.json(KEY, {}));
  const save = () => store.set(KEY, JSON.stringify(state));
  const measure = () => MEASURES.find(m => m.key === state.metric) || MEASURES[0];

  function fmtCell(key, x) {
    if (x == null || !isFinite(x)) return '—';
    if (key === 'cons') return Math.round(x * 100) + '%';
    if (key === 'sh3') return x.toFixed(2);
    return pct(x, 1);
  }

  /* ---------- loading ---------- */
  async function init() {
    if (inited || loading) return;
    loading = true;
    $('#exTable').innerHTML = '<tbody><tr><td class="loading">Loading fund data…</td></tr></tbody>';
    try {
      D = await loadFunds();
    } catch (e) {
      loading = false;
      renderMissing(e);
      return;
    }
    loading = false; inited = true;
    fillControls();
    renderFresh();
    render();
  }

  function renderMissing(e) {
    $('#exFresh').innerHTML = '';
    $('#exFilters').hidden = true;
    $('#exTable').innerHTML = '';
    $('#exMore').innerHTML = `<span class="empty-msg"><b>No fund data yet.</b> This page reads the files the nightly job builds from AMFI. If you've just set up the repository, run the “Nightly mutual fund data” workflow once from the Actions tab. Running locally? Build the data with <code>python pipeline/build.py</code>, then serve the site folder. (${esc(e.message)})</span>`;
  }

  /* ---------- controls ---------- */
  function categories() {
    const map = new Map();
    for (const f of D.funds) {
      if (!f.m || f.o !== 'Growth') continue;
      const c = map.get(f.k) || { k: f.k, g: f.g, n: { Direct: 0, Regular: 0 } };
      c.n[f.p] = (c.n[f.p] || 0) + 1;
      map.set(f.k, c);
    }
    return [...map.values()].sort((a, b) => a.g.localeCompare(b.g) || shortCategory(a.k).localeCompare(shortCategory(b.k)));
  }

  function fillControls() {
    $('#exFilters').hidden = false;
    const cats = categories();
    if (!cats.some(c => c.k === state.cat)) {
      const pref = cats.find(c => /flexi cap/i.test(c.k)) || cats.find(c => /^equity/i.test(c.g)) || cats[0];
      state.cat = pref ? pref.k : '';
    }
    const groups = new Map();
    cats.forEach(c => { if (!groups.has(c.g)) groups.set(c.g, []); groups.get(c.g).push(c); });
    $('#exCat').innerHTML = [...groups].map(([g, list]) =>
      `<optgroup label="${esc(groupLabel(g))}">${list.map(c =>
        `<option value="${esc(c.k)}"${c.k === state.cat ? ' selected' : ''}>${esc(shortCategory(c.k))} (${c.n.Direct + c.n.Regular})</option>`).join('')}</optgroup>`).join('');
    $('#exMetric').innerHTML = MEASURES.map(m => `<option value="${m.key}"${m.key === state.metric ? ' selected' : ''}>${esc(m.label)}</option>`).join('');
    $('#exTop').value = String(state.top);
    $('#exAge').value = String(state.age);
    $('#exQ').value = state.q;
    $$('input[name="ex-plan"]').forEach(r => { r.checked = r.value === state.plan; });
  }

  function bind() {
    $('#exCat').addEventListener('change', e => { state.cat = e.target.value; state.sel = null; save(); render(); });
    $('#exMetric').addEventListener('change', e => { state.metric = e.target.value; save(); render(); });
    $('#exTop').addEventListener('change', e => { state.top = +e.target.value; save(); render(); });
    $('#exAge').addEventListener('change', e => { state.age = +e.target.value; save(); render(); });
    let t = null;
    $('#exQ').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; save(); render(); }, 120); });
    $$('input[name="ex-plan"]').forEach(r => r.addEventListener('change', () => { if (r.checked) { state.plan = r.value; state.sel = null; save(); render(); } }));
    const pick = tr => { state.sel = +tr.dataset.code; save(); renderTable(); renderDetail(true); };
    $('#exTable').addEventListener('click', e => {
      const th = e.target.closest('th[data-sort]');
      if (th) { state.metric = th.dataset.sort; $('#exMetric').value = state.metric; save(); render(); return; }
      const tr = e.target.closest('tr[data-code]'); if (tr) pick(tr);
    });
    $('#exTable').addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const th = e.target.closest('th[data-sort]');
      if (th) { e.preventDefault(); state.metric = th.dataset.sort; $('#exMetric').value = state.metric; save(); render(); const again = $(`#exTable th[data-sort="${state.metric}"]`); if (again) again.focus(); return; }
      const tr = e.target.closest('tr[data-code]'); if (tr) { e.preventDefault(); pick(tr); }
    });
    $('#exDetail').addEventListener('click', e => {
      const r = e.target.closest('[data-range]');
      if (r) { state.range = r.dataset.range; save(); renderDetail(false); return; }
      if (e.target.closest('[data-ex-close]')) { state.sel = null; save(); renderTable(); renderDetail(false); return; }
      if (e.target.closest('[data-ex-sip]')) { emit('mf:add-sip', { code: state.sel }); location.hash = '#portfolio'; return; }
      const b = e.target.closest('[data-ex-plan]');
      if (b && window.Planner) { window.Planner.addRate(+b.dataset.rate); location.hash = '#plan'; }
    });
    document.addEventListener('mf:theme', () => { if (inited && state.sel) renderDetail(false); });
  }

  /* ---------- freshness ---------- */
  function renderFresh() {
    const m = D.meta, built = new Date(m.built_at);
    const h = m.amfi_history || {}, mf = m.mfapi || {}, gaps = m.recent_gaps || {};
    const lines = [];
    let first = `NAVs as of <b>${fmtDate(m.nav_date)}</b>, from AMFI's daily NAV file, for ${m.counts.tracked.toLocaleString('en-IN')} funds.`;
    if (h.ok) {
      first += ` Recent days re-checked against AMFI's NAV history: ${(h.points_checked || 0).toLocaleString('en-IN')} values checked, ${(h.points_corrected || 0).toLocaleString('en-IN')} corrected.`;
    }
    first += ` Rebuilt ${built.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.`;
    lines.push(first);
    const warn = [];
    if (!h.ok) warn.push("AMFI's NAV history report couldn't be reached on the last run, so recent days weren't re-checked.");
    if (mf.pending > 0) warn.push(`Older history for ${mf.pending.toLocaleString('en-IN')} funds is still being downloaded and will complete over the next nightly runs.`);
    if (gaps.count > 0) warn.push(`${gaps.count.toLocaleString('en-IN')} funds are missing more than 5 days of NAVs in the last two months.`);
    const corr = (m.corrections || []).slice(0, 10).map(c => `<li>Scheme ${c.code}, ${fmtDate(c.date)}: ${c.was} replaced with AMFI's ${c.amfi}</li>`).join('');
    $('#exFresh').innerHTML = `<p>${lines.join(' ')}</p>` +
      (warn.length ? `<p class="warn">${warn.join(' ')}</p>` : '') +
      `<details><summary>Data sources and checks</summary><ul>
        <li>Latest NAVs: <a href="${esc(m.sources.latest)}" rel="noopener">${esc(m.sources.latest)}</a> (columns: ${esc((m.navall_columns || []).join('; '))})</li>
        <li>Recent history and corrections: AMFI's NAV history report</li>
        <li>Older history: MFapi.in, a free copy of AMFI's data${mf.latest_date_seen ? `; its newest NAV on the last download was ${fmtDate(mf.latest_date_seen)}` : ''}</li>
        <li>Whenever two sources disagree, AMFI's value is kept.</li>
        ${h.errors && h.errors.length ? `<li class="warn">AMFI history errors: ${esc(h.errors.join(' | '))}</li>` : ''}
      </ul>${corr ? `<p>Latest corrections:</p><ul>${corr}</ul>` : ''}</details>`;
  }

  /* ---------- table ---------- */
  function ranked() {
    const m = measure(), k = m.key;
    const q = state.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const minAge = state.age * 365 - 5;
    const pool = D.funds.filter(f => f.k === state.cat && f.p === state.plan && f.o === 'Growth' && f.m &&
      (f.m.age || 0) >= minAge && q.every(w => (f.n + ' ' + f.a).toLowerCase().includes(w)));
    const withValue = pool.filter(f => f.m[k] != null && isFinite(f.m[k]));
    withValue.sort((a, b) => (m.desc ? b.m[k] - a.m[k] : a.m[k] - b.m[k]) || a.n.localeCompare(b.n));
    return { pool, list: withValue, missing: pool.length - withValue.length };
  }

  function render() { renderTable(); renderDetail(false); }

  function renderTable() {
    if (!D) return;
    const m = measure();
    const { pool, list, missing } = ranked();
    const shown = state.top ? list.slice(0, state.top) : list;
    lastShown = shown;
    const names = new Map();
    shown.forEach(f => names.set(f.n, (names.get(f.n) || 0) + 1));
    const head = `<thead><tr><th class="rk">#</th><th>Fund</th><th>NAV</th>${COLS.map(c => {
      const mm = MEASURES.find(x => x.key === c);
      return `<th data-sort="${c}" class="${c === m.key ? 'is-rank' : ''}" title="Rank by ${esc(mm.label.toLowerCase())}" tabindex="0">${esc(mm.col)}</th>`;
    }).join('')}</tr></thead>`;
    const body = shown.map((f, i) => {
      const nm = names.get(f.n) > 1 ? `${f.n} (${f.c})` : f.n;
      return `<tr data-code="${f.c}" tabindex="0" class="${f.c === state.sel ? 'is-sel' : ''}">
        <td class="rk">${i + 1}</td>
        <td class="fund"><span class="fn">${esc(nm)}</span><span class="fa">${esc(f.a)}</span></td>
        <td>${full2(f.v)}<small>${fmtDate(f.d)}</small></td>
        ${COLS.map(c => { const x = f.m[c]; const neg = x != null && x < 0 && c !== 'mdd5' && c !== 'vol3'; return `<td class="${c === m.key ? 'is-rank' : ''}${neg ? ' neg' : ''}">${fmtCell(c, x)}</td>`; }).join('')}
      </tr>`;
    }).join('');
    $('#exTable').innerHTML = head + '<tbody>' + (body || `<tr><td colspan="${COLS.length + 3}" class="loading">No ${state.plan.toLowerCase()} growth funds in this category match these filters.</td></tr>`) + '</tbody>';
    const bits = [];
    bits.push(`Ranked by ${m.label.toLowerCase()}, ${m.desc ? 'highest' : 'lowest'} first. Showing ${shown.length} of ${list.length}.`);
    if (missing) bits.push(`${missing} more ${missing === 1 ? 'fund has' : 'funds have'} too little history for this measure.`);
    if (!pool.length) bits.length = 0;
    bits.push('Select a column heading to rank by it, or a fund to see its chart.');
    $('#exMore').textContent = bits.join(' ');
  }

  /* ---------- detail ---------- */
  async function renderDetail(scroll) {
    const box = $('#exDetail');
    const f = D && state.sel != null ? D.byCode.get(state.sel) : null;
    if (!f || !f.m) { box.hidden = true; if (chart) { chart.destroy(); chart = null; } return; }
    box.hidden = false;
    const m = f.m;
    const rate = m.r5 != null ? m.r5 : m.r3 != null ? m.r3 : m.rr3med;
    const rateLabel = m.r5 != null ? '5-year' : m.r3 != null ? '3-year' : 'typical 3-year';
    const ratePct = rate != null ? Math.round(rate * 1000) / 10 : null;
    const launched = m.inc ? `First NAV <b>${fmtDate(m.inc)}</b>` : m.pre2006 ? 'Launched before <b>Apr 2006</b>, when AMFI history starts' : 'Launch date not known yet';
    box.innerHTML = `
      <div class="dt-head">
        <div><h3>${esc(f.n)}</h3><p class="dt-sub">${esc(f.a)}. ${esc(shortCategory(f.k))}, ${esc(f.p)} plan, ${esc(f.o)} option.</p></div>
        <button type="button" class="btn-quiet" data-ex-close>Close</button>
      </div>
      <div class="dt-facts">
        <span>Latest NAV <b>₹${f.v}</b> on ${fmtDate(f.d)}</span>
        <span>${launched}</span>
        <span>Scheme code <b>${f.c}</b></span>
        ${f.i ? `<span>ISIN <b>${esc(f.i)}</b></span>` : ''}
      </div>
      <div class="chart-bar">
        <div class="seg" role="group" aria-label="Chart period">${RANGES.map(([v, l]) => `<button type="button" class="seg-btn" data-range="${v}" aria-pressed="${state.range === v}">${l}</button>`).join('')}</div>
        <span class="dt-note" id="exChartNote"></span>
      </div>
      <div class="chart-box sm"><canvas id="exChart" role="img" aria-label="Growth of ₹10,000 in this fund"></canvas></div>
      <div class="dt-actions">
        <button type="button" class="btn-main" data-ex-sip>Add a SIP in this fund</button>
        ${ratePct != null ? `<button type="button" class="btn-quiet" data-ex-plan data-rate="${ratePct}">Use its ${rateLabel} return (${ratePct}%) in the planner</button>` : ''}
      </div>`;
    if (scroll) box.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });

    const token = ++detailToken;
    let hist;
    try { hist = await loadHistory(f.c); } catch (e) { $('#exChartNote').textContent = e.message; return; }
    if (token !== detailToken) return;
    drawChart(f, hist);
  }

  function drawChart(f, hist) {
    const c = colors(), n = hist.t.length, end = hist.t[n - 1];
    let from = hist.t[0];
    if (state.range !== 'all') {
      const d = new Date(end); d.setUTCFullYear(d.getUTCFullYear() - +state.range);
      from = Math.max(from, d.getTime());
    }
    let i0 = idxOnOrBefore(hist.t, from); if (i0 < 0) i0 = 0;
    const base = hist.v[i0], pts = [];
    for (let i = i0; i < n; i++) pts.push({ x: hist.t[i], y: 10000 * hist.v[i] / base });
    const worth = pts[pts.length - 1].y, yrs = (end - hist.t[i0]) / (365 * DAY);
    const cagr = yrs >= 1 ? Math.pow(worth / 10000, 1 / yrs) - 1 : null;
    const partial = state.range !== 'all' && hist.t[0] > from + 10 * DAY;
    $('#exChartNote').textContent = `₹10,000 invested on ${fmtDate(hist.t[i0])} is worth ₹${Math.round(worth).toLocaleString('en-IN')} on ${fmtDate(end)}` +
      (cagr != null ? `, ${pct(cagr, 1)} a year.` : '.') + (partial ? ' The fund is younger than this period.' : '') +
      (hist.source === 'mfapi' ? ' NAVs from MFapi.in.' : '');
    if (typeof window.Chart === 'undefined') return;
    if (chart) chart.destroy();
    const color = c.stamp;
    chart = new window.Chart($('#exChart'), {
      type: 'line',
      data: { datasets: [{ label: 'Value of ₹10,000', data: pts, borderColor: color, backgroundColor: hexA(color, .12), fill: 'origin', borderWidth: 2, pointRadius: 0, pointHoverRadius: 3, tension: 0 }] },
      options: {
        parsing: false, normalized: true, animation: false, responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { display: false },
          decimation: { enabled: true, algorithm: 'lttb', samples: 700 },
          tooltip: Object.assign(tooltip(c), { callbacks: {
            title: items => fmtDate(items[0].parsed.x),
            label: ctx => ` ₹${Math.round(ctx.parsed.y).toLocaleString('en-IN')}   NAV ₹${hist.v[idxOnOrBefore(hist.t, ctx.parsed.x)]}`
          } })
        },
        scales: {
          x: Object.assign(timeAxis(c, end - hist.t[i0]), { min: hist.t[i0], max: end }),
          y: { grid: { color: c.rule }, border: { display: false }, ticks: { color: c.muted, maxTicksLimit: 6, font: { family: 'IBM Plex Sans', size: 11.5 }, callback: v => '₹' + Math.round(v).toLocaleString('en-IN') } }
        }
      }
    });
  }

  bind();
  document.addEventListener('mf:view', e => { if (e.detail.view === 'explore') init(); });
})();
