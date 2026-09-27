/* Compare funds: how ₹10,000 grew in each fund you picked, next to the typical
   fund in the category (the median of its funds, week by week) and a benchmark.
   Index values come from NSE, not AMFI, so an index fund's NAV stands in for
   the benchmark. The default comes from the nightly build; you can choose your
   own for a fund or a whole category, and the choice syncs to your Sheet. */
(() => {
  'use strict';
  const { $, $$, esc, pct, fmtDate, store, colors, loadFunds, loadHistory, loadCat, idxOnOrBefore, timeAxis, tooltip,
    icon, shortCategory, shortAmc, searchFunds, combo, DAY, emit, launchYear, cssVar } = MF;

  const KEY = 'mf-compare:v1', BKEY = 'mf-bench:v1';
  const RANGES = [['1', '1Y'], ['3', '3Y'], ['5', '5Y'], ['10', '10Y'], ['all', 'Max']];
  const FUND_COLORS = ['c1', 'c3', 'c5', 'c4', 'c6'];      // c2 is the benchmark's
  const state = Object.assign({ range: '5', anchor: null }, store.json(KEY, {}));
  const saveState = () => store.set(KEY, JSON.stringify(state));
  let D = null, chart = null, token = 0, shown = false, benchFund = null, benchDraft = [];

  /* ---------- benchmark choices ---------- */
  const cleanList = v => Array.isArray(v) ? [...new Set(v.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 5) : [];
  function tidy(b) {
    const out = { cat: {}, fund: {} };
    if (b && typeof b === 'object') {
      for (const [k, v] of Object.entries(b.cat || {})) { const l = cleanList(v); if (l.length && k.length < 200) out.cat[k] = l; }
      for (const [k, v] of Object.entries(b.fund || {})) { const l = cleanList(v); if (l.length && /^\d+$/.test(k)) out.fund[k] = l; }
    }
    return out;
  }
  let bench = tidy(store.json(BKEY, {}));
  const saveBench = () => { store.set(BKEY, JSON.stringify(bench)); emit('mf:changed', { what: 'bench' }); };
  window.Bench = {
    syncGet: () => ({ data: bench, blank: !Object.keys(bench.cat).length && !Object.keys(bench.fund).length }),
    syncSet(d) { bench = tidy(d); store.set(BKEY, JSON.stringify(bench)); if (shown) render(); }
  };
  /** The benchmark for a fund: its own choice, then its category's, then the nightly default. */
  function benchFor(f) {
    if (!f) return null;
    if (bench.fund[f.c]) return { codes: bench.fund[f.c], source: 'fund' };
    if (bench.cat[f.k]) return { codes: bench.cat[f.k], source: 'cat' };
    const d = D && D.bench ? D.bench[f.k] : null;
    return d ? { codes: [d.c], source: 'default', index: d.i } : null;
  }

  /* ---------- the chart ---------- */
  const picks = () => (window.Picks ? window.Picks.get() : []).filter(c => D && D.byCode.has(c));
  const plainName = n => String(n).replace(/\s*-\s*(direct|regular)\b.*$/i, '').replace(/\s*-\s*growth\b.*$/i, '');

  function growth(hist, start, end) {
    let i0 = idxOnOrBefore(hist.t, start); if (i0 < 0) i0 = 0;
    const i1 = idxOnOrBefore(hist.t, end);
    const base = hist.v[i0], pts = [];
    for (let i = i0; i <= i1; i++) pts.push({ x: hist.t[i], y: 10000 * hist.v[i] / base });
    return pts;
  }
  /** Several index funds averaged into one line, on the first one's dates. */
  function averaged(hists, start, end) {
    const lines = hists.map(h => growth(h, start, end));
    if (lines.length === 1) return lines[0];
    return lines[0].map(p => {
      let s = 0, n = 0;
      hists.forEach((h, k) => { const i = idxOnOrBefore(h.t, p.x); const i0 = Math.max(0, idxOnOrBefore(h.t, start)); if (i >= 0) { s += 10000 * h.v[i] / h.v[i0]; n++; } });
      return { x: p.x, y: n === hists.length ? s / n : null };
    }).filter(p => p.y != null);
  }
  const cagr = (pts) => {
    if (pts.length < 2) return null;
    const yrs = (pts[pts.length - 1].x - pts[0].x) / (365 * DAY);
    return yrs >= 1 ? Math.pow(pts[pts.length - 1].y / pts[0].y, 1 / yrs) - 1 : null;
  };

  async function render() {
    if (!D) return;
    const list = picks();
    $('#cmpEmpty').hidden = list.length > 0;
    $('#cmpBody').hidden = !list.length;
    if (!list.length) { if (chart) { chart.destroy(); chart = null; } return; }
    if (!list.includes(state.anchor)) state.anchor = list[0];
    const seg = $('#cmpRange');
    seg.innerHTML = RANGES.map(([v, l]) => `<button type="button" class="seg-btn" data-range="${v}" aria-pressed="${state.range === v}">${l}</button>`).join('');
    const funds = list.map(c => D.byCode.get(c));
    const anchor = D.byCode.get(state.anchor);
    const catKey = `${anchor.k}|${anchor.p}`;
    const b = benchFor(anchor);
    const my = ++token;
    $('#cmpTitle').textContent = 'Working it out…';
    let hists, cat = null, bh = [];
    try {
      [hists, cat, bh] = await Promise.all([
        Promise.all(funds.map(f => loadHistory(f.c))),
        loadCat(D, catKey).catch(() => null),
        b ? Promise.all(b.codes.map(c => loadHistory(c).catch(() => null))) : Promise.resolve([])
      ]);
    } catch (e) { $('#cmpTitle').textContent = e.message; return; }
    if (my !== token) return;
    bh = bh.filter(Boolean);
    const all = hists.concat(cat ? [cat] : [], bh);
    const end = Math.min(...all.map(h => h.t[h.t.length - 1]));
    let target = -Infinity;
    if (state.range !== 'all') { const d = new Date(end); d.setUTCFullYear(d.getUTCFullYear() - +state.range); target = d.getTime(); }
    const firstFund = Math.max(...hists.map(h => h.t[0]));
    let start = Math.max(target, firstFund);
    // The typical fund and the benchmark are drawn only if they cover the whole period.
    const useCat = cat && cat.t[0] <= start + 10 * DAY ? cat : null;
    const useBench = bh.length && bh.length === (b ? b.codes.length : 0) && Math.max(...bh.map(h => h.t[0])) <= start + 10 * DAY ? bh : [];
    const years = (end - start) / (365 * DAY);
    const c = colors();
    const lines = funds.map((f, i) => ({ f, pts: growth(hists[i], start, end), color: c[FUND_COLORS[i % FUND_COLORS.length]] }));
    const catPts = useCat ? growth(useCat, start, end) : null;
    const benchPts = useBench.length ? averaged(useBench, start, end) : null;

    const span = years >= 1.5 ? `${Math.round(years)} years` : `${Math.max(1, Math.round(years * 12))} months`;
    $('#cmpTitle').textContent = `₹10,000 put in ${span} ago`;
    const shortened = state.range !== 'all' && start > target + 10 * DAY;
    $('#cmpSub').textContent = `${fmtDate(start)} to ${fmtDate(end)}, from AMFI NAVs.` + (shortened ? ' The youngest fund\'s record starts later than this period, so every line starts with it.' : '');

    // legend
    const val = pts => pts && pts.length ? pts[pts.length - 1].y : null;
    const row = (sw, name, sub, pts, extra) => {
      const v = val(pts), g = pts ? cagr(pts) : null;
      return `<li>${sw}<span class="nm"><span>${name}</span>${sub ? `<small>${sub}</small>` : ''}</span>
        <span class="val">${v != null ? `<b>₹${Math.round(v).toLocaleString('en-IN')}</b><small>${g != null ? pct(g, 1) + ' a year' : ''}</small>` : '<small>not enough history</small>'}</span>${extra || ''}</li>`;
    };
    const catName = shortCategory(anchor.k).replace(/ Fund$/i, '').toLowerCase();
    const bn = b ? b.codes.map(x => D.byCode.get(x)).filter(Boolean) : [];
    const benchName = b && b.index ? `Benchmark: ${esc(b.index)}` : bn.length === 1 ? `Benchmark: ${esc(plainName(bn[0].n))}` : bn.length ? `Benchmark: average of ${bn.length} funds` : 'No benchmark yet';
    const benchSub = b
      ? `${b.source === 'default' ? `Through ${esc(bn[0] ? bn[0].n : '')}` : b.source === 'fund' ? `Your choice for ${esc(plainName(anchor.n))}` : `Your choice for every ${esc(catName)} fund`}${b && !benchPts ? ' · its record is shorter than this period' : ''} · <button type="button" class="linkish" data-bench>Change</button>`
      : `<button type="button" class="linkish" data-bench>Choose one for ${esc(catName)} funds</button>`;
    $('#cmpLegend').innerHTML = lines.map((l, i) => row(`<span class="sw" style="--c:${l.color}"></span>`,
      esc(l.f.n), `${esc(shortCategory(l.f.k))} · ${esc(l.f.p)}${l.f.c === anchor.c && funds.length > 1 ? ' · the typical fund and benchmark below are for this one' : funds.length > 1 ? ` · <button type="button" class="linkish" data-anchor="${l.f.c}">Use its category below</button>` : ''}`, l.pts,
      `<button type="button" class="rm" data-drop="${l.f.c}" aria-label="Stop comparing ${esc(l.f.n)}">${icon('close')}</button>`)).join('') +
      row(`<span class="sw dash" style="--c:${cssVar('--c-other')}"></span>`, `Typical ${esc(catName)} fund`,
        cat ? `Median of ${cat.funds} ${esc(anchor.p)} plans, week by week${useCat ? '' : ' · its record is shorter than this period'}` : 'Not enough funds in this category for a median', catPts) +
      row(`<span class="sw dot" style="--c:${c.c2}"></span>`, benchName, benchSub, benchPts);

    // chart
    if (typeof window.Chart === 'undefined') { $('#cmpChartBox').innerHTML = '<div class="chart-fallback">The chart library did not load. The list below the chart has every figure.</div>'; }
    else {
      if (!$('#cmpChart')) $('#cmpChartBox').innerHTML = '<canvas id="cmpChart" role="img" aria-label="Growth of 10,000 rupees in each fund"></canvas>';
      if (chart) chart.destroy();
      const ds = lines.map((l, i) => ({ label: l.f.n, data: l.pts, borderColor: l.color, backgroundColor: l.color, borderWidth: i === 0 ? 2.6 : 2.2, pointRadius: 0, tension: 0 }));
      if (catPts) ds.push({ label: `Typical ${catName} fund`, data: catPts, borderColor: cssVar('--c-other'), backgroundColor: cssVar('--c-other'), borderDash: [6, 4], borderWidth: 2, pointRadius: 0 });
      if (benchPts) ds.push({ label: benchName.replace(/<[^>]+>/g, ''), data: benchPts, borderColor: c.c2, backgroundColor: c.c2, borderDash: [2, 4], borderCapStyle: 'round', borderWidth: 2.2, pointRadius: 0 });
      chart = new window.Chart($('#cmpChart'), {
        type: 'line', data: { datasets: ds },
        options: {
          parsing: false, normalized: true, animation: false, responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'nearest', axis: 'x', intersect: false },
          plugins: {
            legend: { display: false },
            decimation: { enabled: true, algorithm: 'lttb', samples: 500 },
            tooltip: Object.assign(tooltip(c), { mode: 'index', callbacks: { title: it => fmtDate(it[0].parsed.x), label: ctx => ` ${ctx.dataset.label.length > 38 ? ctx.dataset.label.slice(0, 36) + '…' : ctx.dataset.label}: ₹${Math.round(ctx.parsed.y).toLocaleString('en-IN')}` } })
          },
          scales: {
            x: Object.assign(timeAxis(c, end - start), { min: start, max: end }),
            y: { grid: { color: c.rule }, border: { display: false }, ticks: { color: c.muted, maxTicksLimit: 6, font: { family: 'IBM Plex Sans', size: 11.5 }, callback: v => '₹' + (v >= 1e5 ? (v / 1e5).toFixed(1) + 'L' : Math.round(v / 1000) + 'k') } }
          }
        }
      });
    }
    renderFacts(lines);
  }

  function renderFacts(lines) {
    const f = l => l.f, m = l => l.f.m || {};
    const cell = (x, k) => x == null || !isFinite(x) ? '—' : k === 'cons' ? Math.round(x * 100) + '%' : k === 'sh3' ? x.toFixed(2) : pct(x, 1);
    const rows = [
      ['Fund house', l => esc(shortAmc(f(l).a))],
      ['Category', l => esc(shortCategory(f(l).k))],
      ['Plan', l => esc(f(l).p)],
      ['Launched', l => f(l).l ? fmtDate(f(l).L || f(l).l) + (f(l).L ? `<br><small class="muted">${esc(f(l).p)} plan since ${fmtDate(f(l).l)}</small>` : '') : (launchYear(f(l)) ? 'first NAV ' + launchYear(f(l)) : '—')],
      ['1Y', l => cell(m(l).r1)], ['3Y a year', l => cell(m(l).r3)], ['5Y a year', l => cell(m(l).r5)],
      ['Typical 3Y (rolling)', l => cell(m(l).rr3med)], ['Beat peers', l => cell(m(l).cons, 'cons')],
      ['Max fall 5Y', l => cell(m(l).mdd5)], ['Volatility 3Y', l => cell(m(l).vol3)], ['Sharpe 3Y', l => cell(m(l).sh3, 'sh3')]
    ];
    $('#cmpFacts').innerHTML = `<thead><tr><th></th>${lines.map(l => `<th><span class="sw" style="--c:${l.color}"></span>${esc(plainName(l.f.n))}</th>`).join('')}</tr></thead><tbody>` +
      rows.map(([k, fn], i) => `<tr><td>${k}</td>${lines.map(l => `<td class="${i >= 4 ? 'n' : ''}">${fn(l)}</td>`).join('')}</tr>`).join('') + '</tbody>';
  }

  /* ---------- the benchmark panel ---------- */
  function openBench() {
    const f = D && D.byCode.get(state.anchor);
    if (!f) return;
    benchFund = f;
    const b = benchFor(f);
    benchDraft = b ? b.codes.slice() : [];
    const catName = shortCategory(f.k);
    $('#panelBenchTitle').textContent = `Benchmark for ${catName.replace(/ Fund$/i, '')} funds`;
    $('#benchScopeCat').textContent = `Every ${catName.replace(/ Fund$/i, '').toLowerCase()} fund`;
    $('#benchScopeFund').textContent = `Only ${plainName(f.n)}`;
    $$('input[name="bench-scope"]').forEach(r => { r.checked = r.value === (b && b.source === 'fund' ? 'fund' : 'cat'); });
    const d = D.bench[f.k];
    $('#benchDefault').hidden = !(bench.fund[f.c] || bench.cat[f.k]);
    $('#benchDefault').textContent = d ? `Go back to the default (${d.i})` : 'Remove your choice';
    $('#benchMsg').textContent = '';
    drawBenchChips();
    window.Shell.openPanel('panelBench', '#benchAdd');
  }
  function drawBenchChips() {
    $('#benchChips').innerHTML = benchDraft.map(c => { const f = D.byCode.get(c); return f ? `<span class="xchip fund"><span>${esc(f.n)}</span><button type="button" data-bench-rm="${c}" aria-label="Remove ${esc(f.n)}">${icon('close')}</button></span>` : ''; }).join('') ||
      '<span class="muted small">No fund chosen yet. Search for an index fund below.</span>';
  }

  function bind() {
    $('#cmpRange').addEventListener('click', e => { const b = e.target.closest('[data-range]'); if (!b) return; state.range = b.dataset.range; saveState(); render(); });
    $('#cmpLegend').addEventListener('click', e => {
      const d = e.target.closest('[data-drop]');
      if (d) { window.Picks.toggle(+d.dataset.drop); return; }
      const a = e.target.closest('[data-anchor]');
      if (a) { state.anchor = +a.dataset.anchor; saveState(); render(); return; }
      if (e.target.closest('[data-bench]')) openBench();
    });
    combo($('#cmpAdd'), $('#cmpAddList'), {
      find: q => searchFunds(D, q, { limit: 15, filter: f => f.m && !window.Picks.has(f.c) }),
      html: f => `${esc(f.n)}<span class="tagp">${esc(f.p)}</span><span class="cl-meta">${esc(f.a)} · ${esc(shortCategory(f.k))}</span>`,
      pick: f => { if (!window.Picks.toggle(f.c)) $('#cmpSub').textContent = `You can compare up to ${window.Picks.max} funds at a time. Remove one first.`; }
    });
    const isIndex = f => /index fund/i.test(f.k) || /\bindex\b|\betf\b/i.test(f.n);
    combo($('#benchAdd'), $('#benchAddList'), {
      find: q => searchFunds(D, q, { limit: 40, filter: f => f.m && !benchDraft.includes(f.c) }).sort((a, b) => (isIndex(b) - isIndex(a))).slice(0, 15),
      html: f => `${esc(f.n)}${isIndex(f) ? '<span class="tagp">Index</span>' : ''}<span class="cl-meta">${esc(f.a)} · ${esc(shortCategory(f.k))}</span>`,
      pick: f => {
        if (benchDraft.length >= 5) { $('#benchMsg').textContent = 'Five funds is the most a benchmark can average.'; return; }
        benchDraft.push(f.c); drawBenchChips(); $('#benchMsg').textContent = '';
      }
    });
    $('#benchChips').addEventListener('click', e => { const b = e.target.closest('[data-bench-rm]'); if (b) { benchDraft = benchDraft.filter(c => c !== +b.dataset.benchRm); drawBenchChips(); } });
    $('#benchSave').addEventListener('click', () => {
      const f = benchFund; if (!f) return;
      if (!benchDraft.length) { $('#benchMsg').textContent = 'Add at least one fund, or go back to the default.'; return; }
      const scope = ($$('input[name="bench-scope"]').find(r => r.checked) || {}).value || 'cat';
      if (scope === 'fund') bench.fund[f.c] = benchDraft.slice();
      else { bench.cat[f.k] = benchDraft.slice(); delete bench.fund[f.c]; }
      saveBench();
      window.Shell.closePanel();
      render();
    });
    $('#benchDefault').addEventListener('click', () => {
      const f = benchFund; if (!f) return;
      delete bench.fund[f.c]; delete bench.cat[f.k];
      saveBench();
      window.Shell.closePanel();
      render();
    });
    document.addEventListener('mf:picks', () => { if (shown) render(); });
    document.addEventListener('mf:theme', () => { if (shown) render(); });
    MF.onStorage(k => { if (k === BKEY) { bench = tidy(store.json(BKEY, {})); if (shown) render(); } });
  }

  async function show() {
    shown = true;
    if (!D) {
      try { D = await loadFunds(); } catch (e) { $('#cmpEmpty').hidden = false; $('#cmpBody').hidden = true; $('#cmpEmpty').querySelector('p').textContent = "The fund data isn't available yet. The nightly job builds it from AMFI."; return; }
    }
    render();
  }

  bind();
  document.addEventListener('mf:view', e => { if (e.detail.view === 'compare') show(); else shown = false; });
})();
