/* Page switching (Plan, Explore funds, My portfolio), the light/dark theme, and
   on phones the input panels that slide up from the bottom. */
(() => {
  'use strict';
  const { $, $$, store, currentTheme, emit } = MF;
  const VIEWS = ['plan', 'explore', 'portfolio'];
  const THEME_KEY = 'corpus-planner:theme';
  const TITLES = { plan: 'Plan', explore: 'Explore funds', portfolio: 'My portfolio' };

  /* ---------- input panels: a sidebar on wide screens, a sheet on phones ---------- */
  const sheetMode = window.matchMedia('(max-width: 1000px)');
  let openRail = null, opener = null;
  const focusables = el => $$('button:not([disabled]), [href], input:not([type=hidden]):not([disabled]), select:not([disabled]):not(.pick-native), textarea, summary, [tabindex]:not([tabindex="-1"])', el)
    .filter(x => x.offsetParent !== null || x === document.activeElement);

  function openDrawer(id, focusSel) {
    const rail = document.getElementById(id);
    if (!rail || !sheetMode.matches) {
      if (rail && focusSel) { const t = $(focusSel, rail); if (t) t.scrollIntoView({ block: 'start' }); }
      return;
    }
    if (openRail) closeDrawer(false);
    openRail = rail;
    opener = $(`[data-drawer-open="${id}"]`);
    rail.classList.add('open');
    rail.setAttribute('role', 'dialog');
    rail.setAttribute('aria-modal', 'true');
    document.documentElement.classList.add('drawer-open');
    if (opener) opener.setAttribute('aria-expanded', 'true');
    const target = focusSel ? $(focusSel, rail) : null;
    if (target) target.scrollIntoView({ block: 'start' }); else rail.scrollTop = 0;
    const done = $('[data-drawer-close]', rail);
    setTimeout(() => (done || rail).focus({ preventScroll: true }), 30);
  }
  function closeDrawer(returnFocus = true) {
    if (!openRail) return;
    openRail.classList.remove('open');
    openRail.removeAttribute('role');
    openRail.removeAttribute('aria-modal');
    document.documentElement.classList.remove('drawer-open');
    if (opener) { opener.setAttribute('aria-expanded', 'false'); if (returnFocus) opener.focus({ preventScroll: true }); }
    openRail = opener = null;
  }
  $$('[data-drawer-open]').forEach(b => b.addEventListener('click', () => openDrawer(b.dataset.drawerOpen)));
  document.addEventListener('click', e => {
    if (e.target.closest('[data-drawer-close]') || (openRail && e.target.classList.contains('scrim'))) closeDrawer();
  });
  document.addEventListener('keydown', e => {
    if (!openRail) return;
    if (e.key === 'Escape' && !document.documentElement.classList.contains('pick-sheet-open')) { e.preventDefault(); closeDrawer(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables(openRail);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  const onMode = () => { if (!sheetMode.matches) closeDrawer(false); };
  if (sheetMode.addEventListener) sheetMode.addEventListener('change', onMode); else if (sheetMode.addListener) sheetMode.addListener(onMode);

  window.Shell = { openDrawer, closeDrawer, sheetMode: () => sheetMode.matches };

  /* ---------- pages ---------- */
  function show(view) {
    if (!VIEWS.includes(view)) view = 'plan';
    // A panel opened for the page being shown (e.g. "Add a SIP in this fund") stays open.
    if (openRail && !openRail.closest(`[data-view="${view}"]`)) closeDrawer(false);
    $$('.view').forEach(v => { v.hidden = v.dataset.view !== view; });
    $$('.views a').forEach(a => {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.title = `${TITLES[view]} · SIPs`;
    document.documentElement.dataset.view = view;
    store.set('corpus-planner:view', view);
    emit('mf:view', { view });
  }

  /* ---------- theme ---------- */
  function setThemeLabel() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    const b = $('#themeToggle');
    b.setAttribute('aria-label', `Switch to the ${next} theme`);
    b.title = `Switch to the ${next} theme`;
    document.documentElement.dataset.shown = currentTheme();
  }
  $('#themeToggle').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store.set(THEME_KEY, next);
    setThemeLabel();
    emit('mf:theme', { theme: next });
  });
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (!document.documentElement.getAttribute('data-theme')) { setThemeLabel(); emit('mf:theme', {}); } };
    if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
  }
  setThemeLabel();

  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  show(location.hash.slice(1) || store.get('corpus-planner:view') || 'plan');
})();
