/* The Plan page's first half: a forecast of the portfolio you hold today. It
   starts from each fund's worth today, adds the SIPs still running (with their
   step-ups, from Portfolio), grows everything at the return you choose, and
   shows where it could be in N years. The other half is the plan calculator
   (planner.js); the two share the Plan tab and a switch at the top. */
(() => {
  'use strict';
  const { $, $$, esc, full, pct, fmtMonth, todayMs, store, colors, hexA, tooltip, emit, pref, setPref, cssVar } = MF;
  const Calc = window.Calc;
  const KEY = 'mf-forecast:v1';
  const DEF = { years: 10, rate: 12, stepMode: 'own', step: 10, inflation: 6 };
  const RATES = [8, 10, 12, 14];

  const clamp = (x, lo, hi, d) => { x = +x; return isFinite(x) && x >= lo && x <= hi ? x : d; };
  function tidy(x) {
    x = x && typeof x === 'object' ? x : {};
    return {
      years: Math.round(clamp(x.years, 1, 45, DEF.years)), rate: Math.round(clamp(x.rate, -10, 40, DEF.rate) * 10) / 10,
      stepMode: x.stepMode === 'all' ? 'all' : 'own', step: Math.round(clamp(x.step, 0, 100, DEF.step) * 10) / 10,
      inflation: Math.round(clamp(x.inflation, 0, 20, DEF.inflation) * 10) / 10
    };
  }
  let S = tidy(store.json(KEY, {}));
  const save = () => { store.set(KEY, JSON.stringify(S)); emit('mf:changed', { what: 'forecast' }); };
  let shown = false, chart = null, last = null;

  /* The forecast's settings sync to your Sheet (settings/forecast); which half of the page shows stays on the device. */
  window.Forecast = {
    syncGet: () => ({ data: S, blank: JSON.stringify(S) === JSON.stringify(DEF) }),
    syncSet(d) { S = tidy(d); store.set(KEY, JSON.stringify(S)); if (shown) render(); }
  };

  /* ---------- which half of the Plan page ---------- */
  let mode = pref('planMode', null, ['forecast', 'plan']);
  if (!mode) {
    const P = store.json('mf-portfolio:v1', null);
    mode = P && Array.isArray(P.holdings) && P.holdings.length ? 'forecast' : 'plan';
  }
  function setMode(m, remember) {
    mode = m;
    document.documentElement.dataset.planMode = m;
    $$('.plan-switch [data-plan-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.planMode === m)));
    if (remember) setPref('planMode', m);
    if (m === 'forecast' && document.documentElement.dataset.view === 'plan') show();
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-plan-mode]');
    if (!b) return;
    setMode(b.dataset.planMode, true);
    const again = $(`#${b.dataset.planMode === 'plan' ? 'view-plan' : 'view-forecast'} .plan-switch [data-plan-mode="${b.dataset.planMode}"]`);
    if (again) again.focus();
  });

  /* ---------- the forecast ---------- */
  async function show() {
    shown = true;
    if (!window.Portfolio) return;
    await window.Portfolio.load();
    render();
  }

  function fillInputs() {
    const put = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
    put('#fcYears', S.years); put('#fcRate', S.rate); put('#fcStep', S.step); put('#fcInfl', S.inflation);
    $$('#fcStepMode [data-step-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.stepMode === S.stepMode)));
    $('#fcStepBox').hidden = S.stepMode !== 'all';
    const snap = window.Portfolio.snapshot && window.Portfolio.snapshot();
    const mine = snap && snap.totals && snap.totals.xirr != null && isFinite(snap.totals.xirr) ? Math.round(snap.totals.xirr * 1000) / 10 : null;
    const pills = RATES.map(r => ({ r, label: r + '%' }));
    if (mine != null && mine >= -10 && mine <= 40 && !RATES.includes(mine)) pills.push({ r: mine, label: `${mine}% · your XIRR` });
    $('#fcRates').innerHTML = pills.map(p => `<button type="button" class="seg-btn" data-rate="${p.r}" aria-pressed="${p.r === S.rate}">${esc(p.label)}</button>`).join('');
  }

  /** "+10% a year" (the one step-up for all, or the SIP's own), "+₹500 a year" (a statement's fixed raise), or ''. */
  const stepText = s => !s || !s.running ? '' : S.stepMode === 'all' ? (S.step > 0 ? `+${S.step}% a year` : '')
    : s.step > 0 ? `+${s.step}% a year` : s.stepAmt > 0 ? `+${full(s.stepAmt)} a year` : '';
  const sipLabel = s => !s ? '<span class="muted">No SIP</span>'
    : s.running ? `${full(s.amount)} a month${stepText(s) ? `<small>${stepText(s)}</small>` : ''}`
    : `<span class="muted">Stopped${s.end ? ' ' + fmtMonth(s.end + '-01') : ''}</span>`;

  function render() {
    if (!window.Portfolio) return;
    const items = window.Portfolio.forecastItems();
    $('#fcEmpty').hidden = items.length > 0;
    $('#fcBody').hidden = !items.length;
    if (!items.length) { if (chart) { chart.destroy(); chart = null; } return; }
    fillInputs();
    const invested = items.reduce((s, x) => s + Math.max(0, x.net || 0), 0);
    const f = Calc.forecast(items, { years: S.years, rate: S.rate, stepMode: S.stepMode, step: S.step, today: todayMs(), invested });
    last = { items, f };
    const today = items.reduce((s, x) => s + x.value, 0);
    const running = items.filter(x => x.sip && x.sip.running && x.sip.amount > 0), stopped = items.filter(x => x.sip && !x.sip.running);
    const monthly = running.reduce((s, x) => s + x.sip.amount, 0);
    const endLabel = fmtMonth(f.endMonth + '-01');
    const real = f.value / Math.pow(1 + S.inflation / 100, S.years);
    $('#fcLead').textContent = `In ${S.years} year${S.years === 1 ? '' : 's'}, by ${endLabel}, your portfolio could be worth`;
    $('#fcValue').textContent = full(f.value);
    const stepWords = S.stepMode === 'all' ? (S.step > 0 ? `, each raised ${S.step}% a year` : ', none raised') : '';
    $('#fcLine').innerHTML = `From <b>${full(today)}</b> today${monthly ? ` and <b>${full(monthly)}</b> a month in ${running.length} running SIP${running.length === 1 ? '' : 's'}${stepWords}` : ', with no SIP running'}, growing ${esc(pct(S.rate / 100, 1))} a year. ` +
      `You'd put in <b>${full(f.added)}</b> more. That's about <b>${full(real)}</b> in today's money, at ${S.inflation}% inflation.` +
      (stopped.length ? ` <span class="muted">${stopped.length === 1 ? '1 stopped SIP adds' : `${stopped.length} stopped SIPs add`} nothing more; ${stopped.length === 1 ? 'its' : 'their'} money keeps growing.</span>` : '');
    drawChart(f);
    renderTable(items, f);
  }

  function drawChart(f) {
    const c = colors(), labels = f.rows.map(r => r.year === 0 ? 'Today' : String(+f.endMonth.slice(0, 4) - (f.months - r.month) / 12));
    $('#fcChartSub').textContent = `Worth at the end of each year, and the money you'd have put in by then (${full(f.rows[0].put)} so far).`;
    $('#fcLegend').innerHTML = `<li><span class="sw" style="--c:${c.stamp}"></span>Worth</li><li><span class="sw dash" style="--c:${c.c2}"></span>Money put in</li>`;
    if (typeof window.Chart === 'undefined') { $('#fcChartBox').innerHTML = '<div class="chart-fallback">The chart library did not load. The table below has every figure.</div>'; return; }
    if (!$('#fcChart')) $('#fcChartBox').innerHTML = '<canvas id="fcChart" role="img" aria-label="Forecast worth and money put in, year by year"></canvas>';
    if (chart) chart.destroy();
    chart = new window.Chart($('#fcChart'), {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Worth', data: f.rows.map(r => r.value), borderColor: c.stamp, backgroundColor: hexA(c.stamp, .12), fill: 'origin', borderWidth: 2.4, pointRadius: f.rows.length <= 16 ? 3 : 0, pointBackgroundColor: c.stamp, tension: 0 },
        { label: 'Money put in', data: f.rows.map(r => r.put), borderColor: c.c2, backgroundColor: c.c2, borderDash: [6, 5], borderWidth: 1.8, pointRadius: 0, fill: false, tension: 0 }
      ] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: Object.assign(tooltip(c), { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${full(ctx.parsed.y)}` } }) },
        scales: {
          x: { grid: { display: false }, border: { color: c['rule-2'] }, ticks: { color: c.muted, maxRotation: 0, autoSkipPadding: 12, font: { family: 'IBM Plex Sans', size: 11.5 } } },
          y: { grid: { color: c.rule }, border: { display: false }, beginAtZero: true, ticks: { color: c.muted, maxTicksLimit: 6, font: { family: 'IBM Plex Sans', size: 11.5 }, callback: v => MF.tick(v) } }
        }
      }
    });
  }

  function renderTable(items, f) {
    const by = new Map(f.holdings.map(h => [h.id, h]));
    const rows = items.map(x => ({ x, h: by.get(x.id) })).sort((a, b) => b.h.value - a.h.value);
    const n = items.length, on = items.filter(x => x.sip && x.sip.running).length;
    const monthly = items.filter(x => x.sip && x.sip.running).reduce((s, x) => s + x.sip.amount, 0);
    const inYears = `In ${S.years} year${S.years === 1 ? '' : 's'}`;
    $('#fcFundsSub').textContent = `${n} fund${n === 1 ? '' : 's'}, ${on} with a running SIP. Change a SIP, its step-up or when it stopped on Portfolio.`;
    $('#fcTable').innerHTML = `<thead><tr><th>Fund</th><th>Worth today</th><th>SIP</th><th>You'd put in</th><th>${inYears}</th></tr></thead><tbody>` +
      rows.map(({ x, h }) => `<tr class="${x.sip && !x.sip.running ? 'off' : ''}"><td><span class="fn">${esc(x.name)}</span>${x.cat ? `<small>${esc(x.cat)}</small>` : ''}</td>
        <td class="n">${full(x.value)}</td><td class="n sip">${sipLabel(x.sip)}</td><td class="n">${h.added ? full(h.added) : '—'}</td><td class="n"><b>${full(h.value)}</b></td></tr>`).join('') +
      `<tr class="total"><td>All</td><td class="n">${full(f.rows[0].value)}</td><td class="n">${full(monthly)} a month</td><td class="n">${full(f.added)}</td><td class="n"><b>${full(f.value)}</b></td></tr></tbody>`;
    // On a phone, the same figures as one card per fund: no sideways scrolling.
    const card = (name, sub, today, sip, put, end, cls) => `<li class="${cls || ''}">
      <div class="fcf-top"><span class="fn"><b>${name}</b>${sub ? `<small>${sub}</small>` : ''}</span><span class="fcf-end"><b>${end}</b><small>${inYears.toLowerCase()}</small></span></div>
      <div class="fcf-figs"><span><small>Worth today</small><b>${today}</b></span><span><small>SIP</small><b>${sip}</b></span><span><small>You'd put in</small><b>${put}</b></span></div></li>`;
    const sipShort = s => !s ? '<span class="muted">No SIP</span>' : s.running ? `${full(s.amount)}<small>a month${stepText(s) ? `, ${stepText(s)}` : ''}</small>` : sipLabel(s);
    $('#fcCards').innerHTML = rows.map(({ x, h }) => card(esc(x.short || x.name), esc([x.cat, x.plan].filter(Boolean).join(' · ')), full(x.value), sipShort(x.sip), h.added ? full(h.added) : '—', full(h.value), x.sip && !x.sip.running ? 'off' : '')).join('') +
      card('All your funds', `${n} fund${n === 1 ? '' : 's'}`, full(f.rows[0].value), `${full(monthly)}<small>a month</small>`, full(f.added), full(f.value), 'total');
  }

  /* ---------- inputs ---------- */
  function set(k, v) {
    const next = tidy(Object.assign({}, S, { [k]: v }));
    if (JSON.stringify(next) === JSON.stringify(S)) { fillInputs(); return; }
    S = next; save(); render();
  }
  $('#fcYears').addEventListener('change', e => set('years', e.target.value));
  $('#fcRate').addEventListener('change', e => set('rate', e.target.value));
  $('#fcStep').addEventListener('change', e => set('step', e.target.value));
  $('#fcInfl').addEventListener('change', e => set('inflation', e.target.value));
  $('#fcRates').addEventListener('click', e => { const b = e.target.closest('[data-rate]'); if (b) set('rate', +b.dataset.rate); });
  $('#fcStepMode').addEventListener('click', e => {
    const b = e.target.closest('[data-step-mode]'); if (!b) return;
    set('stepMode', b.dataset.stepMode);
    if (S.stepMode === 'all') $('#fcStep').focus();
  });
  $('#fcToPlan').addEventListener('click', () => {
    if (!last || !window.Planner || !window.Planner.useNumbers) return;
    const items = last.items, running = items.filter(x => x.sip && x.sip.running && x.sip.amount > 0);
    const monthly = running.reduce((s, x) => s + x.sip.amount, 0);
    // Each SIP's own step-up, weighted by its amount (a fixed ₹ raise as its % of today's amount).
    const pctOf = s => s.step > 0 ? s.step : s.stepAmt > 0 ? 100 * s.stepAmt / s.amount : 0;
    const step = S.stepMode === 'all' ? S.step : monthly ? running.reduce((s, x) => s + x.sip.amount * pctOf(x.sip), 0) / monthly : 0;
    window.Planner.useNumbers({ existingCorpus: items.reduce((s, x) => s + x.value, 0), monthlySip: monthly, sipYears: S.years, stepUpValue: step, rate: S.rate });
    setMode('plan', true);
    window.scrollTo(0, 0);
  });

  document.addEventListener('mf:view', e => { if (e.detail.view === 'plan' && mode === 'forecast') show(); else if (e.detail.view !== 'plan') shown = false; });
  document.addEventListener('mf:valued', () => { if (shown && mode === 'forecast') render(); });
  document.addEventListener('mf:theme', () => { if (shown && mode === 'forecast' && last) drawChart(last.f); });
  MF.onStorage(k => { if (k === KEY) { S = tidy(store.json(KEY, {})); if (shown) render(); } });
  setMode(mode, false);
})();
