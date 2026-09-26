/* Shared helpers for the Explore funds and My portfolio pages. */
window.MF = (() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const DAY = 864e5;
  const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
  const INR2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const DATE_FMT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const MONTH_FMT = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- numbers ---------- */
  const full = v => (v < 0 ? '−₹' : '₹') + INR.format(Math.round(Math.abs(v)));
  const full2 = v => (v < 0 ? '−₹' : '₹') + INR2.format(Math.abs(v));
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
  const pct = (x, d = 1) => (x == null || !isFinite(x)) ? '—' : (x < 0 ? '−' : '') + Math.abs(x * 100).toFixed(d) + '%';
  const units = u => (Math.round(u * 1000) / 1000).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

  /* ---------- dates (all UTC midnight, in ms) ---------- */
  const isoToMs = s => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const msToIso = ms => new Date(ms).toISOString().slice(0, 10);
  const fmtDate = x => DATE_FMT.format(new Date(typeof x === 'string' ? isoToMs(x) : x));
  const fmtMonth = x => MONTH_FMT.format(new Date(typeof x === 'string' ? isoToMs(x) : x));
  const todayMs = () => { const n = new Date(); return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()); };

  /* ---------- storage ---------- */
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { window.localStorage.removeItem(k); } catch (e) { /* unavailable */ } },
    json(k, fallback) { try { const v = JSON.parse(window.localStorage.getItem(k)); return v == null ? fallback : v; } catch (e) { return fallback; } }
  };

  /* ---------- theme ---------- */
  const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function hexA(hex, a) {
    let h = String(hex).replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    if (!isFinite(n)) return hex;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function colors() {
    const o = {};
    ['ink', 'ink-2', 'muted', 'rule', 'rule-2', 'sheet', 'stamp', 'wd', 'ok', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'].forEach(k => { o[k] = cssVar('--' + k); });
    return o;
  }
  function currentTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /* ---------- data ---------- */
  const jsonCache = new Map();
  function getJSON(url) {
    if (!jsonCache.has(url)) {
      jsonCache.set(url, fetch(url, { cache: 'no-cache' })
        .then(r => { if (!r.ok) throw new Error(`${url} answered HTTP ${r.status}`); return r.json(); })
        .catch(e => { jsonCache.delete(url); throw e; }));
    }
    return jsonCache.get(url);
  }

  let fundsPromise = null;
  function loadFunds() {
    if (!fundsPromise) {
      fundsPromise = Promise.all([getJSON('data/funds.json'), getJSON('data/meta.json')]).then(([f, meta]) => {
        const byCode = new Map(), byIsin = new Map();
        for (const x of f.funds) {
          byCode.set(x.c, x);
          if (x.i) byIsin.set(x.i, x);
          if (x.i2) byIsin.set(x.i2, x);
        }
        return { funds: f.funds, byCode, byIsin, meta, navDate: f.nav_date };
      }).catch(e => { fundsPromise = null; throw e; });
    }
    return fundsPromise;
  }

  function decodeNav(obj) {
    const n = obj.t.length, t = new Float64Array(n);
    let o = isoToMs(obj.s);
    for (let i = 0; i < n; i++) { o += obj.t[i] * DAY; t[i] = o; }
    return { t, v: Float64Array.from(obj.v), source: 'site' };
  }

  const histCache = new Map();
  /** NAV history for a scheme: this site's own data first, MFapi.in if the site doesn't track it. */
  function loadHistory(code) {
    code = Number(code);
    if (!histCache.has(code)) {
      histCache.set(code, (async () => {
        try {
          return decodeNav(await getJSON(`data/nav/${code}.json`));
        } catch (siteErr) {
          let r;
          try { r = await fetch(`https://api.mfapi.in/mf/${code}`); }
          catch (e) { throw new Error(`No NAV history for scheme ${code}: this site doesn't track it and MFapi.in couldn't be reached`); }
          if (!r.ok) throw new Error(`No NAV history for scheme ${code}`);
          const j = await r.json();
          const rows = (j.data || []).map(x => {
            const [d, m, y] = String(x.date).split('-').map(Number);
            return [Date.UTC(y, m - 1, d), parseFloat(x.nav)];
          }).filter(x => isFinite(x[0]) && x[1] > 0).sort((a, b) => a[0] - b[0]);
          if (!rows.length) throw new Error(`No NAV history for scheme ${code}`);
          return { t: Float64Array.from(rows.map(x => x[0])), v: Float64Array.from(rows.map(x => x[1])), source: 'mfapi' };
        }
      })().catch(e => { histCache.delete(code); throw e; }));
    }
    return histCache.get(code);
  }

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
    const dnpv = r => flows.reduce((s, f, i) => s - yr[i] * f.v / Math.pow(1 + r, yr[i] + 1), 0);
    let r = 0.1;
    for (let i = 0; i < 60; i++) {
      const f = npv(r), df = dnpv(r);
      if (!isFinite(f) || !isFinite(df) || df === 0) break;
      const next = r - f / df;
      if (!isFinite(next) || next <= -0.9999) break;
      if (Math.abs(next - r) < 1e-10) return next;
      r = next;
    }
    let lo = -0.9999, hi = 100, flo = npv(lo), fhi = npv(hi);
    if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
    for (let i = 0; i < 300; i++) {
      const mid = (lo + hi) / 2, fm = npv(mid);
      if (Math.abs(fm) < 1e-7 || hi - lo < 1e-12) return mid;
      if (flo * fm < 0) { hi = mid; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  }

  /* ---------- charts ---------- */
  function timeAxis(c, spanMs) {
    const years = spanMs / (365 * DAY);
    return {
      type: 'linear',
      grid: { display: false },
      border: { color: c['rule-2'] },
      ticks: {
        color: c.muted, maxRotation: 0, autoSkipPadding: 18, maxTicksLimit: 8,
        font: { family: 'IBM Plex Sans', size: 11.5 },
        callback: v => years > 4 ? String(new Date(v).getUTCFullYear()) : fmtMonth(v)
      }
    };
  }
  function tooltip(c) {
    return {
      backgroundColor: c.sheet, titleColor: c.ink, bodyColor: c['ink-2'], borderColor: c['rule-2'], borderWidth: 1,
      padding: 10, boxPadding: 4, usePointStyle: true,
      titleFont: { family: 'IBM Plex Sans', weight: '600', size: 13 }, bodyFont: { family: 'IBM Plex Sans', size: 12.5 }
    };
  }
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const emit = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail }));
  const shortCategory = k => { const i = String(k).indexOf(' - '); return i >= 0 ? k.slice(i + 3) : k; };
  const groupLabel = g => String(g).replace(/\s+Schemes?$/i, '');
  const icon = (name, cls) => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
  const narrow = () => window.matchMedia && window.matchMedia('(max-width: 760px)').matches;

  /* ---------- chart choices, remembered per chart ---------- */
  const PREFS = 'mf-charts:v1';
  const pref = (key, fallback, allowed) => { const v = store.json(PREFS, {})[key]; return allowed && !allowed.includes(v) ? fallback : (v || fallback); };
  const setPref = (key, v) => { const all = store.json(PREFS, {}); all[key] = v; store.set(PREFS, JSON.stringify(all)); };

  /** A row of radio buttons with icons, e.g. Line / Area / Bars. Native radios, so arrow keys work. */
  let switchN = 0;
  function typeSwitch(el, { label, types, value, onChange }) {
    const name = 'ctype-' + (++switchN);
    el.className = 'seg ctype';
    el.setAttribute('role', 'radiogroup');
    el.setAttribute('aria-label', label);
    el.innerHTML = types.map(([v, text, ic]) =>
      `<label><input type="radio" name="${name}" value="${esc(v)}"${v === value ? ' checked' : ''}><span>${ic ? icon(ic) : ''}<span class="t">${esc(text)}</span></span></label>`).join('');
    el.addEventListener('change', e => { if (e.target.name === name && e.target.checked) onChange(e.target.value); });
    return { set(v) { const r = el.querySelector(`input[value="${CSS.escape(v)}"]`); if (r) r.checked = true; } };
  }

  /* ---------- pickers: a friendlier face for a <select> ----------
     The <select> stays in the page, hidden, and keeps its value and change
     events, so page code reads it as before. Wide screens get a dropdown,
     phones a bottom sheet; long lists get a search box. Options may carry
     data-desc (a line under the label) and data-sub (shown on the button). */
  const pickers = new Set();
  let openPicker = null, pickN = 0;

  function picker(select, opts = {}) {
    if (select._picker) return select._picker;
    const id = 'pk' + (++pickN);
    const field = select.closest('.field');
    const lbl = field && field.querySelector('.lbl');
    if (lbl && !lbl.id) lbl.id = id + '-lbl';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pick-btn';
    btn.id = id + '-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    if (lbl) btn.setAttribute('aria-labelledby', `${lbl.id} ${btn.id}`);
    select.classList.add('pick-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.insertAdjacentElement('afterend', btn);
    const box = select.closest('.box');
    if (box) box.classList.add('has-picker');

    const p = { select, btn, refresh, open, close, title: opts.title || (lbl ? lbl.textContent.trim() : ''), search: opts.search };
    function refresh() {
      const o = select.selectedOptions[0];
      const main = o ? (o.dataset.label || o.textContent) : '';
      const sub = o && o.dataset.sub ? `<small>${esc(o.dataset.sub)}</small>` : '';
      btn.innerHTML = `<span class="pick-val"><span class="pick-main">${esc(main)}</span>${sub}</span>${icon('chev', 'chev')}`;
    }
    function items() {
      const out = [];
      for (const node of select.children) {
        if (node.tagName === 'OPTGROUP') {
          out.push({ group: node.label });
          for (const o of node.children) out.push({ o, group: node.label });
        } else out.push({ o: node });
      }
      return out;
    }
    let panel = null, list = null, q = null, active = -1, shown = [];
    function build() {
      panel = document.createElement('div');
      panel.className = 'pick-panel';
      panel.innerHTML = `<div class="pick-head"><b>${esc(p.title)}</b><button type="button" class="btn-icon" data-pick-close aria-label="Close">${icon('close')}</button></div>` +
        (p.search ? `<div class="pick-search">${icon('search')}<input type="search" placeholder="Search" aria-label="Search ${esc(p.title.toLowerCase())}" autocomplete="off" spellcheck="false"></div>` : '') +
        `<ul role="listbox" id="${id}-list" tabindex="-1" aria-label="${esc(p.title)}"></ul>`;
      list = panel.querySelector('ul');
      q = panel.querySelector('input');
      document.body.appendChild(panel);
      panel.addEventListener('mousedown', e => { if (e.target.closest('li[role=option]')) e.preventDefault(); });
      panel.addEventListener('click', e => {
        if (e.target.closest('[data-pick-close]')) { close(true); return; }
        const li = e.target.closest('li[role=option]');
        if (li) choose(li.dataset.value);
      });
      panel.addEventListener('pointermove', e => { const li = e.target.closest('li[role=option]'); if (li) setActive(+li.dataset.i, false); });
      panel.addEventListener('keydown', onKey);
      if (q) q.addEventListener('input', () => { fill(); setActive(shown.length ? 0 : -1, true); });
    }
    function fill() {
      const words = q ? q.value.trim().toLowerCase().split(/\s+/).filter(Boolean) : [];
      const all = items();
      shown = [];
      let html = '', lastGroup = null;
      for (const it of all) {
        if (!it.o) continue;
        const o = it.o, label = o.dataset.label || o.textContent, desc = o.dataset.desc || '';
        if (words.length && !words.every(w => (label + ' ' + desc + ' ' + (it.group || '')).toLowerCase().includes(w))) continue;
        if (it.group && it.group !== lastGroup) { html += `<li role="presentation" class="pick-group">${esc(it.group)}</li>`; lastGroup = it.group; }
        const i = shown.length;
        shown.push(o);
        const sel = o.value === select.value;
        html += `<li role="option" id="${id}-o${i}" data-i="${i}" data-value="${esc(o.value)}" aria-selected="${sel}">` +
          `<span class="pick-opt"><span>${esc(label)}</span>${desc ? `<small>${esc(desc)}</small>` : ''}</span>${sel ? icon('check', 'tick') : ''}</li>`;
      }
      list.innerHTML = html || '<li role="presentation" class="pick-none">Nothing matches.</li>';
    }
    function setActive(i, scroll) {
      active = i;
      list.querySelectorAll('li.is-active').forEach(li => li.classList.remove('is-active'));
      const li = i >= 0 ? list.querySelector(`li[data-i="${i}"]`) : null;
      const owner = q || list;
      if (li) { li.classList.add('is-active'); owner.setAttribute('aria-activedescendant', li.id); if (scroll) li.scrollIntoView({ block: 'nearest' }); }
      else owner.removeAttribute('aria-activedescendant');
    }
    function place() {
      if (narrow()) { panel.classList.add('sheet-mode'); panel.style.cssText = ''; return; }
      panel.classList.remove('sheet-mode');
      const r = btn.getBoundingClientRect(), vh = window.innerHeight, vw = window.innerWidth;
      const width = Math.min(Math.max(r.width, opts.minWidth || 280), vw - 24);
      const below = vh - r.bottom - 12, above = r.top - 12;
      const down = below >= 260 || below >= above;
      const maxH = Math.max(160, Math.min(440, (down ? below : above) - 6));
      const left = Math.min(Math.max(12, r.left), vw - width - 12);
      panel.style.cssText = `left:${left}px;width:${width}px;max-height:${maxH}px;` + (down ? `top:${r.bottom + 6}px` : `bottom:${vh - r.top + 6}px`);
    }
    function open() {
      if (openPicker && openPicker !== p) openPicker.close(false);
      if (!panel) build();
      if (q) q.value = '';
      fill();
      place();
      panel.classList.add('open');
      document.documentElement.classList.toggle('pick-sheet-open', narrow());
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-controls', id + '-list');
      openPicker = p;
      const cur = shown.findIndex(o => o.value === select.value);
      setActive(cur >= 0 ? cur : 0, true);
      (q && !narrow() ? q : list).focus({ preventScroll: true });
    }
    function close(focusBtn) {
      if (!panel || !panel.classList.contains('open')) return;
      panel.classList.remove('open');
      document.documentElement.classList.remove('pick-sheet-open');
      btn.setAttribute('aria-expanded', 'false');
      if (openPicker === p) openPicker = null;
      if (focusBtn) btn.focus({ preventScroll: true });
    }
    function choose(v) {
      close(true);
      if (v !== select.value) { select.value = v; select.dispatchEvent(new Event('change', { bubbles: true })); }
      refresh();
    }
    function onKey(e) {
      const n = shown.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(n ? Math.min(n - 1, active + 1) : -1, true); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(n ? Math.max(0, active - 1) : -1, true); }
      else if (e.key === 'Home' && e.target === list) { e.preventDefault(); setActive(n ? 0 : -1, true); }
      else if (e.key === 'End' && e.target === list) { e.preventDefault(); setActive(n - 1, true); }
      else if (e.key === 'Enter' || (e.key === ' ' && e.target === list)) { e.preventDefault(); if (active >= 0 && shown[active]) choose(shown[active].value); }
      else if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'Tab') close(false);
    }
    btn.addEventListener('click', () => (panel && panel.classList.contains('open') ? close(true) : open()));
    btn.addEventListener('keydown', e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); } });
    select.addEventListener('change', refresh);
    new MutationObserver(refresh).observe(select, { childList: true, subtree: true });
    refresh();
    select._picker = p;
    pickers.add(p);
    return p;
  }
  const refreshPickers = () => pickers.forEach(p => p.refresh());
  document.addEventListener('pointerdown', e => {
    if (!openPicker) return;
    if (e.target.closest('.pick-panel') || e.target.closest('.pick-btn') === openPicker.btn) return;
    openPicker.close(false);
  }, true);
  window.addEventListener('resize', () => { if (openPicker) openPicker.close(false); });
  window.addEventListener('scroll', e => {
    if (openPicker && !narrow() && !(e.target instanceof Element && e.target.closest('.pick-panel'))) openPicker.close(false);
  }, true);

  /* ---------- Chart.js add-ons ---------- */
  // Values at the end of each bar (only where a chart asks, with a formatter).
  const barValues = {
    id: 'barValues',
    afterDatasetsDraw(chart, _args, o) {
      if (!o || !o.format) return;
      const { ctx } = chart, horizontal = chart.options.indexAxis === 'y';
      ctx.save();
      ctx.font = `600 12px ${cssVar('--cond') || 'sans-serif'}`;
      ctx.fillStyle = o.color;
      chart.data.datasets.forEach((ds, di) => {
        const meta = chart.getDatasetMeta(di);
        if (meta.hidden || meta.type !== 'bar' || (o.only != null && o.only !== di)) return;
        meta.data.forEach((bar, i) => {
          const v = ds.data[i];
          if (v == null || !isFinite(typeof v === 'object' ? v.y : v)) return;
          const val = typeof v === 'object' ? (horizontal ? v.x : v.y) : v;
          const txt = o.format(val, i);
          const neg = val < 0;
          if (horizontal) { ctx.textAlign = neg ? 'right' : 'left'; ctx.textBaseline = 'middle'; ctx.fillText(txt, bar.x + (neg ? -6 : 6), bar.y); }
          else { ctx.textAlign = 'center'; ctx.textBaseline = neg ? 'top' : 'bottom'; ctx.fillText(txt, bar.x, bar.y + (neg ? 5 : -5)); }
        });
      });
      ctx.restore();
    }
  };
  // The total in the middle of a donut.
  const donutCenter = {
    id: 'donutCenter',
    afterDraw(chart, _args, o) {
      if (!o || !o.text || chart.config.type !== 'doughnut' || !chart.options.cutout) return;
      const a = chart.chartArea, x = (a.left + a.right) / 2, y = (a.top + a.bottom) / 2, { ctx } = chart;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = o.color;
      ctx.font = `700 ${o.size || 22}px ${cssVar('--cond') || 'sans-serif'}`;
      ctx.textBaseline = 'bottom';
      ctx.fillText(o.text, x, y + 4);
      ctx.fillStyle = o.sub || o.color;
      ctx.font = `400 12px ${cssVar('--sans') || 'sans-serif'}`;
      ctx.textBaseline = 'top';
      if (o.caption) ctx.fillText(o.caption, x, y + 8);
      ctx.restore();
    }
  };
  if (window.Chart) window.Chart.register(barValues, donutCenter);

  return {
    $, $$, DAY, esc, full, full2, cmp, tick, pct, units, isoToMs, msToIso, fmtDate, fmtMonth, todayMs,
    store, cssVar, hexA, colors, currentTheme, getJSON, loadFunds, loadHistory, idxOnOrBefore, idxOnOrAfter,
    xirr, timeAxis, tooltip, reducedMotion, download, emit, shortCategory, groupLabel,
    icon, narrow, pref, setPref, typeSwitch, picker, refreshPickers
  };
})();
