/* The Plan page: SIP, step-up SIP and SWP calculator. */
(() => {
'use strict';

/* =====================================================================
   THE ENGINE. Its source text is what the "Edit the engine" tab shows.
   ===================================================================== */
const ORIGINAL_ENGINE = function simulate(p) {
  /*
   * CORPUS PLANNER ENGINE
   * This one function produces every number on the page. It is called
   * once per return rate each time an input changes.
   *
   * INPUT p (built from the controls on the left)
   *   existingCorpus  ₹ already invested today (grows from month 1)
   *   monthlySip      ₹ per month in year 1
   *   sipYears        years of SIP contributions
   *   stepUpType      'pct' (raise by a %) or 'amt' (raise by ₹)
   *   stepUpValue     yearly step-up, in % or ₹
   *   stepUpCap       highest monthly SIP allowed, 0 = no limit
   *   annualReturn    % a year while investing and while waiting
   *   rateMode        'effective' → (1 + r)^(1/12) − 1   or   'nominal' → r ÷ 12
   *   timing          'start' = cash moves on day 1, 'end' = on the last day
   *   inflation       % a year, only used for today's-money values
   *   swpEnabled      true / false
   *   swpGapYears     years of waiting between the last SIP and the first withdrawal
   *   swpMonthly      ₹ withdrawn each month in the first SWP year
   *   swpIncrease     % raise in the withdrawal each SWP year
   *   swpYears        years of withdrawals
   *   swpReturn       % a year earned during the SWP years
   *
   * OUTPUT { months: [one row per month], summary: {...} }
   *   month row: month, year, phase ('sip' | 'wait' | 'swp'), rate, opening,
   *              contribution, withdrawal, wanted, growth, closing,
   *              invested, withdrawn, real
   *   summary:   totalInvested, corpusAtSipEnd, corpusAtSwpStart,
   *              totalWithdrawn, finalCorpus, depletedMonth, lastSip
   */

  // Step 1: yearly % → monthly rate
  const toMonthly = (annualPct) =>
    p.rateMode === 'nominal'
      ? annualPct / 100 / 12                          // simple split
      : Math.pow(1 + annualPct / 100, 1 / 12) - 1;    // compounds back to exactly annualPct

  const iGrow = toMonthly(p.annualReturn);
  const iSwp = toMonthly(p.swpReturn);

  // Step 2: lay out the timeline in months
  const sipMonths = Math.round(p.sipYears * 12);
  const gapMonths = p.swpEnabled ? Math.round(p.swpGapYears * 12) : 0;
  const swpMonths = p.swpEnabled ? Math.round(p.swpYears * 12) : 0;
  const totalMonths = sipMonths + gapMonths + swpMonths;

  let corpus = p.existingCorpus;     // running balance
  let invested = p.existingCorpus;   // everything you put in, including today's portfolio
  let withdrawn = 0;                 // everything taken out
  let sip = p.monthlySip;            // current monthly SIP
  let swp = p.swpMonthly;            // current monthly withdrawal
  let depletedMonth = null;          // month the money ran out, if it did
  let corpusAtSipEnd = corpus;
  let corpusAtSwpStart = null;
  const months = [];

  for (let m = 1; m <= totalMonths; m++) {
    const phase = m <= sipMonths ? 'sip' : m <= sipMonths + gapMonths ? 'wait' : 'swp';
    const swpMonth = m - sipMonths - gapMonths;      // 1 = first withdrawal month

    // Step 3: step-up. The SIP rises in the first month of every new SIP year
    if (phase === 'sip' && m > 1 && (m - 1) % 12 === 0) {
      sip = p.stepUpType === 'amt' ? sip + p.stepUpValue : sip * (1 + p.stepUpValue / 100);
      if (p.stepUpCap > 0) sip = Math.min(sip, p.stepUpCap);
    }

    // Step 4: SWP. The withdrawal rises in the first month of every new SWP year
    if (phase === 'swp' && swpMonth > 1 && (swpMonth - 1) % 12 === 0) {
      swp = swp * (1 + p.swpIncrease / 100);
    }
    if (phase === 'swp' && swpMonth === 1) corpusAtSwpStart = corpus;

    const rate = phase === 'swp' ? iSwp : iGrow;
    const opening = corpus;
    let contribution = phase === 'sip' ? sip : 0;
    let wanted = phase === 'swp' && depletedMonth === null ? swp : 0;
    let withdrawal, growth;

    // Step 5: move the balance forward one month
    if (p.timing === 'start') {
      corpus += contribution;                  // SIP goes in on day 1
      withdrawal = Math.min(wanted, corpus);   // SWP comes out on day 1, never more than the balance
      corpus -= withdrawal;
      growth = corpus * rate;                  // what's left earns one month of return
      corpus += growth;
    } else {
      growth = corpus * rate;                  // opening balance earns the month's return
      corpus += growth + contribution;         // SIP goes in on the last day
      withdrawal = Math.min(wanted, corpus);   // SWP comes out on the last day
      corpus -= withdrawal;
    }

    if (wanted > 0 && withdrawal < wanted - 0.005) depletedMonth = m;   // couldn't pay in full
    invested += contribution;
    withdrawn += withdrawal;
    if (m === sipMonths) corpusAtSipEnd = corpus;

    months.push({
      month: m, year: Math.ceil(m / 12), phase, rate,
      opening, contribution, withdrawal, wanted, growth,
      closing: corpus, invested, withdrawn,
      real: corpus / Math.pow(1 + p.inflation / 100, m / 12)   // in today's money
    });
  }

  return {
    months,
    summary: {
      totalInvested: invested,
      corpusAtSipEnd,
      corpusAtSwpStart,
      totalWithdrawn: withdrawn,
      finalCorpus: corpus,
      depletedMonth,
      lastSip: sip
    }
  };
};
const ORIGINAL_SRC = ORIGINAL_ENGINE.toString();

/* =====================================================================
   App state
   ===================================================================== */
const DEFAULTS = {
  monthlySip: 46000, existingCorpus: 0, sipYears: 20,
  stepUpType: 'pct', stepUpValue: 10, stepUpCap: 0,
  rates: [8, 10, 12, 14], selectedRate: 12, inflation: 6, currentAge: '',
  swpEnabled: true, swpGapYears: 0, swpMonthly: 250000, swpIncrease: 6, swpYears: 25,
  swpReturnMode: 'minus', swpReturnValue: 2,
  rateMode: 'effective', timing: 'start',
  chartMode: 'all', valueMode: 'nominal', tab: 'ledger'
};
const KEY = 'corpus-planner:v1', KEY_ENGINE = 'corpus-planner:engine';
const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  del(k) { try { window.localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } }
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v, lo, hi) => { v = Number(v); if (!isFinite(v)) v = 0; return Math.min(hi, Math.max(lo, v)); };
const fmtNum = x => String(+(+x).toFixed(2));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const n0 = v => INR.format(Math.round(v));
const full = v => (v < 0 ? '−₹' : '₹') + INR.format(Math.round(Math.abs(v)));
function cmp(v) {
  v = Number(v) || 0; const a = Math.abs(v); let s;
  if (a >= 1e10) s = INR.format(Math.round(a / 1e7)) + ' Cr';
  else if (a >= 1e9) s = (a / 1e7).toFixed(1) + ' Cr';
  else if (a >= 1e7) s = (a / 1e7).toFixed(2) + ' Cr';
  else if (a >= 1e5) s = (a / 1e5).toFixed(2) + ' L';
  else if (a >= 1e3) s = (a / 1e3).toFixed(1) + 'K';
  else s = String(Math.round(a));
  return (v < 0 ? '−₹' : '₹') + s;
}
function tick(v) {
  const a = Math.abs(v), t = x => String(+x.toFixed(1));
  if (a >= 1e7) return '₹' + t(v / 1e7) + ' Cr';
  if (a >= 1e5) return '₹' + t(v / 1e5) + ' L';
  if (a >= 1e3) return '₹' + t(v / 1e3) + 'K';
  return '₹' + Math.round(v);
}
function words(v) {
  v = Number(v) || 0; const a = Math.abs(v), t = x => String(+x.toFixed(2));
  if (a >= 1e7) return '₹' + t(v / 1e7) + ' crore';
  if (a >= 1e5) return '₹' + t(v / 1e5) + ' lakh';
  if (a >= 1e3) return '₹' + t(v / 1e3) + ' thousand';
  return '₹' + Math.round(v);
}
function yrsMo(m) {
  const y = Math.floor(m / 12), r = m % 12;
  if (y && r) return `${plural(y, 'year')} ${plural(r, 'month')}`;
  if (y) return plural(y, 'year');
  return plural(r, 'month');
}
function cleanRates(list) {
  const out = [];
  for (const x of list) {
    const v = Math.round(Number(x) * 100) / 100;
    if (isFinite(v) && v >= -10 && v <= 40 && !out.includes(v)) out.push(v);
  }
  return out.sort((a, b) => a - b).slice(0, 6);
}
function loadState(saved) {
  if (!saved || typeof saved !== 'object') {
    try { saved = JSON.parse(store.get(KEY) || '{}') || {}; } catch (e) { saved = {}; }
  }
  const s = Object.assign({}, DEFAULTS);
  for (const k of Object.keys(DEFAULTS)) {
    if (k === 'rates' || k === 'currentAge') continue;
    if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) s[k] = saved[k];
  }
  if (saved.currentAge === '' || typeof saved.currentAge === 'number') s.currentAge = saved.currentAge;
  s.rates = cleanRates(Array.isArray(saved.rates) ? saved.rates : DEFAULTS.rates);
  if (!s.rates.length) s.rates = DEFAULTS.rates.slice();
  return s;
}
let state = loadState();
const save = () => {
  store.set(KEY, JSON.stringify(state));
  document.dispatchEvent(new CustomEvent('mf:changed', { detail: { what: 'plan' } }));
};
// Which tab and chart view is showing belongs to each device; the rest syncs.
const LOCAL_ONLY = ['tab', 'chartMode', 'valueMode'];
const colorVar = i => `var(--c${(i % 6) + 1})`;
function ageAt(y) {
  const a = state.currentAge;
  if (a === '' || a == null || !isFinite(+a) || +a <= 0) return null;
  return Math.floor(+a + y);
}

function paramsFor(rate, over) {
  const s = state;
  const v = num(s.swpReturnValue, -50, 60);
  const swpReturn = s.swpReturnMode === 'same' ? rate : s.swpReturnMode === 'minus' ? rate - v : v;
  return Object.assign({
    existingCorpus: num(s.existingCorpus, 0, 1e13),
    monthlySip: num(s.monthlySip, 0, 1e11),
    sipYears: Math.round(num(s.sipYears, 1, 60)),
    stepUpType: s.stepUpType === 'amt' ? 'amt' : 'pct',
    stepUpValue: num(s.stepUpValue, 0, s.stepUpType === 'amt' ? 1e10 : 100),
    stepUpCap: num(s.stepUpCap, 0, 1e12),
    annualReturn: rate,
    rateMode: s.rateMode === 'nominal' ? 'nominal' : 'effective',
    timing: s.timing === 'end' ? 'end' : 'start',
    inflation: num(s.inflation, 0, 30),
    swpEnabled: !!s.swpEnabled,
    swpGapYears: Math.round(num(s.swpGapYears, 0, 40)),
    swpMonthly: num(s.swpMonthly, 0, 1e11),
    swpIncrease: num(s.swpIncrease, 0, 50),
    swpYears: Math.round(num(s.swpYears, 1, 60)),
    swpReturn
  }, over || {});
}
const monthlyRateOf = (annual, mode) => mode === 'nominal' ? annual / 100 / 12 : Math.pow(1 + annual / 100, 1 / 12) - 1;

/* =====================================================================
   Running the (possibly edited) engine
   ===================================================================== */
let customEngine = null, customSrc = null, bannerMsg = '';

function checkResult(r) {
  if (!r || !Array.isArray(r.months) || !r.summary) throw new Error('simulate(p) must return { months: [...], summary: {...} }.');
  if (!isFinite(r.summary.finalCorpus)) throw new Error('summary.finalCorpus must be a number.');
  if (!isFinite(r.summary.corpusAtSipEnd)) throw new Error('summary.corpusAtSipEnd must be a number.');
  return r;
}
function compileViaScript(src) {
  let syntaxErr = null;
  const onErr = ev => { syntaxErr = ev.message || 'Syntax error in the edited code.'; ev.preventDefault(); };
  window.addEventListener('error', onErr);
  window.__cpEngine = undefined; window.__cpErr = undefined;
  const el = document.createElement('script');
  el.textContent = '(function(){try{window.__cpEngine=(function(){"use strict";\n' + src + '\n;return typeof simulate==="function"?simulate:undefined;})();}catch(e){window.__cpErr=e;}})();';
  document.head.appendChild(el); el.remove();
  window.removeEventListener('error', onErr);
  if (window.__cpErr) throw window.__cpErr;
  if (syntaxErr) throw new Error(syntaxErr);
  if (typeof window.__cpEngine !== 'function') throw new Error('This page could not run the edited code here. Every assumption can still be changed from the controls on the left.');
  return window.__cpEngine;
}
function compileEngine(src) {
  let fn;
  try {
    fn = new Function('"use strict";\n' + src + '\n;return typeof simulate === "function" ? simulate : undefined;')();
  } catch (e) {
    const blocked = e instanceof EvalError || /unsafe-eval|content security|refused to evaluate/i.test(String(e && e.message));
    if (!blocked) throw e;
    fn = compileViaScript(src);
  }
  if (typeof fn !== 'function') throw new Error('The code needs to define a function called simulate(p).');
  return fn;
}
function run(p) {
  if (customEngine) {
    try { return checkResult(customEngine(Object.assign({}, p))); }
    catch (e) { bannerMsg = 'Your edited engine stopped with an error: ' + (e && e.message ? e.message : e) + ' The page is showing results from the original engine until it is fixed.'; }
  }
  return ORIGINAL_ENGINE(p);
}
function maxSustainable(p) {
  if (!p.swpEnabled) return null;
  const base = run(Object.assign({}, p, { swpMonthly: 0 }));
  const start = base.summary.corpusAtSwpStart;
  if (!(start > 0)) return 0;
  let lo = 0, hi = start * 2;
  for (let k = 0; k < 34; k++) {
    const mid = (lo + hi) / 2;
    const r = run(Object.assign({}, p, { swpMonthly: mid }));
    if (r.summary.depletedMonth == null) lo = mid; else hi = mid;
  }
  return Math.floor(lo);
}
function toYears(months, p) {
  const out = [];
  let realInv = p.existingCorpus, realWd = 0;
  for (const m of months) {
    const df = Math.pow(1 + p.inflation / 100, m.month / 12);
    const contrib = m.contribution || 0, wd = m.withdrawal || 0;
    realInv += contrib / df; realWd += wd / df;
    const yi = m.year || Math.ceil(m.month / 12);
    let y = out[yi - 1];
    if (!y) y = out[yi - 1] = { year: yi, phase: m.phase, opening: m.opening, sipMonthly: 0, wdMonthly: 0, added: 0, withdrawn: 0, growth: 0, months: [] };
    y.months.push(m);
    y.added += contrib; y.withdrawn += wd; y.growth += m.growth || 0;
    if (!y.sipMonthly && contrib) y.sipMonthly = contrib;
    const want = m.wanted != null ? m.wanted : wd;
    if (!y.wdMonthly && want) y.wdMonthly = want;
    y.closing = m.closing; y.invested = m.invested; y.cumWithdrawn = m.withdrawn;
    y.real = m.real != null ? m.real : m.closing / df;
    y.realInvested = realInv; y.realWithdrawn = realWd;
  }
  return out.filter(Boolean);
}
function lastSipOf(r) {
  const s = r.res.summary;
  if (isFinite(s.lastSip)) return s.lastSip;
  const m = r.res.months.filter(x => x.contribution > 0).pop();
  return m ? m.contribution : r.p.monthlySip;
}
function outcome(r) {
  const p = r.p, s = r.res.summary;
  const startM = (p.sipYears + p.swpGapYears) * 12;
  if (s.depletedMonth != null) {
    return { ok: false, months: Math.max(0, s.depletedMonth - startM - 1), year: Math.ceil(s.depletedMonth / 12), age: ageAt(s.depletedMonth / 12) };
  }
  return { ok: true };
}

let results = [];
const sel = () => results.find(r => r.rate === state.selectedRate) || results[0];

function recalc() {
  bannerMsg = '';
  if (!state.rates.includes(state.selectedRate)) {
    state.selectedRate = state.rates.reduce((b, x) => Math.abs(x - 12) < Math.abs(b - 12) ? x : b, state.rates[0]);
  }
  results = state.rates.map(rate => {
    const p = paramsFor(rate);
    const res = run(p);
    return { rate, p, res, years: toYears(res.months, p), maxSwp: p.swpEnabled ? maxSustainable(p) : null };
  });
  renderAll();
  save();
}
let timer = null;
const schedule = () => { clearTimeout(timer); timer = setTimeout(recalc, 80); };

/* =====================================================================
   Rendering
   ===================================================================== */
function renderAll() {
  renderChips(); syncOutputs(); renderBanner(); renderStatement(); renderPills();
  renderChart(); renderLegend(); renderMix(); renderFigures(); renderNotes(); renderCompare(); renderLedger(); renderLogic(); renderCodeStatus();
  renderSum();
}
// One line at the top of the input panel on phones, so the result stays in view while editing.
function renderSum() {
  const r = sel(), el = $('#planSum');
  if (!r || !el) return;
  el.textContent = `${cmp(r.res.summary.corpusAtSipEnd)} at ${fmtNum(r.rate)}% after ${plural(r.p.sipYears, 'year')}`;
}
function renderChips() {
  const one = state.rates.length <= 1;
  $('#rateChips').innerHTML = state.rates.map((r, i) =>
    `<span class="chip" style="--c:${colorVar(i)}"><i></i>${fmtNum(r)}%<button type="button" data-remove="${r}" aria-label="Remove the ${fmtNum(r)}% rate"${one ? ' disabled' : ''}>×</button></span>`).join('');
}
function setHint(k, t) { const el = $(`[data-hint="${k}"]`); if (el) el.textContent = t; }
function setOut(k, t) { const el = $(`[data-out="${k}"]`); if (el) el.textContent = t; }
function syncOutputs() {
  const s = state;
  const endAge = ageAt(num(s.sipYears, 1, 60));
  setOut('sipYears', plural(s.sipYears, 'year') + (endAge != null ? `, to age ${endAge}` : ''));
  setOut('swpYears', plural(s.swpYears, 'year'));
  setOut('swpGapYears', s.swpGapYears > 0 ? `${plural(s.swpGapYears, 'year')} after the last SIP` : 'right after the last SIP');
  setHint('monthlySip', words(s.monthlySip) + ' a month');
  setHint('existingCorpus', s.existingCorpus > 0 ? words(s.existingCorpus) + ', growing from today' : 'Leave at 0 to start from scratch');
  setHint('swpMonthly', `${words(s.swpMonthly)} a month, ${words(s.swpMonthly * 12)} in the first year`);
  $('#stepPre').textContent = s.stepUpType === 'amt' ? '₹' : '';
  $('#stepPost').textContent = s.stepUpType === 'amt' ? 'a year' : '% a year';
  const y2 = s.stepUpType === 'amt' ? s.monthlySip + (+s.stepUpValue || 0) : s.monthlySip * (1 + (+s.stepUpValue || 0) / 100);
  setHint('stepUp', (+s.stepUpValue || 0) > 0 ? `Year 2 SIP: ${full(s.stepUpCap > 0 ? Math.min(y2, s.stepUpCap) : y2)} a month` : 'Step-up is off, so the SIP stays flat');
  $('#swpRetBox').hidden = s.swpReturnMode === 'same';
  const sr = s.selectedRate;
  setHint('swpReturn', s.swpReturnMode === 'same' ? 'Each rate keeps earning the same return while you withdraw'
    : s.swpReturnMode === 'minus' ? `The ${fmtNum(sr)}% rate earns ${fmtNum(sr - (+s.swpReturnValue || 0))}% while you withdraw, e.g. after moving part of it to debt`
    : `Every rate earns ${fmtNum(+s.swpReturnValue || 0)}% while you withdraw`);
  $('#swpFields').classList.toggle('off', !s.swpEnabled);
  $$('#view-plan input[type=range]').forEach(el => {
    const lo = +el.min, hi = +el.max;
    el.style.setProperty('--fill', ((+el.value - lo) / (hi - lo) * 100) + '%');
  });
}
function renderBanner() {
  const b = $('#banner');
  if (bannerMsg) b.innerHTML = `<div class="banner err" role="alert">${esc(bannerMsg)}</div>`;
  else if (customEngine) b.innerHTML = `<div class="banner info">These results come from your edited engine. <button type="button" class="linkish" data-goto="engine">Open the editor</button> or <button type="button" class="linkish" data-restore>restore the original</button>.</div>`;
  else b.innerHTML = '';
}
const inp = (key, text) => `<button type="button" class="in" data-focus="${key}">${text}</button>`;
function renderStatement() {
  const r = sel(); if (!r) return;
  const p = r.p, s = r.res.summary;
  const existing = p.existingCorpus > 0 ? `I already have ${inp('existingCorpus', cmp(p.existingCorpus))} invested. ` : '';
  const step = p.stepUpValue > 0
    ? `, raise it by ${inp('stepUpValue', p.stepUpType === 'pct' ? fmtNum(p.stepUpValue) + '%' : full(p.stepUpValue))} every year${p.stepUpCap > 0 ? ` until it reaches ${inp('stepUpCap', cmp(p.stepUpCap))}` : ''},`
    : ` (${inp('stepUpValue', 'no yearly raise')})`;
  const age = ageAt(p.sipYears);
  $('#planSentence').innerHTML = `${existing}I invest ${inp('monthlySip', full(p.monthlySip))} a month${step} and keep going for ${inp('sipYears', plural(p.sipYears, 'year'))}.`;

  const endYear = new Date().getFullYear() + p.sipYears;
  const real = s.corpusAtSipEnd / Math.pow(1 + p.inflation / 100, p.sipYears);
  $('#resultLead').textContent = `At ${fmtNum(r.rate)}% a year, in ${endYear}${age != null ? ` (age ${age})` : ''} you'd have`;
  $('#statement').textContent = cmp(s.corpusAtSipEnd);
  $('#resultLine').innerHTML = `That buys what <b>${cmp(real)}</b> buys today, if prices rise ${inp('inflation', fmtNum(p.inflation) + '%')} a year. You'd have put in <b>${cmp(s.totalInvested)}</b>.`;

  const s2 = $('#statement2');
  if (!p.swpEnabled) { s2.innerHTML = `<button type="button" class="linkish add-swp" data-swp-on>Add money I'll take out later</button>`; return; }
  const startYear = p.sipYears + p.swpGapYears;
  const startAge = ageAt(startYear);
  const when = `from year ${startYear + 1}${startAge != null ? ` (age ${startAge})` : ''}` + (p.swpGapYears > 0 ? `, after a ${inp('swpGapYears', p.swpGapYears + '-year')} wait` : '');
  const raise = p.swpIncrease > 0 ? `, raised ${inp('swpIncrease', fmtNum(p.swpIncrease) + '%')} a year` : '';
  const o = outcome(r);
  s2.innerHTML = `Then I take out ${inp('swpMonthly', full(p.swpMonthly))} a month ${when}${raise}. At ${fmtNum(r.rate)}% it ` + (o.ok
    ? `lasts all ${inp('swpYears', plural(p.swpYears, 'year'))} and still leaves <span class="out">${cmp(s.finalCorpus)}</span>.`
    : (o.months > 0
      ? `runs out after <span class="out bad">${yrsMo(o.months)}</span>${o.age != null ? `, around age ${o.age}` : ''}, short of the ${inp('swpYears', plural(p.swpYears, 'year'))} planned.`
      : `<span class="out bad">can't cover even the first withdrawal</span>. Lower the amount or invest for longer.`));
}
function renderPills() {
  const cur = sel();
  $('#pills').innerHTML = results.map((r, i) =>
    `<button type="button" class="rate-pill" style="--c:${colorVar(i)}" data-rate="${r.rate}" aria-pressed="${r === cur}" aria-label="Focus on ${fmtNum(r.rate)}% a year"><i></i>${fmtNum(r.rate)}%</button>`).join('');
  $('#cmAllLbl').textContent = results.length === 1 ? 'The one return' : `All ${results.length} returns`;
  $('#cmOneLbl').textContent = cur ? `Only ${fmtNum(cur.rate)}%` : 'Only this one';
}
function renderLegend() {
  const cur = sel();
  const real = state.valueMode === 'real';
  const v = r => real ? r.res.summary.corpusAtSipEnd / Math.pow(1 + r.p.inflation / 100, r.p.sipYears) : r.res.summary.corpusAtSipEnd;
  const rows = results.map((r, i) => ({ r, i })).sort((a, b) => b.r.rate - a.r.rate);
  $('#planLegend').innerHTML = rows.map(({ r, i }) =>
    `<li class="${r === cur ? 'on' : ''}" data-rate="${r.rate}"><span class="sw" style="--c:${colorVar(i)}"></span><span class="nm">${fmtNum(r.rate)}% a year</span><b>${cmp(v(r))}</b></li>`).join('') +
    (cur ? `<li class="inv"><span class="sw" style="--c:var(--ink-3);height:0;border-top:2px dashed var(--ink-3);background:none"></span><span class="nm">Money you put in</span><b>${cmp(real ? (cur.years[cur.p.sipYears - 1] || {}).realInvested || 0 : cur.res.summary.totalInvested)}</b></li>` : '');
}

/* What the corpus at the end of the SIPs is made of: what you had, your SIP at its
   starting amount, the yearly raises, and growth. Shown as a donut, pie or bars. */
const MIX_TYPES = [['donut', 'Donut', 'donut'], ['pie', 'Pie', 'pie'], ['bar', 'Bars', 'hbar']];
let mixType = window.MF ? MF.pref('planMix', 'donut', MIX_TYPES.map(x => x[0])) : 'donut', mixChart = null;
function mixParts() {
  const r = sel(); if (!r) return null;
  const p = r.p, s = r.res.summary;
  const sipMonths = r.res.months.filter(m => m.phase === 'sip');
  const paid = sipMonths.reduce((t, m) => t + (m.contribution || 0), 0);
  const base = Math.min(paid, p.monthlySip * sipMonths.filter(m => m.contribution > 0).length);
  const parts = [
    { name: 'What you have today', v: p.existingCorpus, c: 'var(--c5)' },
    { name: `Your ${full(p.monthlySip)} a month`, v: base, c: 'var(--c2)' },
    { name: p.stepUpType === 'pct' ? `The yearly ${fmtNum(p.stepUpValue)}% raises` : 'The yearly raises', v: Math.max(0, paid - base), c: 'var(--c6)' },
    { name: `Growth at ${fmtNum(r.rate)}% a year`, v: s.corpusAtSipEnd - p.existingCorpus - paid, c: 'var(--c1)' }
  ];
  return { r, parts, total: s.corpusAtSipEnd };
}
function renderMix() {
  const m = mixParts(); if (!m) return;
  const box = $('#planMixBox');
  $('#planMixTitle').textContent = `What your ${cmp(m.total)} is made of`;
  if (mixChart) { mixChart.destroy(); mixChart = null; }
  const neg = m.parts.some(x => x.v < -0.5);
  const parts = m.parts.filter(x => x.v > 0.5);
  const share = v => m.total > 0 ? v / m.total : 0;
  $('#planMixLegend').innerHTML = m.parts.filter(x => Math.abs(x.v) > 0.5).map(x =>
    `<li style="--c:${x.c}"><i></i><span class="nm">${esc(x.name)}</span><span class="v">${cmp(x.v)}</span><span class="s">${x.v > 0 ? Math.round(share(x.v) * 100) + '%' : ''}</span></li>`).join('');
  $('#planMix .mix-body').classList.toggle('bars', mixType === 'bar' && !neg);
  if (neg) { box.innerHTML = '<div class="chart-fallback">At this return the corpus ends up smaller than what you put in, so there is no growth to show.</div>'; return; }
  if (typeof window.Chart === 'undefined') { box.innerHTML = '<div class="chart-fallback">The chart library did not load. The list has every figure.</div>'; return; }
  if (!$('#planMixChart')) box.innerHTML = '<canvas id="planMixChart" role="img" aria-label="What the corpus is made of"></canvas>';
  const col = x => cssVar(x.c.slice(4, -1));
  const tip = { backgroundColor: cssVar('--sheet'), titleColor: cssVar('--ink'), bodyColor: cssVar('--ink-2'), borderColor: cssVar('--rule-2'), borderWidth: 1, padding: 10,
    callbacks: { title: it => parts[it[0].dataIndex].name, label: ctx => ` ${cmp(parts[ctx.dataIndex].v)}, ${Math.round(share(parts[ctx.dataIndex].v) * 100)}%` } };
  if (mixType === 'bar') {
    box.style.height = (parts.length * 42 + 30) + 'px';
    mixChart = new window.Chart($('#planMixChart'), {
      type: 'bar',
      data: { labels: parts.map(x => x.name), datasets: [{ data: parts.map(x => x.v), backgroundColor: parts.map(col), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 22 }] },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: false, layout: { padding: { right: 44 } },
        plugins: { legend: { display: false }, tooltip: tip, barValues: { format: v => Math.round(share(v) * 100) + '%', color: cssVar('--ink-2') } },
        scales: { x: { grid: { color: cssVar('--rule') }, border: { display: false }, ticks: { color: cssVar('--muted'), maxTicksLimit: 4, callback: v => tick(v) } },
          y: { grid: { display: false }, ticks: { color: cssVar('--ink-2'), autoSkip: false, font: { family: 'IBM Plex Sans', size: 12 } } } } }
    });
    return;
  }
  box.style.height = '';
  mixChart = new window.Chart($('#planMixChart'), {
    type: 'doughnut',
    data: { labels: parts.map(x => x.name), datasets: [{ data: parts.map(x => x.v), backgroundColor: parts.map(col), borderColor: cssVar('--sheet'), borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, cutout: mixType === 'donut' ? '62%' : 0, layout: { padding: 4 },
      plugins: { legend: { display: false }, tooltip: tip,
        donutCenter: { text: Math.round(share(Math.max(0, m.total - m.parts[0].v - m.parts[1].v - m.parts[2].v)) * 100) + '%', caption: 'growth', color: cssVar('--ink'), sub: cssVar('--muted'), size: 18 } } }
  });
}

/* chart */
let chart = null, chartDrawn = false;
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function hexA(hex, a) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  if (!isFinite(n)) return hex;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
const phaseShade = {
  id: 'phaseShade',
  beforeDatasetsDraw(c, _args, o) {
    if (!o || o.start == null) return;
    const x = c.scales.x, area = c.chartArea;
    if (!x || !area) return;
    const x0 = x.getPixelForValue(o.start);
    if (!(x0 < area.right)) return;
    const ctx = c.ctx;
    ctx.save();
    ctx.fillStyle = o.fill; ctx.fillRect(x0, area.top, area.right - x0, area.bottom - area.top);
    ctx.strokeStyle = o.line; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(x0) + .5, area.top); ctx.lineTo(Math.round(x0) + .5, area.bottom); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = o.text; ctx.font = '500 12px "IBM Plex Sans", system-ui, sans-serif';
    if (area.right - x0 > 90) ctx.fillText('Withdrawals', x0 + 8, area.top + 16);
    ctx.restore();
  }
};
function yearTitle(y) {
  if (y === 0) return 'Today';
  const a = ageAt(y);
  return `End of year ${y}` + (a != null ? `, age ${a}` : '');
}
// Chart type: the same corpus as lines, filled areas, or yearly columns.
const PLAN_TYPES = [['line', 'Line', 'line'], ['area', 'Area', 'area'], ['bar', 'Bars', 'bar']];
let planType = window.MF ? MF.pref('plan', 'line', PLAN_TYPES.map(x => x[0])) : 'line';
function renderChart() {
  const box = $('#chartBox');
  if (typeof window.Chart === 'undefined') {
    box.innerHTML = '<div class="chart-fallback">The chart library did not load, so the chart is hidden. Every number is still in the tables below.</div>';
    return;
  }
  if (!$('#chart')) box.innerHTML = '<canvas id="chart" role="img" aria-label="Chart of corpus growth by year"></canvas>';
  const real = state.valueMode === 'real';
  const colors = results.map((_, i) => cssVar('--c' + ((i % 6) + 1)));
  const ink = cssVar('--ink'), ink2 = cssVar('--ink-2'), muted = cssVar('--muted'), rule = cssVar('--rule'), rule2 = cssVar('--rule-2'), sheet = cssVar('--sheet');
  const gold = cssVar('--c2'), wd = cssVar('--wd');
  const cur = sel(); if (!cur) return;
  const maxLen = Math.max(...results.map(r => r.years.length));
  const start = cur.p.existingCorpus;
  const type = planType, bars = type === 'bar';
  const narrow = window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
  const corpusAt = (r, y) => y === 0 ? r.p.existingCorpus : y <= r.years.length ? (real ? r.years[y - 1].real : r.years[y - 1].closing) : null;
  const investedAt = (r, y) => y === 0 ? start : y <= r.years.length ? (real ? r.years[y - 1].realInvested : r.years[y - 1].invested) : null;
  const outAt = (r, y) => y === 0 ? 0 : y <= r.years.length ? (real ? r.years[y - 1].realWithdrawn : r.years[y - 1].cumWithdrawn) : null;
  const barSpec = { type: 'bar', borderRadius: 4, borderSkipped: 'start', maxBarThickness: 22, categoryPercentage: .82, barPercentage: .9, order: 2 };
  let years, datasets;
  if (state.chartMode === 'all' && bars) {
    // Grouped columns every few years, so each group stays readable.
    const want = narrow ? 6 : 10, raw = Math.ceil(maxLen / want);
    const step = [1, 2, 5, 10].find(s => s >= raw) || raw;
    years = [];
    for (let y = step; y <= maxLen; y += step) years.push(y);
    if (years[years.length - 1] !== maxLen) years.push(maxLen);
    datasets = results.map((r, idx) => Object.assign({}, barSpec, { label: fmtNum(r.rate) + '% a year', data: years.map(y => corpusAt(r, y)), backgroundColor: colors[idx], hoverBackgroundColor: colors[idx] }));
    datasets.push({ type: 'line', label: 'Money you put in', data: years.map(y => investedAt(cur, y)), borderColor: muted, backgroundColor: muted, borderDash: [5, 5], borderWidth: 1.5, pointRadius: 3, pointBackgroundColor: sheet, pointBorderWidth: 1.5, tension: 0, order: 0 });
  } else if (state.chartMode === 'all') {
    years = Array.from({ length: maxLen + 1 }, (_, i) => i);
    datasets = results.map((r, idx) => {
      const isSel = r === cur;
      return {
        type: 'line', label: fmtNum(r.rate) + '% a year',
        data: years.map(y => corpusAt(r, y)),
        borderColor: colors[idx], backgroundColor: type === 'area' && isSel ? hexA(colors[idx], .12) : colors[idx],
        fill: type === 'area' && isSel ? 'origin' : false,
        borderWidth: isSel ? 3 : type === 'area' ? 1.4 : 1.6, pointRadius: 0, pointHoverRadius: 4, tension: .25, order: isSel ? 0 : 1
      };
    });
    datasets.push({ type: 'line', label: 'Money you put in', data: years.map(y => investedAt(cur, y)), borderColor: muted, backgroundColor: muted, borderDash: [5, 5], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, tension: 0, order: 2 });
  } else {
    years = Array.from({ length: cur.years.length + 1 }, (_, i) => i);
    const c = colors[results.indexOf(cur)];
    const corpus = years.map(y => corpusAt(cur, y));
    datasets = [bars
      ? Object.assign({}, barSpec, { label: 'Corpus', data: corpus, backgroundColor: hexA(c, .85), hoverBackgroundColor: c, maxBarThickness: 18, categoryPercentage: .9, barPercentage: .92 })
      : { type: 'line', label: 'Corpus', data: corpus, borderColor: c, backgroundColor: hexA(c, .12), fill: type === 'area' ? 'origin' : false, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 4, tension: .25, order: 1 }];
    datasets.push({ type: 'line', label: 'Money you put in', data: years.map(y => investedAt(cur, y)), borderColor: gold, backgroundColor: type === 'area' ? hexA(gold, .1) : gold, fill: type === 'area' ? 'origin' : false, borderDash: [6, 5], borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 3, tension: 0, order: 0 });
    if (cur.p.swpEnabled) datasets.push({ type: 'line', label: 'Money you took out', data: years.map(y => outAt(cur, y)), borderColor: wd, backgroundColor: wd, borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 3, tension: .2, order: 0 });
  }
  // Where withdrawals begin, as a position on the x axis (between columns for bars).
  const swpYear = cur.p.swpEnabled ? cur.p.sipYears + cur.p.swpGapYears : null;
  let swpStart = null;
  if (swpYear != null) {
    if (!bars) swpStart = swpYear;
    else { const i = years.findIndex(y => y > swpYear); if (i > 0) swpStart = i - 0.5; else if (i === 0) swpStart = -0.5; }
  }
  if (chart) { chart.destroy(); chart = null; }
  chart = new window.Chart($('#chart'), {
    type: bars ? 'bar' : 'line',
    data: { labels: years, datasets },
    plugins: [phaseShade],
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: chartDrawn || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 700, easing: 'easeOutCubic' },
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 4, right: 4 } },
      plugins: {
        legend: { display: state.chartMode === 'one', position: 'bottom', labels: { color: ink2, usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: narrow ? 10 : 16, font: { family: 'IBM Plex Sans', size: narrow ? 11.5 : 12.5 } } },
        tooltip: {
          backgroundColor: sheet, titleColor: ink, bodyColor: ink2, borderColor: rule2, borderWidth: 1, padding: 10, boxPadding: 4, usePointStyle: true,
          titleFont: { family: 'IBM Plex Sans', weight: '600', size: 13 }, bodyFont: { family: 'IBM Plex Sans', size: 12.5 },
          callbacks: { title: items => yearTitle(+items[0].label), label: c => c.parsed.y == null ? null : ` ${c.dataset.label}: ${cmp(c.parsed.y)}` }
        },
        phaseShade: { start: swpStart, fill: hexA(wd, .06), line: hexA(wd, .5), text: wd }
      },
      scales: {
        x: { grid: { display: false }, border: { color: rule2 }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 14, font: { family: 'IBM Plex Sans', size: 11.5 }, callback(v) { const y = +this.getLabelForValue(v); return y === 0 ? 'Now' : 'Yr ' + y; } } },
        y: { grid: { color: rule }, border: { display: false }, beginAtZero: true, ticks: { color: muted, maxTicksLimit: 6, font: { family: 'IBM Plex Sans', size: 11.5 }, callback: v => tick(v) } }
      }
    }
  });
  chartDrawn = true;
}

function fig(k, v, d, cls) {
  return `<div class="fig"><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;
}
function renderFigures() {
  const r = sel(); if (!r) return;
  const p = r.p, s = r.res.summary;
  const inv = s.totalInvested, end = s.corpusAtSipEnd, gain = end - inv;
  const real = end / Math.pow(1 + p.inflation / 100, p.sipYears);
  const lastSip = lastSipOf(r);
  let h = '<div class="figs">' +
    fig('You put in', cmp(inv), p.stepUpValue > 0 ? `SIP reaches ${full(lastSip)} a month in year ${p.sipYears}` : `${full(p.monthlySip)} every month`) +
    fig('Growth on top', cmp(gain), inv > 0 ? `${(end / inv).toFixed(2)}× the money you put in` : '') +
    fig("Worth in today's money", cmp(real), `after ${fmtNum(p.inflation)}% inflation a year`) +
    fig('Exact corpus at SIP end', full(end), `after ${p.sipYears * 12} monthly SIPs`) + '</div>';
  if (p.swpEnabled) {
    const o = outcome(r);
    const startC = s.corpusAtSwpStart || 0;
    const startYr = p.sipYears + p.swpGapYears;
    const wr = startC > 0 ? p.swpMonthly * 12 / startC * 100 : 0;
    const firstReal = p.swpMonthly / Math.pow(1 + p.inflation / 100, startYr);
    const enough = r.maxSwp != null && r.maxSwp >= p.swpMonthly;
    h += `<div class="figs-label">Withdrawal phase, earning ${fmtNum(p.swpReturn)}% a year</div><div class="figs">` +
      fig('Corpus when withdrawals start', cmp(startC), p.swpGapYears > 0 ? `grew for ${plural(p.swpGapYears, 'more year')} after the last SIP` : `start of year ${startYr + 1}`) +
      fig('First withdrawal', full(p.swpMonthly) + '<small> a month</small>', `${wr.toFixed(1)}% of the corpus in year 1, ${cmp(firstReal)} in today's money`) +
      fig('Total withdrawn', cmp(s.totalWithdrawn), o.ok ? `and ${cmp(s.finalCorpus)} is left after ${plural(p.swpYears, 'year')}` : `payments stop in year ${o.year}`, o.ok ? '' : 'bad') +
      fig('Most you can withdraw', r.maxSwp != null ? full(r.maxSwp) + '<small> a month</small>' : '—', `and still last ${plural(p.swpYears, 'year')}, raised ${fmtNum(p.swpIncrease)}% a year`, enough ? 'good' : 'bad') +
      '</div>';
  }
  $('#figures').innerHTML = h;
}
function renderNotes() {
  const r = sel(); if (!r) return;
  const p = r.p, s = r.res.summary, notes = [];
  if (p.stepUpValue > 0) {
    const flat = run(Object.assign({}, p, { stepUpValue: 0, swpEnabled: false })).summary.corpusAtSipEnd;
    notes.push([`Step-up adds ${cmp(s.corpusAtSipEnd - flat)}`, `Keeping the SIP flat at ${full(p.monthlySip)} would end at ${cmp(flat)}. Raising it every year makes the corpus ${(s.corpusAtSipEnd / Math.max(flat, 1)).toFixed(1)}× bigger.`]);
  } else {
    const alt = run(Object.assign({}, p, { stepUpType: 'pct', stepUpValue: 10, swpEnabled: false })).summary.corpusAtSipEnd;
    notes.push([`A 10% step-up would reach ${cmp(alt)}`, `Raising the SIP 10% a year, roughly in line with pay rises, takes this plan from ${cmp(s.corpusAtSipEnd)} to ${cmp(alt)}.`]);
  }
  const lower = run(paramsFor(r.rate - 1, { swpEnabled: false })).summary.corpusAtSipEnd;
  notes.push([`1% less costs ${cmp(s.corpusAtSipEnd - lower)}`, `At ${fmtNum(r.rate - 1)}% instead of ${fmtNum(r.rate)}% you'd end at ${cmp(lower)}. A 1% gap is roughly the extra yearly cost of a regular plan over a direct plan in many equity funds.`]);
  const marks = [1e7, 5e7, 1e8, 2.5e8, 5e8, 1e9, 2.5e9];
  const hits = [];
  for (const mk of marks) { const y = r.years.find(y => y.closing >= mk); if (y) hits.push([mk, y.year]); }
  const lab = mk => '₹' + (mk / 1e7) + ' Cr';
  const ageTxt = y => { const a = ageAt(y); return a != null ? ` (age ${a})` : ''; };
  if (hits.length) {
    const first = hits[0], rest = hits.slice(1, 3);
    notes.push([`${lab(first[0])} by year ${first[1]}${ageTxt(first[1])}`, rest.length
      ? `Then ${rest.map(h => `${lab(h[0])} by year ${h[1]}`).join(' and ')}. Each next milestone arrives faster as compounding builds.`
      : 'Compounding speeds up in the later years, so each extra year of staying invested adds more than the last.']);
  } else {
    const peak = Math.max(...r.years.map(y => y.closing));
    notes.push([`Peak corpus ${cmp(peak)}`, 'This plan stays under ₹1 Cr. More years or a step-up make the biggest difference.']);
  }
  $('#notes').innerHTML = notes.map(([t, d]) => `<div class="note-i"><h4>${t}</h4><p>${d}</p></div>`).join('');
}
function renderCompare() {
  const swp = state.swpEnabled, cur = sel();
  let h = `<thead><tr><th>Return</th><th>You put in</th><th>Corpus at SIP end</th><th>In today's money</th><th>Multiple</th>` +
    (swp ? `<th>At SWP start</th><th>Total withdrawn</th><th>Outcome</th><th>Most you can withdraw a month</th>` : '') + `</tr></thead><tbody>`;
  results.forEach((r, i) => {
    const s = r.res.summary, p = r.p;
    const real = s.corpusAtSipEnd / Math.pow(1 + p.inflation / 100, p.sipYears);
    h += `<tr data-rate="${r.rate}" class="${r === cur ? 'is-sel' : ''}" tabindex="0"><td><span class="dot" style="--c:${colorVar(i)}"></span>${fmtNum(r.rate)}%</td><td>${cmp(s.totalInvested)}</td><td class="strong">${cmp(s.corpusAtSipEnd)}</td><td>${cmp(real)}</td><td>${s.totalInvested > 0 ? (s.corpusAtSipEnd / s.totalInvested).toFixed(2) + '×' : '—'}</td>`;
    if (swp) {
      const o = outcome(r);
      h += `<td>${cmp(s.corpusAtSwpStart || 0)}</td><td>${cmp(s.totalWithdrawn)}</td><td>${o.ok ? `<span class="ok">Lasts, leaves ${cmp(s.finalCorpus)}</span>` : `<span class="bad">Runs out in year ${o.year}</span>`}</td><td>${r.maxSwp != null ? full(r.maxSwp) : '—'}</td>`;
    }
    h += '</tr>';
  });
  $('#compare').innerHTML = h + '</tbody>';
}
let openYear = null;
const tagFor = ph => ph === 'sip' ? '<span class="tag sip">SIP</span>' : ph === 'swp' ? '<span class="tag swp">SWP</span>' : '<span class="tag wait">Waiting</span>';
function renderLedger() {
  const r = sel(); if (!r) return;
  const showAge = ageAt(0) != null;
  $('#ledgerCaption').textContent = `The ${fmtNum(r.rate)}% rate. Select a year to see its 12 months. Amounts are rounded to the rupee.`;
  let h = `<thead><tr><th>Year</th>${showAge ? '<th>Age</th>' : ''}<th>Phase</th><th>Monthly SIP or SWP</th><th>Put in</th><th>Taken out</th><th>Returns earned</th><th>Closing corpus</th><th>Total put in</th><th>In today's money</th></tr></thead><tbody>`;
  for (const y of r.years) {
    const amt = y.phase === 'sip' ? full(y.sipMonthly) : y.phase === 'swp' ? full(y.wdMonthly) : '—';
    const isOpen = openYear === y.year;
    h += `<tr data-year="${y.year}" class="${isOpen ? 'open' : ''}" tabindex="0" aria-expanded="${isOpen}"><td><span class="caret">›</span>${y.year}</td>${showAge ? `<td>${ageAt(y.year)}</td>` : ''}<td>${tagFor(y.phase)}</td><td>${amt}</td><td>${y.added ? full(y.added) : '—'}</td><td>${y.withdrawn ? full(y.withdrawn) : '—'}</td><td>${full(y.growth)}</td><td class="strong">${full(y.closing)}</td><td>${full(y.invested)}</td><td>${full(y.real)}</td></tr>`;
    if (isOpen) {
      for (const m of y.months) {
        h += `<tr class="mrow"><td>Month ${m.month}</td>${showAge ? '<td></td>' : ''}<td></td><td>${full(m.opening)} opening</td><td>${m.contribution ? full(m.contribution) : '—'}</td><td>${m.withdrawal ? full(m.withdrawal) : '—'}</td><td>${full(m.growth)}</td><td>${full(m.closing)}</td><td>${full(m.invested)}</td><td>${full(m.real != null ? m.real : 0)}</td></tr>`;
      }
    }
  }
  $('#ledger').innerHTML = h + '</tbody>';
}
function ledgerCsv() {
  const r = sel(), showAge = ageAt(0) != null;
  const rows = [['Year'].concat(showAge ? ['Age'] : [], ['Phase', 'Monthly SIP or SWP', 'Put in', 'Taken out', 'Returns earned', 'Closing corpus', 'Total put in', "In today's money"])];
  for (const y of r.years) {
    rows.push([y.year].concat(showAge ? [ageAt(y.year)] : [], [y.phase, Math.round(y.phase === 'sip' ? y.sipMonthly : y.phase === 'swp' ? y.wdMonthly : 0), Math.round(y.added), Math.round(y.withdrawn), Math.round(y.growth), Math.round(y.closing), Math.round(y.invested), Math.round(y.real)]));
  }
  return rows.map(r => r.join(',')).join('\n');
}

/* how it's calculated */
function step(n, title, body, formula) {
  return `<li><span class="n">${n}</span><div><h4>${title}</h4>${body}${formula ? `<code class="formula">${formula}</code>` : ''}</div></li>`;
}
function renderLogic() {
  const r = sel(); if (!r) return;
  const p = r.p, M = r.res.months, s = r.res.summary;
  const i = monthlyRateOf(p.annualReturn, p.rateMode), i2 = monthlyRateOf(p.swpReturn, p.rateMode);
  const eff = (Math.pow(1 + i, 12) - 1) * 100;
  let h = `<p class="logic-p">Everything below uses the ${fmtNum(r.rate)}% rate. Pick another rate above the chart to see its numbers.</p><ol class="steps">`;
  h += step(1, 'Turn the yearly return into a monthly rate',
    p.rateMode === 'effective'
      ? `<p>Compounding this monthly rate 12 times gives back exactly ${fmtNum(p.annualReturn)}% a year.</p>`
      : `<p>Simple division. Compounded 12 times this is ${eff.toFixed(2)}% a year, a bit more than the ${fmtNum(p.annualReturn)}% entered. Switch to compound under Calculation conventions for a stricter figure.</p>`,
    p.rateMode === 'effective'
      ? `i = (1 + ${fmtNum(p.annualReturn)} ÷ 100)^(1/12) − 1 = ${(i * 100).toFixed(6)}% a month`
      : `i = ${fmtNum(p.annualReturn)} ÷ 12 ÷ 100 = ${(i * 100).toFixed(6)}% a month`);
  h += step(2, 'Move the balance forward one month at a time',
    p.timing === 'start'
      ? `<p>The SIP goes in and any withdrawal comes out on the first day of the month. Whatever is left then earns one month of return. This is how most SIP calculators work.</p>`
      : `<p>The opening balance earns one month of return first. The SIP goes in and any withdrawal comes out on the last day.</p>`,
    p.timing === 'start' ? 'closing = (opening + SIP − withdrawal) × (1 + i)' : 'closing = opening × (1 + i) + SIP − withdrawal');
  h += step(3, 'Raise the SIP at the start of each new year',
    p.stepUpValue > 0
      ? `<p>Year 1 uses ${full(p.monthlySip)} a month. Every 12 months the SIP goes up${p.stepUpCap > 0 ? `, until it reaches your limit of ${full(p.stepUpCap)}` : ''}. By year ${p.sipYears} you invest ${full(lastSipOf(r))} a month.</p>`
      : `<p>Step-up is off, so the SIP stays at ${full(p.monthlySip)} for all ${plural(p.sipYears, 'year')}.</p>`,
    p.stepUpType === 'pct'
      ? `SIP in year k = ${n0(p.monthlySip)} × (1 + ${fmtNum(p.stepUpValue)}%)^(k − 1)${p.stepUpCap > 0 ? `, never above ${n0(p.stepUpCap)}` : ''}`
      : `SIP in year k = ${n0(p.monthlySip)} + ${n0(p.stepUpValue)} × (k − 1)${p.stepUpCap > 0 ? `, never above ${n0(p.stepUpCap)}` : ''}`);
  let k = 4;
  if (p.swpEnabled) {
    h += step(k++, 'Pay out the withdrawals',
      `<p>Withdrawals start in month ${(p.sipYears + p.swpGapYears) * 12 + 1}${p.swpGapYears > 0 ? `, after ${plural(p.swpGapYears * 12, 'month')} of growth with no SIP` : ''}. In this phase the corpus earns ${fmtNum(p.swpReturn)}% a year, which is ${(i2 * 100).toFixed(6)}% a month. If a withdrawal is bigger than the balance, the balance is paid out and the plan is marked as run out. "Most you can withdraw" comes from trying amounts 34 times, halving the gap each time (binary search), until the largest first-year withdrawal that lasts all ${plural(p.swpYears, 'year')} is found.</p>`,
      `withdrawal in SWP year k = ${n0(p.swpMonthly)} × (1 + ${fmtNum(p.swpIncrease)}%)^(k − 1)`);
  }
  h += step(k, "Convert to today's money",
    `<p>Future rupees buy less. Each balance is divided by inflation compounded over the months that have passed.</p>`,
    `today's value = value ÷ (1 + ${fmtNum(p.inflation)}%)^(month ÷ 12)`);
  h += '</ol>';

  // worked example
  const sipM = p.sipYears * 12, swpFirst = p.swpEnabled ? sipM + p.swpGapYears * 12 + 1 : null;
  const picks = new Set([1, 2, 3, 12, 13, sipM]);
  if (swpFirst) { picks.add(swpFirst); picks.add(swpFirst + 12); }
  if (s.depletedMonth) picks.add(s.depletedMonth);
  const rows = [...picks].filter(m => m >= 1 && m <= M.length).sort((a, b) => a - b).map(m => M[m - 1]).filter(Boolean);
  const what = m => {
    const b = [];
    if (m.month === 1) b.push('First SIP');
    else if (m.phase === 'sip' && (m.month - 1) % 12 === 0) b.push(p.stepUpValue > 0 ? 'SIP steps up' : 'New year');
    if (m.month === sipM && m.month !== 1) b.push('Last SIP');
    if (m.phase === 'swp' && m.month === swpFirst) b.push('First withdrawal');
    else if (m.phase === 'swp' && swpFirst && (m.month - swpFirst) % 12 === 0) b.push('Withdrawal rises');
    if (s.depletedMonth === m.month) b.push('Money runs out');
    return b.join(', ') || (m.phase === 'sip' ? 'Regular SIP' : m.phase === 'swp' ? 'Regular withdrawal' : 'Growing, no cash flow');
  };
  const arith = m => {
    const rate = m.rate != null ? m.rate : (m.phase === 'swp' ? i2 : i);
    const f = (1 + rate).toFixed(7);
    if (p.timing === 'start') {
      let t = n0(m.opening);
      if (m.contribution) t += ' + ' + n0(m.contribution);
      if (m.withdrawal) t += ' − ' + n0(m.withdrawal);
      const wrap = (m.contribution || m.withdrawal) ? `(${t})` : t;
      return `${wrap} × ${f} = ${n0(m.closing)}`;
    }
    let t = `${n0(m.opening)} × ${f}`;
    if (m.contribution) t += ' + ' + n0(m.contribution);
    if (m.withdrawal) t += ' − ' + n0(m.withdrawal);
    return `${t} = ${n0(m.closing)}`;
  };
  h += `<h4 class="logic-h">Worked example, month by month</h4><p class="logic-p">A few key months pulled straight from the engine's output. Figures are rounded to the rupee, so the last digit of the arithmetic can be off by one.</p>`;
  h += `<div class="scroll"><table><thead><tr><th>Month</th><th>What happens</th><th>Opening</th><th>SIP in</th><th>SWP out</th><th>Return earned</th><th>Closing</th><th style="text-align:left">The arithmetic</th></tr></thead><tbody>` +
    rows.map(m => `<tr><td>${m.month}</td><td>${what(m)}</td><td>${n0(m.opening)}</td><td>${m.contribution ? n0(m.contribution) : '—'}</td><td>${m.withdrawal ? n0(m.withdrawal) : '—'}</td><td>${n0(m.growth)}</td><td class="strong">${n0(m.closing)}</td><td class="mono">${arith(m)}</td></tr>`).join('') +
    '</tbody></table></div>';

  // cross-check with closed-form formulas
  const n = sipM, g = Math.pow(1 + i, n), due = p.timing === 'start' ? (1 + i) : 1;
  const af = i === 0 ? n : (g - 1) / i;
  const levelClosed = p.monthlySip * af * due + p.existingCorpus * g;
  const levelEngine = run(Object.assign({}, p, { stepUpValue: 0, stepUpCap: 0, swpEnabled: false })).summary.corpusAtSipEnd;
  const af12 = i === 0 ? 12 : (Math.pow(1 + i, 12) - 1) / i;
  let sipK = p.monthlySip, stepSum = 0;
  for (let y = 1; y <= p.sipYears; y++) {
    if (y > 1) {
      sipK = p.stepUpType === 'amt' ? sipK + p.stepUpValue : sipK * (1 + p.stepUpValue / 100);
      if (p.stepUpCap > 0) sipK = Math.min(sipK, p.stepUpCap);
    }
    stepSum += sipK * af12 * due * Math.pow(1 + i, 12 * (p.sipYears - y));
  }
  const stepClosed = stepSum + p.existingCorpus * g;
  const stepEngine = s.corpusAtSipEnd;
  const verdict = (a, b) => Math.abs(a - b) < 1 ? `<span class="ok">Matches</span>` : `<span class="bad">Differs by ${full(Math.abs(a - b))}</span>`;
  const I = (1 + i).toFixed(7), iS = i.toFixed(7);
  h += `<h4 class="logic-h">Cross-check against the textbook formulas</h4><p class="logic-p">The engine simulates month by month. These closed-form formulas get the same answer in one line, which proves the simulation adds up.</p>`;
  h += `<code class="formula">Flat SIP:
FV = P × [((1 + i)^n − 1) ÷ i]${p.timing === 'start' ? ' × (1 + i)' : ''} + E × (1 + i)^n
   = ${n0(p.monthlySip)} × [(${I}^${n} − 1) ÷ ${iS}]${p.timing === 'start' ? ' × ' + I : ''} + ${n0(p.existingCorpus)} × ${I}^${n}
   = ${full(levelClosed)}

Step-up SIP: treat each year's 12 SIPs as a mini flat SIP, then grow it to the end
FV = Σ over years k [ SIPₖ × ((1 + i)^12 − 1) ÷ i${p.timing === 'start' ? ' × (1 + i)' : ''} × (1 + i)^(12 × (${p.sipYears} − k)) ] + E × (1 + i)^n
   = ${full(stepClosed)}</code>`;
  h += `<div class="scroll" style="margin-top:12px"><table><thead><tr><th>Check</th><th>Formula</th><th>Engine</th><th>Result</th></tr></thead><tbody>
    <tr><td>Flat SIP (step-up off)</td><td>${full(levelClosed)}</td><td>${full(levelEngine)}</td><td>${verdict(levelClosed, levelEngine)}</td></tr>
    <tr><td>Your SIP as entered</td><td>${full(stepClosed)}</td><td>${full(stepEngine)}</td><td>${verdict(stepClosed, stepEngine)}</td></tr>
  </tbody></table></div>`;
  if (customEngine && (Math.abs(levelClosed - levelEngine) >= 1 || Math.abs(stepClosed - stepEngine) >= 1)) {
    h += `<p class="logic-p" style="margin-top:10px">A difference here is expected when your edited engine changes how the SIP phase works.</p>`;
  }
  $('#logic').innerHTML = h;
}

/* =====================================================================
   Engine editor
   ===================================================================== */
const code = $('#code'), gutter = $('#gutter');
let escPressed = false;
function updateGutter() {
  const n = code.value.split('\n').length;
  let s = ''; for (let k = 1; k <= n; k++) s += k + '\n';
  gutter.textContent = s;
  gutter.scrollTop = code.scrollTop;
}
function setCode(src) { code.value = src; updateGutter(); }
function setStatus(msg, cls) { const el = $('#codeStatus'); el.textContent = msg; el.className = 'status' + (cls ? ' ' + cls : ''); }
function renderCodeStatus() {
  const active = customSrc || ORIGINAL_SRC;
  const el = $('#codeStatus');
  if (el.classList.contains('err') || el.classList.contains('ok')) return;
  if (code.value !== active) setStatus('Unapplied changes', '');
  else setStatus(customEngine ? 'Your edited engine is running' : 'The original engine is running', '');
}
function applyCode() {
  const src = code.value;
  if (src.trim() === ORIGINAL_SRC.trim()) { restoreCode(); return; }
  try {
    const fn = compileEngine(src);
    checkResult(fn(paramsFor(state.selectedRate)));
    customEngine = fn; customSrc = src; store.set(KEY_ENGINE, src);
    setStatus('Applied. Every number on the page now comes from your version.', 'ok');
    recalc();
  } catch (e) {
    setStatus('Not applied: ' + (e && e.message ? e.message : e), 'err');
  }
}
function restoreCode() {
  customEngine = null; customSrc = null; store.del(KEY_ENGINE);
  setCode(ORIGINAL_SRC);
  setStatus('Original engine restored.', 'ok');
  recalc();
}
code.addEventListener('input', () => { updateGutter(); setStatus('', ''); renderCodeStatus(); });
code.addEventListener('scroll', () => { gutter.scrollTop = code.scrollTop; });
code.addEventListener('keydown', e => {
  if (e.key === 'Escape') { escPressed = true; return; }
  if (e.key === 'Tab' && !escPressed && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    code.setRangeText('  ', code.selectionStart, code.selectionEnd, 'end');
    updateGutter(); setStatus('', ''); renderCodeStatus();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); applyCode(); }
  escPressed = false;
});
$('#applyCode').addEventListener('click', applyCode);
$('#restoreCode').addEventListener('click', restoreCode);

/* =====================================================================
   Controls
   ===================================================================== */
function pushStateToInputs() {
  $$('#view-plan [data-key]').forEach(el => {
    const k = el.dataset.key;
    if (el.type === 'checkbox') el.checked = !!state[k];
    else el.value = state[k] === '' || state[k] == null ? '' : state[k];
  });
  $$('#view-plan input[type=radio]').forEach(el => { if (el.name in state) el.checked = String(state[el.name]) === el.value; });
}
function bindControls() {
  if (window.MF && $('#planMixType')) {
    MF.typeSwitch($('#planMixType'), { label: 'Chart type', value: mixType, types: MIX_TYPES,
      onChange: v => { mixType = v; MF.setPref('planMix', v); renderMix(); } });
  }
  if (window.MF && $('#planType')) {
    MF.typeSwitch($('#planType'), { label: 'Chart type', value: planType, types: PLAN_TYPES,
      onChange: v => { planType = v; MF.setPref('plan', v); renderChart(); } });
  }
  $$('#view-plan [data-key]').forEach(el => {
    const k = el.dataset.key;
    el.addEventListener('input', () => {
      if (el.type === 'checkbox') state[k] = el.checked;
      else if (k === 'currentAge') state[k] = el.value === '' ? '' : num(el.value, 0, 100);
      else { const v = parseFloat(el.value); state[k] = isFinite(v) ? v : 0; }
      syncOutputs(); schedule();
    });
  });
  $$('#view-plan input[type=radio]').forEach(el => {
    el.addEventListener('change', () => {
      if (!el.checked || !(el.name in state)) return;
      const k = el.name;
      state[k] = el.value;
      if (k === 'stepUpType') {
        if (el.value === 'amt' && state.stepUpValue < 100) state.stepUpValue = 5000;
        if (el.value === 'pct' && state.stepUpValue > 100) state.stepUpValue = 10;
        $('[data-key="stepUpValue"]').value = state.stepUpValue;
      }
      if (k === 'swpReturnMode') {
        if (el.value === 'fixed' && state.swpReturnValue < 4) state.swpReturnValue = 8;
        if (el.value === 'minus' && state.swpReturnValue > 6) state.swpReturnValue = 2;
        $('[data-key="swpReturnValue"]').value = state.swpReturnValue;
      }
      syncOutputs();
      if (k === 'chartMode' || k === 'valueMode') { renderChart(); renderLegend(); save(); }
      else schedule();
    });
  });
  $('#rateChips').addEventListener('click', e => {
    const b = e.target.closest('[data-remove]'); if (!b || state.rates.length <= 1) return;
    state.rates = state.rates.filter(r => r !== +b.dataset.remove);
    $('#rateMsg').textContent = '';
    recalc();
  });
  const addRate = () => {
    const box = $('#newRate'), msg = $('#rateMsg');
    const v = Math.round(parseFloat(box.value) * 100) / 100;
    if (!isFinite(v)) { msg.textContent = 'Type a yearly return, for example 11 or 12.5.'; return; }
    if (v < -10 || v > 40) { msg.textContent = 'Use a rate between −10% and 40%.'; return; }
    if (state.rates.includes(v)) { state.selectedRate = v; box.value = ''; msg.textContent = `${fmtNum(v)}% is already on the list, so it's now selected.`; recalc(); return; }
    if (state.rates.length >= 6) { msg.textContent = 'Six rates is the limit. Remove one to add another.'; return; }
    state.rates = cleanRates(state.rates.concat(v));
    state.selectedRate = v; box.value = ''; msg.textContent = '';
    recalc();
  };
  $('#addRate').addEventListener('click', addRate);
  $('#newRate').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addRate(); } });

  const pickRate = rate => { if (isFinite(rate) && rate !== state.selectedRate) { state.selectedRate = rate; openYear = null; recalc(); } };
  $('#pills').addEventListener('click', e => { const b = e.target.closest('[data-rate]'); if (b) pickRate(+b.dataset.rate); });
  $('#compare').addEventListener('click', e => { const tr = e.target.closest('tr[data-rate]'); if (tr) pickRate(+tr.dataset.rate); });
  $('#compare').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { const tr = e.target.closest('tr[data-rate]'); if (tr) { e.preventDefault(); pickRate(+tr.dataset.rate); } } });
  const toggleYear = tr => { const y = +tr.dataset.year; openYear = openYear === y ? null : y; renderLedger(); const again = $(`#ledger tr[data-year="${y}"]`); if (again) again.focus({ preventScroll: true }); };
  $('#ledger').addEventListener('click', e => { const tr = e.target.closest('tr[data-year]'); if (tr) toggleYear(tr); });
  $('#ledger').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { const tr = e.target.closest('tr[data-year]'); if (tr) { e.preventDefault(); toggleYear(tr); } } });

  $('#view-plan').addEventListener('click', e => {
    const f = e.target.closest('[data-focus]');
    if (f) {
      const sel = `[data-key="${f.dataset.focus}"]`;
      if (window.Shell) window.Shell.openPanel('planRail', sel);
      else { const el = $('#view-plan ' + sel); if (el) el.focus(); }
      return;
    }
    if (e.target.closest('[data-swp-on]')) {
      state.swpEnabled = true; pushStateToInputs(); syncOutputs(); recalc();
      if (window.Shell) window.Shell.openPanel('planRail', '[data-key="swpMonthly"]');
      return;
    }
    const lg = e.target.closest('#planLegend li[data-rate]');
    if (lg) { pickRate(+lg.dataset.rate); return; }
    const g = e.target.closest('[data-goto]');
    if (g) { selectTab(g.dataset.goto); $('#view-plan .tabs').scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    if (e.target.closest('[data-restore]')) restoreCode();
  });

  $$('#view-plan .tab').forEach(t => t.addEventListener('click', () => selectTab(t.dataset.tab)));
  $('#copyCsv').addEventListener('click', async () => {
    const btn = $('#copyCsv'), csv = ledgerCsv();
    let ok = false;
    try { await navigator.clipboard.writeText(csv); ok = true; } catch (e) {
      try { const ta = document.createElement('textarea'); ta.value = csv; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch (e2) { ok = false; }
    }
    btn.textContent = ok ? 'Copied' : 'Copy blocked here';
    setTimeout(() => { btn.textContent = 'Copy as CSV'; }, 1600);
  });
  $('#resetInputs').addEventListener('click', () => {
    const tab = state.tab;
    state = Object.assign({}, DEFAULTS, { rates: DEFAULTS.rates.slice(), tab });
    openYear = null; $('#rateMsg').textContent = '';
    pushStateToInputs(); recalc();
  });
  document.addEventListener('mf:theme', () => { renderChart(); renderMix(); });
}
function selectTab(t) {
  if (!['ledger', 'logic', 'engine'].includes(t)) t = 'ledger';
  state.tab = t;
  $$('#view-plan .tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  $$('#view-plan .tabpanel').forEach(p => { p.hidden = p.dataset.panel !== t; });
  if (t === 'engine') updateGutter();
  save();
}

/* =====================================================================
   Used by the fund explorer: "Use its return in the planner"
   ===================================================================== */
window.Planner = {
  addRate(v) {
    v = Math.round(Number(v) * 100) / 100;
    if (!isFinite(v) || v < -10 || v > 40) return false;
    if (!state.rates.includes(v)) {
      let rates = state.rates.slice();
      if (rates.length >= 6) {
        const far = rates.reduce((b, x) => Math.abs(x - v) > Math.abs(b - v) ? x : b, rates[0]);
        rates = rates.filter(x => x !== far);
      }
      state.rates = cleanRates(rates.concat(v));
    }
    state.selectedRate = v;
    $('#rateMsg').textContent = `Added ${fmtNum(v)}% from the fund explorer.`;
    recalc();
    return true;
  },
  /* For sync.js: the plan's inputs, and whether they're all still the defaults. */
  syncGet() {
    const data = {};
    for (const k of Object.keys(DEFAULTS)) if (!LOCAL_ONLY.includes(k)) data[k] = state[k];
    return { data, blank: Object.keys(data).every(k => JSON.stringify(data[k]) === JSON.stringify(DEFAULTS[k])) };
  },
  /* Take inputs synced from another device, checked the same way as saved ones. */
  syncSet(data) {
    const keep = {};
    LOCAL_ONLY.forEach(k => { keep[k] = state[k]; });
    state = loadState(Object.assign({}, data, keep));
    pushStateToInputs();
    syncOutputs();
    recalc();
  }
};

/* =====================================================================
   Start
   ===================================================================== */
const savedSrc = store.get(KEY_ENGINE);
let startupNote = '';
if (savedSrc && savedSrc.trim() !== ORIGINAL_SRC.trim()) {
  try { const fn = compileEngine(savedSrc); checkResult(fn(paramsFor(state.selectedRate))); customEngine = fn; customSrc = savedSrc; }
  catch (e) { startupNote = 'Your saved edits could not run (' + (e && e.message ? e.message : e) + '), so the original engine is in use.'; }
}
setCode(customSrc || (savedSrc && startupNote ? savedSrc : ORIGINAL_SRC));
pushStateToInputs();
bindControls();
selectTab(state.tab);
recalc();
if (startupNote) setStatus(startupNote, 'err');
})();
