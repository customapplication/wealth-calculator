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

  return {
    $, $$, DAY, esc, full, full2, cmp, tick, pct, units, isoToMs, msToIso, fmtDate, fmtMonth, todayMs,
    store, cssVar, hexA, colors, currentTheme, getJSON, loadFunds, loadHistory, idxOnOrBefore, idxOnOrAfter,
    xirr, timeAxis, tooltip, reducedMotion, download, emit, shortCategory, groupLabel
  };
})();
