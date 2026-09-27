/* Compare funds: how ₹10,000 grew in each fund you picked, next to the typical
   fund in the category (the median of its funds, week by week) and a benchmark.
   Index values come from NSE, not AMFI, so an index fund's NAV stands in for
   the benchmark. The default comes from the nightly build; you can choose your
   own for a fund or a whole category, and the choice syncs to your Sheet. */
(() => {
  'use strict';
  const { $, $$, esc, pct, full, fmtDate, store, colors, loadFunds, loadHistory, loadCat, timeAxis, tooltip,
    icon, shortCategory, shortAmc, searchFunds, combo, DAY, emit, launchYear, cssVar } = MF;
  const Calc = window.Calc;

  const KEY = 'mf-compare:v1', BKEY = 'mf-bench:v1', SKEY = 'mf-comparisons:v1';
  const RANGES = [['1', '1Y'], ['3', '3Y'], ['5', '5Y'], ['10', '10Y'], ['all', 'Max']];
  const FUND_COLORS = ['c1', 'c3', 'c5', 'c4', 'c6'];      // c2 is the benchmark's
  const state = Object.assign({ range: '5', anchor: null, mode: 'lump', lump: 10000, sip: 5000, open: null }, store.json(KEY, {}));
  if (!RANGES.some(r => r[0] === state.range)) state.range = '5';
  if (state.mode !== 'sip') state.mode = 'lump';
  state.lump = Math.round(+state.lump) >= 100 ? Math.round(+state.lump) : 10000;
  state.sip = Math.round(+state.sip) >= 100 ? Math.round(+state.sip) : 5000;
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

  /* ---------- saved comparisons (they sync to your Sheet as settings/compare) ---------- */
  const RANGE_KEYS = RANGES.map(r => r[0]);
  const cleanAmount = (x, d) => { x = Math.round(+x); return x >= 100 && x <= 1e8 ? x : d; };
  function tidySaved(x) {
    const list = x && Array.isArray(x.list) ? x.list : [];
    return { list: list.filter(c => c && typeof c === 'object' && /^[a-z0-9]{4,16}$/.test(c.id || '') && String(c.name || '').trim()).map(c => ({
      id: c.id, name: String(c.name).trim().slice(0, 60), funds: cleanList(c.funds),
      anchor: Number.isInteger(+c.anchor) ? +c.anchor : null, range: RANGE_KEYS.includes(c.range) ? c.range : '5',
      mode: c.mode === 'sip' ? 'sip' : 'lump', amount: cleanAmount(c.amount, c.mode === 'sip' ? 5000 : 10000), at: +c.at || 0
    })).filter(c => c.funds.length).slice(0, 30) };
  }
  let saved = tidySaved(store.json(SKEY, {}));
  const saveSaved = () => { store.set(SKEY, JSON.stringify(saved)); emit('mf:changed', { what: 'compare' }); };
  window.Comparisons = {
    syncGet: () => ({ data: saved, blank: !saved.list.length }),
    syncSet(d) { saved = tidySaved(d); store.set(SKEY, JSON.stringify(saved)); if (shown) renderSaved(); }
  };
  const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

  function renderSaved() {
    const box = $('#cmpSaved');
    box.hidden = !saved.list.length;
    if (!saved.list.length) return;
    const now = picks();
    $('#cmpSavedSub').textContent = `${saved.list.length} saved`;
    $('#cmpSavedList').innerHTML = saved.list.slice().sort((a, b) => b.at - a.at).map(c => {
      const names = c.funds.map(x => D && D.byCode.get(x)).filter(Boolean).map(f => plainName(f.n));
      const on = state.open === c.id && sameSet(c.funds, now);
      const how = c.mode === 'sip' ? `SIP ${full(c.amount)} a month` : `${full(c.amount)} once`;
      return `<li${on ? ' aria-current="true"' : ''}><button type="button" class="open" data-open-cmp="${esc(c.id)}"><b>${esc(c.name)}</b>
          <small>${esc(names.join(', ') || `${c.funds.length} funds`)} · ${how} · ${esc((RANGES.find(r => r[0] === c.range) || RANGES[2])[1])}</small></button>
        <button type="button" class="rm" data-del-cmp="${esc(c.id)}" aria-label="Remove the saved comparison ${esc(c.name)}">${icon('close')}</button></li>`;
    }).join('');
  }
  function openSaved(id) {
    const c = saved.list.find(x => x.id === id);
    if (!c) return;
    Object.assign(state, { range: c.range, mode: c.mode, anchor: c.anchor, open: c.id });
    state[c.mode] = c.amount;
    saveState();
    const same = sameSet(c.funds, picks());
    window.Picks.set(c.funds);          // redraws through mf:picks
    if (same) render();
    window.scrollTo({ top: 0 });
  }
  function showSaveBox() {
    const list = picks(), cur = saved.list.find(c => c.id === state.open);
    const auto = list.map(c => plainName(D.byCode.get(c).n)).join(' vs ');
    $('#cmpSaveName').value = cur ? cur.name : auto.length > 60 ? auto.slice(0, 57) + '…' : auto;
    $('#cmpSaveMsg').textContent = '';
    $('#cmpSaveBox').hidden = false;
    $('#cmpSaveName').focus(); $('#cmpSaveName').select();
  }
  function saveCurrent() {
    const name = $('#cmpSaveName').value.trim().slice(0, 60), list = picks();
    if (!name) { $('#cmpSaveMsg').textContent = 'Give it a name.'; return; }
    if (!list.length) return;
    let c = saved.list.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!c && saved.list.length >= 30) { $('#cmpSaveMsg').textContent = 'You can keep 30 comparisons. Remove one first.'; return; }
    if (!c) { c = { id: Math.random().toString(36).slice(2, 10) }; saved.list.push(c); }
    Object.assign(c, { name, funds: list.slice(), anchor: state.anchor, range: state.range, mode: state.mode, amount: state[state.mode], at: Date.now() });
    saved = tidySaved(saved);
    state.open = c.id; saveState(); saveSaved();
    $('#cmpSaveBox').hidden = true;
    renderSaved();
    $('#cmpSub').textContent = `Saved as “${name}”.`;
  }

  /* ---------- the chart ---------- */
  const picks = () => (window.Picks ? window.Picks.get() : []).filter(c => D && D.byCode.has(c));
  const plainName = n => String(n).replace(/\s*-\s*(direct|regular)\b.*$/i, '').replace(/\s*-\s*growth\b.*$/i, '');

  function renderControls() {
    $$('#cmpMode [data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
    const amt = $('#cmpAmt');
    if (document.activeElement !== amt) amt.value = state[state.mode];
    $('#cmpAmtLbl').textContent = state.mode === 'sip' ? 'Monthly SIP amount' : 'Amount put in once';
    $('#cmpAmtPost').textContent = state.mode === 'sip' ? 'a month' : 'once';
    $('#cmpRange').innerHTML = RANGES.map(([v, l]) => `<button type="button" class="seg-btn" data-range="${v}" aria-pressed="${state.range === v}">${l}</button>`).join('');
  }

  async function render() {
    if (!D) return;
    renderSaved();
    const list = picks();
    $('#cmpEmpty').hidden = list.length > 0;
    $('#cmpBody').hidden = !list.length;
    $('#cmpSaveBtn').hidden = !list.length;
    if (!list.length) { $('#cmpSaveBox').hidden = true; if (chart) { chart.destroy(); chart = null; } return; }
    if (!list.includes(state.anchor)) state.anchor = list[0];
    renderControls();
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
    const benchSeries = b && bh.length && bh.length === b.codes.length ? Calc.average(bh) : null;

    // The period: the last N years to the funds' latest common NAV, or (Max) from the oldest fund's first NAV.
    // A fund, the typical fund or the benchmark that starts later is drawn from its own first NAV.
    const end = Math.min(...hists.map(h => h.t[h.t.length - 1]));
    let start;
    if (state.range === 'all') start = Math.min(...hists.map(h => h.t[0]));
    else { const d = new Date(end); d.setUTCFullYear(d.getUTCFullYear() - +state.range); start = d.getTime(); }
    const all = hists.concat(cat ? [cat] : [], benchSeries ? [benchSeries] : []);
    const gridSet = new Set();
    for (let t = start; t < end; t += 7 * DAY) gridSet.add(t);
    gridSet.add(end);
    all.forEach(h => { const s0 = h.t[Calc.idxOnOrAfter(h.t, start)]; if (s0 > start && s0 < end) gridSet.add(s0); });
    const grid = [...gridSet].sort((x, y) => x - y);
    const amount = state[state.mode], sip = state.mode === 'sip';
    const run = h => Calc.simulate(h, { mode: state.mode, amount, from: start, to: end, grid });
    const c = colors();
    const lines = funds.map((f, i) => ({ f, sim: run(hists[i]), color: c[FUND_COLORS[i % FUND_COLORS.length]] }));
    const catSim = cat ? run(cat) : null;
    const benchSim = benchSeries ? run(benchSeries) : null;
    const late = s => s && s.start != null && s.start > start + 10 * DAY;

    const years = (end - start) / (365 * DAY);
    const span = years >= 1.5 ? `${Math.round(years)} years` : `${Math.max(1, Math.round(years * 12))} months`;
    $('#cmpTitle').textContent = sip ? `${full(amount)} a month for ${span}` : `${full(amount)} put in ${span} ago`;
    const younger = lines.filter(l => late(l.sim)).map(l => plainName(l.f.n));
    $('#cmpSub').textContent = `${fmtDate(start)} to ${fmtDate(end)}, from AMFI NAVs.` +
      (younger.length ? ` ${younger.join(', ')} ${younger.length === 1 ? 'is' : 'are'} younger than this period, so ${younger.length === 1 ? 'its line starts' : 'their lines start'} with ${younger.length === 1 ? 'its' : 'their'} first NAV${sip ? ', and so do the SIPs' : ''}.` : '');

    // legend
    const row = (sw, name, sub, sim, extra) => {
      const ok = sim && sim.value != null;
      const note = ok ? `${sip ? `Put in ${full(sim.invested)} · ` : ''}${sim.xirr != null ? pct(sim.xirr, 1) + ' a year' : ''}` : '';
      return `<li>${sw}<span class="nm"><span>${name}</span>${sub ? `<small>${sub}</small>` : ''}</span>
        <span class="val">${ok ? `<b>${full(sim.value)}</b><small>${note}</small>` : sim ? '<small>no NAVs in this period</small>' : ''}</span>${extra || ''}</li>`;
    };
    const startNote = sim => late(sim) ? ` · <span class="late">starts ${fmtDate(sim.start)}, with its first NAV</span>` : '';
    const catName = shortCategory(anchor.k).replace(/ Fund$/i, '').toLowerCase();
    const bn = b ? b.codes.map(x => D.byCode.get(x)).filter(Boolean) : [];
    const benchName = b && b.index ? `Benchmark: ${esc(b.index)}` : bn.length === 1 ? `Benchmark: ${esc(plainName(bn[0].n))}` : bn.length ? `Benchmark: average of ${bn.length} funds` : 'No benchmark yet';
    const benchSub = b
      ? `${b.source === 'default' ? `Through ${esc(bn[0] ? bn[0].n : '')}` : b.source === 'fund' ? `Your choice for ${esc(plainName(anchor.n))}` : `Your choice for every ${esc(catName)} fund`}${startNote(benchSim)} · <button type="button" class="linkish" data-bench>Change</button>`
      : `<button type="button" class="linkish" data-bench>Choose one for ${esc(catName)} funds</button>`;
    $('#cmpLegend').innerHTML = lines.map(l => row(`<span class="sw" style="--c:${l.color}"></span>`,
      esc(l.f.n), `${esc(shortCategory(l.f.k))} · ${esc(l.f.p)}${startNote(l.sim)}${l.f.c === anchor.c && funds.length > 1 ? ' · the typical fund and benchmark below are for this one' : funds.length > 1 ? ` · <button type="button" class="linkish" data-anchor="${l.f.c}">Use its category below</button>` : ''}`, l.sim,
      `<button type="button" class="rm" data-drop="${l.f.c}" aria-label="Stop comparing ${esc(l.f.n)}">${icon('close')}</button>`)).join('') +
      row(`<span class="sw dash" style="--c:${cssVar('--c-other')}"></span>`, `Typical ${esc(catName)} fund`,
        cat ? `Median of ${cat.funds} ${esc(anchor.p)} plans, week by week${startNote(catSim)}` : 'Not enough funds in this category for a median', catSim) +
      row(`<span class="sw dot" style="--c:${c.c2}"></span>`, benchName, benchSub, benchSim);

    // chart
    if (typeof window.Chart === 'undefined') { $('#cmpChartBox').innerHTML = '<div class="chart-fallback">The chart library did not load. The list below the chart has every figure.</div>'; }
    else {
      if (!$('#cmpChart')) $('#cmpChartBox').innerHTML = '<canvas id="cmpChart" role="img" aria-label="What the money grew to in each fund"></canvas>';
      if (chart) chart.destroy();
      const pts = arr => grid.map((x, i) => ({ x, y: arr[i] }));
      const ds = lines.map((l, i) => ({ label: l.f.n, data: pts(l.sim.points), borderColor: l.color, backgroundColor: l.color, borderWidth: i === 0 ? 2.6 : 2.2, pointRadius: 0, tension: 0 }));
      if (catSim && catSim.value != null) ds.push({ label: `Typical ${catName} fund`, data: pts(catSim.points), borderColor: cssVar('--c-other'), backgroundColor: cssVar('--c-other'), borderDash: [6, 4], borderWidth: 2, pointRadius: 0 });
      if (benchSim && benchSim.value != null) ds.push({ label: benchName.replace(/<[^>]+>/g, ''), data: pts(benchSim.points), borderColor: c.c2, backgroundColor: c.c2, borderDash: [2, 4], borderCapStyle: 'round', borderWidth: 2.2, pointRadius: 0 });
      if (sip) {
        const most = lines.map(l => l.sim).filter(x => x.start != null).sort((x, y) => x.start - y.start)[0];
        if (most) ds.push({ label: 'Money put in', data: pts(most.put), borderColor: c.muted, backgroundColor: c.muted, borderWidth: 1.5, pointRadius: 0, stepped: true });
      }
      chart = new window.Chart($('#cmpChart'), {
        type: 'line', data: { datasets: ds },
        options: {
          parsing: false, normalized: true, animation: false, responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            decimation: { enabled: true, algorithm: 'lttb', samples: 500 },
            tooltip: Object.assign(tooltip(c), { mode: 'index', filter: it => it.parsed.y != null, callbacks: { title: it => fmtDate(it[0].parsed.x), label: ctx => ` ${ctx.dataset.label.length > 38 ? ctx.dataset.label.slice(0, 36) + '…' : ctx.dataset.label}: ${full(ctx.parsed.y)}` } })
          },
          scales: {
            x: Object.assign(timeAxis(c, end - start), { min: start, max: end }),
            y: { grid: { color: c.rule }, border: { display: false }, ticks: { color: c.muted, maxTicksLimit: 6, font: { family: 'IBM Plex Sans', size: 11.5 }, callback: v => MF.tick(v) } }
          }
        }
      });
    }
    renderFacts(lines, sip);
  }

  function renderFacts(lines, sip) {
    const f = l => l.f, m = l => l.f.m || {};
    const cell = (x, k) => x == null || !isFinite(x) ? '—' : k === 'cons' ? Math.round(x * 100) + '%' : k === 'sh3' ? x.toFixed(2) : pct(x, 1);
    const money = x => x == null ? '—' : full(x);
    const rows = [
      [sip ? 'SIPs from' : 'Put in on', l => l.sim.start != null ? fmtDate(l.sim.start) : '—'],
      ['Put in', l => money(l.sim.start != null ? l.sim.invested : null)],
      ['Worth', l => money(l.sim.value)],
      ['Gain', l => l.sim.gain == null ? '—' : `<span class="${l.sim.gain < 0 ? 'loss' : 'gain'}">${(l.sim.gain < 0 ? '−' : '+') + full(Math.abs(l.sim.gain)).replace('−', '')}</span>`],
      [sip ? 'XIRR' : 'A year', l => cell(l.sim.xirr)],
      ['Fund house', l => esc(shortAmc(f(l).a))],
      ['Category', l => esc(shortCategory(f(l).k))],
      ['Plan', l => esc(f(l).p)],
      ['Launched', l => f(l).l ? fmtDate(f(l).L || f(l).l) + (f(l).L ? `<br><small class="muted">${esc(f(l).p)} plan since ${fmtDate(f(l).l)}</small>` : '') : (launchYear(f(l)) ? 'first NAV ' + launchYear(f(l)) : '—')],
      ['1Y', l => cell(m(l).r1)], ['3Y a year', l => cell(m(l).r3)], ['5Y a year', l => cell(m(l).r5)],
      ['Typical 3Y (rolling)', l => cell(m(l).rr3med)], ['Beat peers', l => cell(m(l).cons, 'cons')],
      ['Max fall 5Y', l => cell(m(l).mdd5)], ['Volatility 3Y', l => cell(m(l).vol3)], ['Sharpe 3Y', l => cell(m(l).sh3, 'sh3')]
    ];
    const numeric = new Set([1, 2, 3, 4, 9, 10, 11, 12, 13, 14, 15, 16]);
    $('#cmpFacts').innerHTML = `<thead><tr><th></th>${lines.map(l => `<th><span class="sw" style="--c:${l.color}"></span>${esc(plainName(l.f.n))}</th>`).join('')}</tr></thead><tbody>` +
      rows.map(([k, fn], i) => `<tr${i === 4 ? ' class="sep"' : ''}><td>${k}</td>${lines.map(l => `<td class="${numeric.has(i) ? 'n' : ''}">${fn(l)}</td>`).join('')}</tr>`).join('') + '</tbody>';
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
    $('#cmpMode').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (!b || b.dataset.mode === state.mode) return; state.mode = b.dataset.mode; saveState(); render(); });
    const setAmount = () => {
      const v = Math.round(+$('#cmpAmt').value);
      if (!(v >= 100 && v <= 1e8)) { $('#cmpAmt').value = state[state.mode]; $('#cmpSub').textContent = 'Enter an amount of ₹100 or more.'; return; }
      if (v === state[state.mode]) return;
      state[state.mode] = v; saveState(); render();
    };
    $('#cmpAmt').addEventListener('change', setAmount);
    $('#cmpAmt').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); setAmount(); } });
    $('#cmpSaveBtn').addEventListener('click', showSaveBox);
    $('#cmpSaveCancel').addEventListener('click', () => { $('#cmpSaveBox').hidden = true; $('#cmpSaveBtn').focus(); });
    $('#cmpSaveBox').addEventListener('submit', e => { e.preventDefault(); saveCurrent(); });
    $('#cmpSaveBox').addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); $('#cmpSaveBox').hidden = true; $('#cmpSaveBtn').focus(); } });
    $('#cmpSavedList').addEventListener('click', e => {
      const o = e.target.closest('[data-open-cmp]');
      if (o) { openSaved(o.dataset.openCmp); return; }
      const d = e.target.closest('[data-del-cmp]');
      if (!d) return;
      const c = saved.list.find(x => x.id === d.dataset.delCmp);
      if (!c || !window.confirm(`Remove the saved comparison “${c.name}”?`)) return;
      saved.list = saved.list.filter(x => x.id !== c.id);
      if (state.open === c.id) { state.open = null; saveState(); }
      saveSaved(); renderSaved();
    });
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
    MF.onStorage(k => {
      if (k === BKEY) { bench = tidy(store.json(BKEY, {})); if (shown) render(); }
      if (k === SKEY) { saved = tidySaved(store.json(SKEY, {})); if (shown) renderSaved(); }
    });
  }

  async function show() {
    shown = true;
    if (!D) {
      try { D = await loadFunds(); } catch (e) { $('#cmpEmpty').hidden = false; $('#cmpBody').hidden = true; $('#cmpSaveBtn').hidden = true; $('#cmpEmpty').querySelector('p').textContent = "The fund data isn't available yet. The nightly job builds it from AMFI."; return; }
    }
    render();
  }

  bind();
  document.addEventListener('mf:view', e => { if (e.detail.view === 'compare') show(); else shown = false; });
})();
