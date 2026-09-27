/* Explore funds: rank the funds in any mix of categories, plus funds you pick,
   by a measure you choose, from AMFI NAVs. Tick funds to compare them. */
(() => {
  'use strict';
  const { $, $$, esc, full2, pct, fmtDate, store, hexA, colors, loadFunds, loadHistory,
    idxOnOrBefore, timeAxis, tooltip, reducedMotion, emit, shortCategory, groupLabel, DAY,
    icon, narrow, pref, setPref, typeSwitch, picker, refreshPickers, searchFunds, combo, loadLinks, amcSite, shortAmc, launchYear } = MF;

  const KEY = 'mf-explore:v1';
  const MAX_CMP = 5;
  const MEASURES = [
    { key: 'rr3med', label: 'Typical 3-year return (rolling median)', col: '3Y rolling', desc: true, about: 'The middle of every 3-year return the fund has had. Steadier than any single date.' },
    { key: 'cons', label: 'How often it beat the category median', col: 'Beat peers', desc: true, share: true, about: 'Share of 3-year periods in which it did better than the typical fund in its category.' },
    { key: 'r1', label: '1-year return', col: '1Y', desc: true, about: 'Change in NAV over the last year.' },
    { key: 'r3', label: '3-year return (CAGR)', col: '3Y', desc: true, about: 'Yearly growth rate over the last 3 years.' },
    { key: 'r5', label: '5-year return (CAGR)', col: '5Y', desc: true, about: 'Yearly growth rate over the last 5 years.' },
    { key: 'r10', label: '10-year return (CAGR)', col: '10Y', desc: true, about: 'Yearly growth rate over the last 10 years.' },
    { key: 'si', label: 'Return since launch (CAGR)', col: 'Since launch', desc: true, about: 'Yearly growth rate since the first NAV.' },
    { key: 'rr3min', label: 'Best worst-case 3-year return', col: 'Worst 3Y', desc: true, about: 'Its lowest 3-year return. Higher means its bad patches were milder.' },
    { key: 'mdd5', label: 'Smallest fall from a peak, 5 years', col: 'Max fall 5Y', desc: true, about: 'The biggest drop from a high in the last 5 years. Closer to zero is calmer.' },
    { key: 'vol3', label: 'Lowest volatility, 3 years', col: 'Volatility 3Y', desc: false, about: 'How much daily NAVs swing. Lower is smoother.' },
    { key: 'sh3', label: 'Sharpe ratio, 3 years', col: 'Sharpe 3Y', desc: true, num: true, about: 'Return above a 6.5% safe rate for each unit of swing.' }
  ];
  const COLS = ['r1', 'r3', 'r5', 'r10', 'si', 'rr3med', 'rr3min', 'cons', 'mdd5', 'vol3', 'sh3'];
  const RANGES = [['1', '1Y'], ['3', '3Y'], ['5', '5Y'], ['10', '10Y'], ['all', 'All']];

  let D = null, inited = false, loading = false, chart = null, detailToken = 0, lastShown = [], rankChart = null, lastHist = null;
  const saved = store.json(KEY, {});
  const state = Object.assign({ cats: [], funds: [], plan: 'Direct', metric: 'rr3med', top: 10, age: 0, amc: '', sel: null, range: '5', cmp: [], sort: { key: 'rank', dir: 1 } }, saved);
  if (!Array.isArray(state.cats)) state.cats = [];
  if (saved.cat && !state.cats.length) state.cats = [saved.cat];       // the one-category version
  delete state.cat; delete state.q;
  if (!['Direct', 'Regular', 'Both'].includes(state.plan)) state.plan = 'Direct';
  if (!state.sort || !['rank', 'name'].concat(COLS).includes(state.sort.key)) state.sort = { key: 'rank', dir: 1 };
  state.sort.dir = state.sort.dir < 0 ? -1 : 1;
  ['funds', 'cmp'].forEach(k => { if (!Array.isArray(state[k])) state[k] = []; state[k] = state[k].map(Number).filter(Number.isFinite); });
  const view = { list: pref('exList', 'table', ['table', 'chart']), fund: pref('exFund', 'area', ['line', 'area', 'years']) };
  const save = () => store.set(KEY, JSON.stringify(state));
  const measure = () => MEASURES.find(m => m.key === state.metric) || MEASURES[0];

  /* ---------- sorting the table: a heading sorts, the same heading again reverses ---------- */
  const SORTS = [['rank', 'Rank'], ['name', 'Fund name']].concat(COLS.map(k => [k, MEASURES.find(m => m.key === k).col]));
  const sortLabel = key => (SORTS.find(x => x[0] === key) || SORTS[0])[1];
  /** Whether the current sort puts low values (or A, or rank 1) first. */
  function ascending() {
    const { key, dir } = state.sort;
    if (key === 'rank' || key === 'name') return dir > 0;
    const mm = MEASURES.find(m => m.key === key);
    return (mm.desc ? dir < 0 : dir > 0);             // the first press shows the best first
  }
  function sortRows(shown) {
    const { key } = state.sort, asc = ascending() ? 1 : -1;
    if (key === 'rank') return asc > 0 ? shown : shown.slice().reverse();
    const list = shown.slice();
    if (key === 'name') return list.sort((a, b) => asc * a.n.localeCompare(b.n));
    const blank = x => x == null || !isFinite(x);
    return list.sort((a, b) => {
      const x = a.m[key], y = b.m[key];
      if (blank(x) || blank(y)) return blank(x) - blank(y);           // blanks stay at the end
      return asc * (x - y) || a.n.localeCompare(b.n);
    });
  }
  function setSort(key) {
    state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: 1 };
    save(); renderTable(); fillSortControl();
  }
  function fillSortControl() {
    const sel = $('#exSort');
    if (!sel) return;
    if (!sel.options.length) sel.innerHTML = SORTS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
    sel.value = state.sort.key;
    const asc = ascending(), key = state.sort.key;
    const words = key === 'rank' ? (asc ? 'Rank 1 first' : 'Last rank first') : key === 'name' ? (asc ? 'A to Z' : 'Z to A') : (asc ? 'Lowest first' : 'Highest first');
    $('#exSortDir').innerHTML = `${icon(asc ? 'up' : 'down')}<span>${words}</span>`;
    $('#exSortDir').setAttribute('aria-label', `${words}. Reverse the order`);
    refreshPickers();
  }

  function fmtCell(key, x) {
    if (x == null || !isFinite(x)) return '—';
    if (key === 'cons') return Math.round(x * 100) + '%';
    if (key === 'sh3') return x.toFixed(2);
    return pct(x, 1);
  }
  const negCls = (key, x) => x != null && x < 0 && key !== 'vol3' ? ' neg' : '';

  /* ---------- funds picked for comparing (shared with compare.js) ---------- */
  window.Picks = {
    get: () => state.cmp.slice(),
    has: code => state.cmp.includes(+code),
    set(list) { state.cmp = [...new Set(list.map(Number))].slice(0, MAX_CMP); save(); emit('mf:picks', { list: state.cmp.slice() }); },
    toggle(code) {
      code = +code;
      if (state.cmp.includes(code)) this.set(state.cmp.filter(c => c !== code));
      else if (state.cmp.length >= MAX_CMP) return false;
      else this.set(state.cmp.concat(code));
      return true;
    },
    max: MAX_CMP
  };

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
    await loadLinks();
    loading = false; inited = true;
    fillControls();
    renderFresh();
    render();
  }

  function renderMissing(e) {
    $('#exFresh').innerHTML = '';
    $('#exFilters').hidden = true;
    $('#exTable').innerHTML = '';
    $('#exCards').innerHTML = '';
    $('#exMore').innerHTML = `<span class="empty-msg"><b>No fund data yet.</b> This page reads the files the nightly job builds from AMFI. If you've just set up the repository, run the “Nightly mutual fund data” workflow once from the Actions tab. Running locally? Build the data with <code>python pipeline/build.py</code>, then serve the site folder. (${esc(e.message)})</span>`;
  }

  /* ---------- controls ---------- */
  let catList = [];
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
    catList = categories();
    state.cats = state.cats.filter(k => catList.some(c => c.k === k));
    state.funds = state.funds.filter(c => D.byCode.has(c));
    state.cmp = state.cmp.filter(c => D.byCode.has(c));
    if (!state.cats.length && !state.funds.length) {
      const pick = catList.find(c => /flexi cap/i.test(c.k)) || catList.find(c => /^equity/i.test(c.g)) || catList[0];
      if (pick) state.cats = [pick.k];
    }
    $('#exMetric').innerHTML = MEASURES.map(m => `<option value="${m.key}" data-desc="${esc(m.about)}"${m.key === state.metric ? ' selected' : ''}>${esc(m.label)}</option>`).join('');
    picker($('#exMetric'), { minWidth: 340 });
    fillAmcs();
    picker($('#exAmc'), { search: true, minWidth: 300, title: 'Fund house' });
    $$('input[name="ex-plan"]').forEach(r => { r.checked = r.value === state.plan; });
    $('#exTop').value = state.top || '';
    $('#exAge').value = state.age || '';
    renderChips();
    if (!$('#exSort').dataset.pick) { $('#exSort').dataset.pick = '1'; picker($('#exSort'), { title: 'Sort by' }); }
    fillSortControl();
    refreshPickers();
    const n = D.funds.filter(f => f.h).length;
    $('#exSub').textContent = `${n.toLocaleString('en-IN')} funds with history · AMFI NAVs of ${fmtDate(D.navDate)}`;
  }

  function fillAmcs() {
    const cats = new Set(state.cats);
    const amcs = [...new Set(D.funds.filter(f => f.m && f.o === 'Growth' && (!cats.size || cats.has(f.k))).map(f => f.a))].sort();
    if (state.amc && !amcs.includes(state.amc)) state.amc = '';
    $('#exAmc').innerHTML = `<option value="" data-label="All fund houses">All fund houses</option>` + amcs.map(a => `<option value="${esc(a)}"${a === state.amc ? ' selected' : ''}>${esc(a)}</option>`).join('');
    $('#exAmc').value = state.amc;
  }

  function renderChips() {
    const x = icon('close');
    $('#exChips').innerHTML = state.cats.map(k => `<span class="xchip"><span>${esc(shortCategory(k))}</span><button type="button" data-rm-cat="${esc(k)}" aria-label="Remove ${esc(shortCategory(k))}">${x}</button></span>`).join('') +
      state.funds.map(c => { const f = D.byCode.get(c); return f ? `<span class="xchip fund"><span>${esc(f.n)}</span><button type="button" data-rm-fund="${c}" aria-label="Remove ${esc(f.n)}">${x}</button></span>` : ''; }).join('');
    $('#exPick').placeholder = state.cats.length || state.funds.length ? 'Add another category or fund' : 'Add a category or a fund';
  }

  function findItems(q) {
    const words = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length || !D) return [];
    const cats = catList.filter(c => !state.cats.includes(c.k) && words.every(w => (shortCategory(c.k) + ' ' + groupLabel(c.g)).toLowerCase().includes(w))).slice(0, 8)
      .map(c => ({ kind: 'cat', c }));
    const funds = searchFunds(D, q, { limit: 12, filter: f => f.m && !state.funds.includes(f.c) }).map(f => ({ kind: 'fund', f }));
    return (cats.length ? [{ head: 'Categories' }].concat(cats) : []).concat(funds.length ? [{ head: 'Funds' }].concat(funds) : []);
  }

  function bind() {
    combo($('#exPick'), $('#exPickList'), {
      find: findItems,
      html: it => it.kind === 'cat'
        ? `<span class="cl-kind">Category</span>${esc(shortCategory(it.c.k))}<span class="cl-meta">${esc(groupLabel(it.c.g))} · ${it.c.n.Direct} direct, ${it.c.n.Regular} regular</span>`
        : `${esc(it.f.n)}<span class="tagp">${esc(it.f.p)}</span><span class="cl-meta">${esc(it.f.a)} · ${esc(shortCategory(it.f.k))}</span>`,
      pick: it => {
        if (it.kind === 'cat') state.cats.push(it.c.k); else state.funds.push(it.f.c);
        state.sel = null; save(); fillAmcs(); refreshPickers(); renderChips(); render();
        $('#exPick').focus();
      }
    });
    $('#exChips').addEventListener('click', e => {
      const a = e.target.closest('[data-rm-cat]'), b = e.target.closest('[data-rm-fund]');
      if (a) state.cats = state.cats.filter(k => k !== a.dataset.rmCat);
      else if (b) state.funds = state.funds.filter(c => c !== +b.dataset.rmFund);
      else return;
      e.preventDefault();
      save(); fillAmcs(); refreshPickers(); renderChips(); render();
      $('#exPick').focus();
    });
    $('#exToggle').addEventListener('click', () => {
      const open = $('#exFilters').classList.toggle('more');
      $('#exToggle').setAttribute('aria-expanded', String(open));
    });
    $('#exMetric').addEventListener('change', e => { state.metric = e.target.value; save(); renderTable(); fillSortControl(); });
    $('#exSort').addEventListener('change', e => { state.sort = { key: e.target.value, dir: 1 }; save(); renderTable(); fillSortControl(); });
    $('#exSortDir').addEventListener('click', () => setSort(state.sort.key));
    $('#exAmc').addEventListener('change', e => { state.amc = e.target.value; save(); renderTable(); });
    $$('input[name="ex-plan"]').forEach(r => r.addEventListener('change', () => { if (r.checked) { state.plan = r.value; save(); renderTable(); } }));
    const setTop = v => { state.top = Math.max(0, Math.min(999, Math.round(+v || 0))); $('#exTop').value = state.top || ''; save(); renderTable(); };
    $('#exTop').addEventListener('change', e => setTop(e.target.value));
    $$('[data-top]').forEach(b => b.addEventListener('click', () => setTop(b.dataset.top)));
    $('#exAge').addEventListener('change', e => { state.age = Math.max(0, Math.min(40, Math.round(+e.target.value || 0))); e.target.value = state.age || ''; save(); renderTable(); });
    $('#exReset').addEventListener('click', () => {
      Object.assign(state, { plan: 'Direct', metric: 'rr3med', top: 10, age: 0, amc: '' });
      save(); fillControls(); render();
    });
    typeSwitch($('#exView'), { label: 'Show the ranking as', value: view.list, types: [['table', 'Table', 'table'], ['chart', 'Chart', 'hbar']],
      onChange: v => { view.list = v; setPref('exList', v); renderTable(); } });

    const pick = code => { state.sel = +code; save(); renderTable(); renderDetail(true); };
    const onCmp = (input, code) => {
      if (!window.Picks.toggle(code)) { input.checked = false; $('#exMore').textContent = `You can compare up to ${MAX_CMP} funds at a time. Untick one first.`; }
    };
    $('#exCards').addEventListener('click', e => {
      const box = e.target.closest('input[data-cmp]');
      if (box) { onCmp(box, box.dataset.cmp); return; }
      if (e.target.closest('label.fc-cmp')) return;
      const li = e.target.closest('li[data-code]'); if (li) pick(li.dataset.code);
    });
    $('#exCards').addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.matches('input')) return;
      const li = e.target.closest('li[data-code]'); if (li) { e.preventDefault(); pick(li.dataset.code); }
    });
    $('#exTable').addEventListener('click', e => {
      const box = e.target.closest('input[data-cmp]');
      if (box) { onCmp(box, box.dataset.cmp); return; }
      if (e.target.closest('td.cmpc')) return;
      const th = e.target.closest('button[data-sort]');
      if (th) { setSort(th.dataset.sort); const again = $(`#exTable button[data-sort="${state.sort.key}"]`); if (again) again.focus(); return; }
      const tr = e.target.closest('tr[data-code]'); if (tr) pick(tr.dataset.code);
    });
    $('#exTable').addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.matches('input, button')) return;
      const tr = e.target.closest('tr[data-code]'); if (tr) { e.preventDefault(); pick(tr.dataset.code); }
    });
    $('#exDetail').addEventListener('click', e => {
      const r = e.target.closest('[data-range]');
      if (r) { state.range = r.dataset.range; save(); renderDetail(false); return; }
      if (e.target.closest('[data-ex-close]')) { state.sel = null; save(); renderTable(); renderDetail(false); return; }
      if (e.target.closest('[data-ex-sip]')) { emit('mf:add-sip', { code: state.sel }); return; }
      const c = e.target.closest('[data-ex-cmp]');
      if (c) {
        if (!window.Picks.has(state.sel) && !window.Picks.toggle(state.sel)) { $('#exChartNote').textContent = `You can compare up to ${MAX_CMP} funds at a time.`; return; }
        location.hash = '#compare'; return;
      }
      const b = e.target.closest('[data-ex-plan]');
      if (b && window.Planner) { window.Planner.addRate(+b.dataset.rate); location.hash = '#plan'; }
    });
    $('#cmpTrayClear').addEventListener('click', () => window.Picks.set([]));
    document.addEventListener('mf:picks', () => { renderTray(); if (inited) syncChecks(); });
    document.addEventListener('mf:theme', () => { if (!inited) return; if (state.sel) renderDetail(false); if (view.list === 'chart') renderRankChart(lastShown); });
  }

  /* ---------- freshness ---------- */
  function renderFresh() {
    const m = D.meta, built = new Date(m.built_at);
    const h = m.amfi_history || {}, mf = m.mfapi || {}, gaps = m.recent_gaps || {};
    let first = `NAVs as of <b>${fmtDate(m.nav_date)}</b>, from AMFI's daily NAV file.`;
    if (h.ok) first += ` Recent days re-checked against AMFI's NAV history: ${(h.points_checked || 0).toLocaleString('en-IN')} values checked, ${(h.points_corrected || 0).toLocaleString('en-IN')} corrected.`;
    first += ` Rebuilt ${built.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}.`;
    const warn = [];
    if (!h.ok) warn.push("AMFI's NAV history report couldn't be reached on the last run, so recent days weren't re-checked.");
    if (mf.pending > 0) warn.push(`Older history for ${mf.pending.toLocaleString('en-IN')} funds is still being downloaded and will complete over the next nightly runs.`);
    if (gaps.count > 0) warn.push(`${gaps.count.toLocaleString('en-IN')} fund${gaps.count === 1 ? ' has' : 's have'} a stretch of more than 5 days without a NAV in the last two months.`);
    const corr = (m.corrections || []).slice(0, 10).map(c => `<li>Scheme ${c.code}, ${fmtDate(c.date)}: ${c.was} replaced with AMFI's ${c.amfi}</li>`).join('');
    $('#exFresh').innerHTML = `<details><summary>${first}</summary><ul>
        <li>Latest NAVs: <a href="${esc(m.sources.latest)}" rel="noopener">${esc(m.sources.latest)}</a> (columns: ${esc((m.navall_columns || []).join('; '))})</li>
        <li>Recent history and corrections: AMFI's NAV history report</li>
        <li>Older history: MFapi.in, a free copy of AMFI's data${mf.latest_date_seen ? `; its newest NAV on the last download was ${fmtDate(mf.latest_date_seen)}` : ''}</li>
        <li>Launch dates: AMFI's scheme data file${m.scheme_data && m.scheme_data.ok === false ? ' (not available on the last run)' : ''}</li>
        <li>Whenever two sources disagree, AMFI's value is kept.</li>
        ${h.errors && h.errors.length ? `<li class="warn">AMFI history errors: ${esc(h.errors.join(' | '))}</li>` : ''}
      </ul>${corr ? `<p>Latest corrections:</p><ul>${corr}</ul>` : ''}</details>` +
      (warn.length ? `<p class="warn">${warn.join(' ')}</p>` : '') + gapDetails(gaps) +
      '<p class="fresh-act"><button type="button" class="linkish" data-open-panel="panelData">Update the fund data</button></p>';
  }

  /** Which funds have holes in their recent NAVs, and which days. */
  const dayMonth = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  function dayList(isos) {
    // 14, 15, 16, 17 and 18 Sep -> "14 to 18 Sep" (weekdays in a row count as a run)
    const runs = [];
    for (const d of isos) {
      const last = runs[runs.length - 1], t = Date.parse(d + 'T00:00:00Z');
      if (last && (t - last.t <= 3 * DAY) && new Date(t).getUTCDay() !== 0) { last.to = d; last.t = t; } else runs.push({ from: d, to: d, t });
    }
    return runs.map(r => r.from === r.to ? dayMonth(r.from) : `${dayMonth(r.from)} to ${dayMonth(r.to)}`).join(', ');
  }
  function gapDetails(gaps) {
    const ex = (gaps.examples || []).filter(g => g && g.code);
    if (!gaps.count || !ex.length) return '';
    const rows = ex.map(g => {
      const f = D.byCode.get(g.code);
      const spans = (g.spans || []).map(s => s.missing && s.missing.length
        ? `missing ${dayList(s.missing)} <span class="muted">(other funds have NAVs for ${s.missing.length === 1 ? 'that day' : 'those days'})</span>`
        : `no NAV between ${dayMonth(s.after)} and ${dayMonth(s.before)} <span class="muted">(no fund has one for those days either: holidays, or AMFI hasn't published them)</span>`);
      return `<li><b>${esc(f ? f.n : 'Scheme ' + g.code)}</b> <span class="muted">· scheme ${g.code}${f ? ' · ' + esc(shortAmc(f.a)) : ''}</span><br>${spans.length ? spans.join('; ') : `a gap of ${g.largest_gap_days} days`}</li>`;
    }).join('');
    const more = gaps.count > ex.length ? `<p class="muted">And ${(gaps.count - ex.length).toLocaleString('en-IN')} more.</p>` : '';
    return `<details class="gaps"><summary>Which funds, and which days</summary><ul>${rows}</ul>${more}
      <p class="muted">A figure that needs a missing NAV is left blank rather than guessed. Each night the last 7 days are checked again against AMFI's NAV history.</p></details>`;
  }

  /* ---------- the ranking ---------- */
  // Direct and Regular plans of one scheme share a name once the plan words are taken out.
  const pairKey = f => f.a + '|' + f.n.toLowerCase().replace(/\b(direct|regular|plan|growth|option|dir|reg)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  function ranked() {
    const m = measure(), k = m.key;
    const cats = new Set(state.cats), picked = new Set(state.funds);
    const plans = state.plan === 'Both' ? ['Direct', 'Regular'] : [state.plan];
    const minAge = state.age * 365 - 5;
    const pool = D.funds.filter(f => f.m && (picked.has(f.c) ||
      (f.o === 'Growth' && cats.has(f.k) && plans.includes(f.p) && (!state.amc || f.a === state.amc) && (f.m.age || 0) >= minAge)));
    const withValue = pool.filter(f => f.m[k] != null && isFinite(f.m[k]));
    withValue.sort((a, b) => (m.desc ? b.m[k] - a.m[k] : a.m[k] - b.m[k]) || a.n.localeCompare(b.n));
    return { pool, list: withValue, missing: pool.length - withValue.length };
  }
  function directOf(f) {
    if (f.p !== 'Regular') return null;
    const key = pairKey(f);
    return D.funds.find(x => x.p === 'Direct' && x.o === f.o && x.k === f.k && x.m && pairKey(x) === key) || null;
  }
  function gapNote(f) {
    const d = directOf(f);
    if (!d || d.m.rr3med == null || f.m.rr3med == null) return '';
    const gap = d.m.rr3med - f.m.rr3med;
    if (!(gap > 0.0005)) return '';
    return `<span class="gapnote" title="The Regular plan pays a distributor's commission out of the fund, which its Direct plan doesn't.">${pct(gap, 1)} a year behind its Direct plan (commission)</span>`;
  }
  const subLine = f => [shortCategory(f.k), f.p, launchYear(f) ? `launched ${launchYear(f)}` : '', state.funds.includes(f.c) ? 'you picked it' : ''].filter(Boolean).join(' · ');

  function render() { renderTable(); renderDetail(false); renderTray(); }

  function renderTable() {
    if (!D) return;
    const m = measure();
    const { pool, list, missing } = ranked();
    const shown = state.top ? list.slice(0, state.top) : list;
    lastShown = shown;
    const names = new Map();
    shown.forEach(f => names.set(f.n, (names.get(f.n) || 0) + 1));
    const nm = f => names.get(f.n) > 1 && state.plan !== 'Both' ? `${f.n} (${f.c})` : f.n;
    const cb = f => `<input type="checkbox" data-cmp="${f.c}" aria-label="Compare ${esc(f.n)}"${window.Picks.has(f.c) ? ' checked' : ''}>`;
    const rankOf = new Map(shown.map((f, i) => [f.c, i + 1]));
    const rows = sortRows(shown), asc = ascending();
    const th = (key, label, cls, title) => {
      const on = state.sort.key === key;
      return `<th class="${cls}"${on ? ` aria-sort="${asc ? 'ascending' : 'descending'}"` : ''}><button type="button" class="th-sort${on ? ' on' : ''}" data-sort="${key}" title="${esc(title)}">${label}<span class="arr" aria-hidden="true">${on ? (asc ? '▲' : '▼') : ''}</span></button></th>`;
    };
    const head = `<thead><tr><th class="cmpc"><span class="sr-only">Compare</span></th>${th('rank', '#', 'rk', `Sort by rank (${m.col})`)}${th('name', 'Fund', 'fundh', 'Sort by fund name, A to Z or Z to A')}${COLS.map(c => {
      const mm = MEASURES.find(x => x.key === c);
      return th(c, esc(mm.col), c === m.key ? 'is-rank' : '', `Sort by ${mm.label.toLowerCase()}`);
    }).join('')}</tr></thead>`;
    const body = rows.map(f => `<tr data-code="${f.c}" tabindex="0" class="${f.c === state.sel ? 'is-sel' : ''}">
        <td class="cmpc">${cb(f)}</td>
        <td class="rk">${rankOf.get(f.c)}</td>
        <td class="fund"><span class="fn">${esc(nm(f))}</span><span class="fa">${esc(subLine(f))} · ${esc(shortAmc(f.a))}</span>${state.plan === 'Both' ? gapNote(f) : ''}</td>
        ${COLS.map(c => `<td class="${c === m.key ? 'is-rank' : ''}${negCls(c, f.m[c])}">${fmtCell(c, f.m[c])}</td>`).join('')}
      </tr>`).join('');
    const none = !pool.length ? 'Add a category or a fund above to see a ranking.' : `No funds match these filters.`;
    $('#exTable').innerHTML = head + '<tbody>' + (body || `<tr><td colspan="${COLS.length + 3}" class="loading">${none}</td></tr>`) + '</tbody>';
    const sk = COLS.includes(state.sort.key) && state.sort.key !== m.key ? state.sort.key : null;
    const others = (sk ? [sk] : []).concat(['rr3med', 'cons', 'mdd5', 'r5', 'r3'].filter(k => k !== m.key && k !== sk)).slice(0, 2);
    $('#exCards').innerHTML = rows.map(f => {
      const x = f.m[m.key];
      return `<li class="fcard${f.c === state.sel ? ' is-sel' : ''}" data-code="${f.c}" tabindex="0" role="button" aria-pressed="${f.c === state.sel}">
        <span class="fc-top"><span class="fc-rk">${rankOf.get(f.c)}</span>
          <span class="fc-main"><span class="fn">${esc(nm(f))}</span><span class="fa">${esc(subLine(f))}</span></span>
          <label class="fc-cmp">${cb(f)}Compare</label></span>
        <span class="fc-nums"><span class="key"><b class="${negCls(m.key, x)}">${fmtCell(m.key, x)}</b><small>${esc(m.col)}</small></span>
          ${others.map(k => `<span><b class="${negCls(k, f.m[k])}">${fmtCell(k, f.m[k])}</b><small>${esc(MEASURES.find(z => z.key === k).col)}</small></span>`).join('')}</span>
        ${state.plan === 'Both' ? gapNote(f) : ''}
      </li>`;
    }).join('') || `<li class="fcard"><span class="fc-main">${none}</span></li>`;
    const nCats = state.cats.length, nFunds = state.funds.length;
    const what = [nCats ? `${nCats} categor${nCats === 1 ? 'y' : 'ies'}` : '', nFunds ? `${nFunds} fund${nFunds === 1 ? '' : 's'} you picked` : ''].filter(Boolean).join(' plus ');
    $('#exCount').innerHTML = pool.length ? `Ranking <b>${list.length}</b> fund${list.length === 1 ? '' : 's'} from ${esc(what)}${state.plan === 'Both' ? ', Direct and Regular' : `, ${state.plan} plans`}. ${state.top && list.length > state.top ? `Showing the top ${state.top}.` : ''}${nCats > 1 || nFunds ? ' Each fund is compared only with its own category.' : ''}` : '';
    $('#exToggleSum').textContent = [state.plan === 'Both' ? 'Direct and Regular' : state.plan, state.top ? `top ${state.top}` : 'all', state.age ? `${state.age}+ years` : '', `by ${m.col}`, state.amc ? shortAmc(state.amc) : ''].filter(Boolean).join(' · ');
    const asChart = view.list === 'chart' && shown.length > 0;
    $('#exTableWrap').hidden = asChart;
    $('#exCards').hidden = asChart;
    $('#exRankWrap').hidden = !asChart;
    if (asChart) renderRankChart(shown); else if (rankChart) { rankChart.destroy(); rankChart = null; }
    const bits = [];
    if (pool.length) bits.push(`Ranked by ${m.label.toLowerCase()}, ${m.desc ? 'highest' : 'lowest'} first${state.top && list.length > state.top ? `; the top ${state.top} are shown` : ''}.`);
    if (pool.length && !asChart && state.sort.key !== 'rank') bits.push(`Sorted by ${state.sort.key === 'name' ? 'fund name' : sortLabel(state.sort.key)}, ${state.sort.key === 'name' ? (asc ? 'A to Z' : 'Z to A') : asc ? 'lowest first' : 'highest first'}; # is each fund's rank.`);
    if (missing && pool.length) bits.push(`${missing} more ${missing === 1 ? 'fund has' : 'funds have'} too little history for this measure.`);
    if (pool.length) bits.push(asChart ? 'Select a bar to see that fund.' : narrow() ? 'Tap a fund to see its chart.' : 'Select a column heading to sort by it, and again to reverse. Select a fund to see its chart.');
    $('#exMore').textContent = bits.join(' ');
  }
  function syncChecks() { $$('#view-explore input[data-cmp]').forEach(x => { x.checked = window.Picks.has(x.dataset.cmp); }); }

  function renderTray() {
    const list = window.Picks.get();
    $('#cmpTray').hidden = !list.length;
    if (!list.length) return;
    $('#cmpTrayCount').textContent = `${list.length} fund${list.length === 1 ? '' : 's'} picked to compare`;
    if (!D) { $('#cmpTrayNames').textContent = ''; return; }
    $('#cmpTrayNames').textContent = list.map(c => { const f = D.byCode.get(c); return f ? f.n.replace(/\s*-\s*(direct|regular).*$/i, '') : c; }).join(', ');
  }

  function renderRankChart(shown) {
    if (typeof window.Chart === 'undefined') { $('#exRankBox').innerHTML = '<div class="chart-fallback">The chart library did not load. The table still has every figure.</div>'; return; }
    if (!$('#exRank')) $('#exRankBox').innerHTML = '<canvas id="exRank" role="img" aria-label="Funds ranked, as bars"></canvas>';
    const c = colors(), m = measure(), k = m.key;
    const pctScale = !m.num;
    const vals = shown.map(f => { const x = f.m[k]; return x == null ? null : pctScale ? x * 100 : x; });
    const labels = shown.map((f, i) => `${i + 1}. ${f.n.length > 34 && narrow() ? f.n.slice(0, 32) + '…' : f.n}`);
    const box = $('#exRankBox');
    box.style.height = (shown.length * (narrow() ? 38 : 34) + 40) + 'px';
    if (rankChart) rankChart.destroy();
    const fmt = v => k === 'cons' ? Math.round(v) + '%' : k === 'sh3' ? v.toFixed(2) : (v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '%';
    rankChart = new window.Chart($('#exRank'), {
      type: 'bar',
      data: { labels, datasets: [{ label: m.col, data: vals,
        backgroundColor: shown.map((f, i) => f.c === state.sel ? c.c1 : (vals[i] < 0 && k !== 'mdd5' ? c.wd : hexA(c.c1, .78))),
        hoverBackgroundColor: c.c1, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 22, categoryPercentage: .8, barPercentage: .9 }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { right: 52, left: 2 } },
        // Redraw after Chart.js has finished handling this click on the chart being replaced.
        onClick: (_e, els) => { if (els.length) { const code = shown[els[0].index].c; setTimeout(() => { state.sel = code; save(); renderTable(); renderDetail(true); }, 0); } },
        onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        plugins: {
          legend: { display: false },
          barValues: { format: fmt, color: c['ink-2'] },
          tooltip: Object.assign(tooltip(c), { callbacks: { title: it => shown[it[0].dataIndex].n, label: ctx => ` ${m.col}: ${fmt(ctx.parsed.x)}` } })
        },
        scales: {
          x: { grid: { color: c.rule }, border: { display: false }, ticks: { color: c.muted, maxTicksLimit: 5, font: { family: 'IBM Plex Sans', size: 11.5 }, callback: v => fmt(v) } },
          y: { grid: { display: false }, border: { color: c['rule-2'] }, ticks: { color: c['ink-2'], font: { family: 'IBM Plex Sans', size: narrow() ? 11.5 : 12.5 }, autoSkip: false } }
        }
      }
    });
  }

  /* ---------- one fund ---------- */
  function launchedText(f, m) {
    if (f.l && f.L) return `Launched <b>${fmtDate(f.L)}</b>; this plan since <b>${fmtDate(f.l)}</b>`;
    if (f.l) return `Launched <b>${fmtDate(f.l)}</b>`;
    if (m.inc) return `First NAV <b>${fmtDate(m.inc)}</b>`;
    if (m.pre2006) return 'Launched before <b>Apr 2006</b>, when AMFI history starts';
    return 'Launch date not known';
  }
  async function renderDetail(scroll) {
    const box = $('#exDetail');
    const f = D && state.sel != null ? D.byCode.get(state.sel) : null;
    if (!f || !f.m) { box.hidden = true; if (chart) { chart.destroy(); chart = null; } return; }
    box.hidden = false;
    const m = f.m;
    const rate = m.r5 != null ? m.r5 : m.r3 != null ? m.r3 : m.rr3med;
    const rateLabel = m.r5 != null ? '5-year' : m.r3 != null ? '3-year' : 'typical 3-year';
    const ratePct = rate != null ? Math.round(rate * 1000) / 10 : null;
    const site = amcSite(f.a);
    const inCmp = window.Picks.has(f.c);
    box.innerHTML = `
      <div class="dt-head">
        <div><h3>${esc(f.n)}</h3><p class="dt-sub">${esc(f.a)}. ${esc(shortCategory(f.k))}, ${esc(f.p)} plan, ${esc(f.o)} option.</p></div>
        <button type="button" class="btn-icon" data-ex-close aria-label="Close">${icon('close')}</button>
      </div>
      <div class="dt-facts">
        <span>Latest NAV <b>₹${f.v}</b> on ${fmtDate(f.d)}</span>
        <span>${launchedText(f, m)}</span>
        <span>Scheme code <b>${f.c}</b></span>
        ${f.i ? `<span>ISIN <b>${esc(f.i)}</b></span>` : ''}
      </div>
      ${site ? `<div class="dt-links"><a class="login" href="${esc(site.url)}" target="_blank" rel="noopener">Log in at ${esc(shortAmc(site.name))}${icon('out')}</a></div>` : ''}
      <div class="chart-bar">
        <div class="row wrap">
          <div class="seg" role="group" aria-label="Chart period">${RANGES.map(([v, l]) => `<button type="button" class="seg-btn" data-range="${v}" aria-pressed="${state.range === v}">${l}</button>`).join('')}</div>
          <div id="exFundType"></div>
        </div>
        <span class="dt-note" id="exChartNote"></span>
      </div>
      <div class="chart-box sm"><canvas id="exChart" role="img" aria-label="Growth of ₹10,000 in this fund"></canvas></div>
      <div class="dt-actions">
        <button type="button" class="btn sm" data-ex-sip>${icon('plus')}Add a SIP in this fund</button>
        <button type="button" class="btn quiet sm" data-ex-cmp>${icon('compare')}${inCmp ? 'Open the comparison' : 'Compare it'}</button>
        ${ratePct != null ? `<button type="button" class="btn quiet sm" data-ex-plan data-rate="${ratePct}">Use its ${rateLabel} return (${ratePct}%) in Plan</button>` : ''}
      </div>`;
    typeSwitch($('#exFundType'), { label: 'Chart type', value: view.fund,
      types: [['line', 'Line', 'line'], ['area', 'Area', 'area'], ['years', 'Each year', 'bar']],
      onChange: v => { view.fund = v; setPref('exFund', v); if (lastHist && lastHist.f === f) drawChart(f, lastHist.hist); } });
    if (scroll) box.scrollIntoView({ block: narrow() ? 'start' : 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });

    const token = ++detailToken;
    let hist;
    try { hist = await loadHistory(f.c); } catch (e) { $('#exChartNote').textContent = e.message; return; }
    if (token !== detailToken) return;
    lastHist = { f, hist };
    drawChart(f, hist);
  }

  /** Calendar-year returns from the NAV history: [{year, r, partial}] */
  function yearly(hist) {
    const out = [], n = hist.t.length;
    if (!n) return out;
    const y0 = new Date(hist.t[0]).getUTCFullYear(), y1 = new Date(hist.t[n - 1]).getUTCFullYear();
    for (let y = y0; y <= y1; y++) {
      const endPrev = Date.UTC(y - 1, 11, 31), endThis = Date.UTC(y, 11, 31);
      let a = idxOnOrBefore(hist.t, endPrev), partial = false;
      if (a < 0) { a = 0; partial = true; }
      const b = idxOnOrBefore(hist.t, endThis);
      if (b <= a) continue;
      if (endThis > hist.t[n - 1]) partial = true;
      out.push({ year: y, r: hist.v[b] / hist.v[a] - 1, partial });
    }
    return out;
  }

  function drawChart(f, hist) {
    if (view.fund === 'years') { drawYears(f, hist); return; }
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
      data: { datasets: [{ label: 'Value of ₹10,000', data: pts, borderColor: color, backgroundColor: hexA(color, .1), fill: view.fund === 'area' ? 'origin' : false, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0 }] },
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

  /** Each calendar year's return as a bar: blue for a gain, crimson for a loss. */
  function drawYears(f, hist) {
    const c = colors(), ys = yearly(hist);
    const shownYears = state.range === 'all' ? ys : ys.slice(-Math.max(+state.range + 1, 2));
    const up = ys.filter(y => !y.partial);
    const best = up.reduce((b, y) => (!b || y.r > b.r ? y : b), null), worst = up.reduce((b, y) => (!b || y.r < b.r ? y : b), null);
    $('#exChartNote').textContent = shownYears.length
      ? `Return in each calendar year${best ? `. Best full year ${best.year}, ${pct(best.r, 1)}; worst ${worst.year}, ${pct(worst.r, 1)}` : ''}. The first and latest years are part-years.`
      : 'Not enough history for yearly returns yet.';
    if (typeof window.Chart === 'undefined' || !shownYears.length) return;
    if (chart) chart.destroy();
    const fmt = v => (v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '%';
    chart = new window.Chart($('#exChart'), {
      type: 'bar',
      data: { labels: shownYears.map(y => y.partial ? y.year + '*' : String(y.year)), datasets: [{ label: 'Return that year', data: shownYears.map(y => y.r * 100),
        backgroundColor: shownYears.map(y => hexA(y.r < 0 ? c.wd : c.c1, y.partial ? .45 : .9)), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 24 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: { top: 18 } },
        plugins: {
          legend: { display: false },
          barValues: shownYears.length <= 14 ? { format: fmt, color: c['ink-2'] } : {},
          tooltip: Object.assign(tooltip(c), { callbacks: { title: it => { const y = shownYears[it[0].dataIndex]; return y.year + (y.partial ? ' (part of the year)' : ''); }, label: ctx => ` ${fmt(ctx.parsed.y)}` } })
        },
        scales: {
          x: { grid: { display: false }, border: { color: c['rule-2'] }, ticks: { color: c.muted, maxRotation: 0, autoSkipPadding: 10, font: { family: 'IBM Plex Sans', size: 11.5 } } },
          y: { grid: { color: c.rule }, border: { display: false }, ticks: { color: c.muted, maxTicksLimit: 6, font: { family: 'IBM Plex Sans', size: 11.5 }, callback: v => fmt(v) } }
        }
      }
    });
  }

  // New fund data while the page is open: rank again with it.
  document.addEventListener('mf:data', async () => {
    if (!inited) return;
    try { D = await loadFunds(); } catch (e) { return; }
    fillControls(); renderFresh(); render();
  });

  bind();
  renderTray();
  document.addEventListener('mf:view', e => { if (e.detail.view === 'explore') init(); });
})();
