/* Page switching (Home, Portfolio, Explore funds, Compare, Plan), the panels
   that hold forms (a drawer on wide screens, a sheet on phones), and the theme. */
(() => {
  'use strict';
  const { $, $$, store, currentTheme, emit } = MF;
  const VIEWS = ['home', 'portfolio', 'explore', 'compare', 'plan'];
  const NAV_OF = {};
  const THEME_KEY = 'corpus-planner:theme';
  const TITLES = { home: 'Home', portfolio: 'Portfolio', explore: 'Explore funds', compare: 'Compare funds', plan: 'Plan' };

  /* ---------- panels ---------- */
  let openP = null, opener = null, openerSel = null;
  // If the opener is redrawn while the panel is open (the plan sentence is), focus goes to its replacement.
  const selectorOf = el => el && el.id ? '#' + CSS.escape(el.id)
    : el && el.dataset && el.dataset.focus ? `[data-focus="${CSS.escape(el.dataset.focus)}"]` : null;
  const focusables = el => $$('button:not([disabled]), [href], input:not([type=hidden]):not([disabled]), select:not([disabled]):not(.pick-native), textarea, summary, [tabindex]:not([tabindex="-1"])', el)
    .filter(x => x.offsetParent !== null || x === document.activeElement);

  function openPanel(id, focusSel) {
    const p = document.getElementById(id);
    if (!p) return;
    if (openP && openP !== p) closePanel(false);
    if (!openP) { opener = document.activeElement; openerSel = selectorOf(opener); }
    openP = p;
    p.hidden = false;
    document.documentElement.classList.add('panel-open');
    document.documentElement.classList.toggle('panel-light', id === 'planRail');
    $$(`[data-open-panel="${id}"]`).forEach(b => b.setAttribute('aria-expanded', 'true'));
    const target = focusSel ? $(focusSel, p) : null;
    setTimeout(() => {
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.focus({ preventScroll: true });
        if (target.select && target.type === 'number') target.select();
      } else {
        const body = $('.panel-body', p); if (body) body.scrollTop = 0;
        ($('[data-panel-close]', p) || p).focus({ preventScroll: true });
      }
    }, 30);
    emit('mf:panel', { id, open: true });
  }
  function closePanel(returnFocus = true) {
    if (!openP) return;
    const id = openP.id;
    openP.hidden = true;
    openP = null;
    document.documentElement.classList.remove('panel-open', 'panel-light');
    $$(`[data-open-panel="${id}"]`).forEach(b => b.setAttribute('aria-expanded', 'false'));
    if (returnFocus && opener && !document.contains(opener) && openerSel) opener = $(openerSel);
    if (returnFocus && opener && document.contains(opener) && opener.focus) opener.focus({ preventScroll: true });
    opener = null; openerSel = null;
    emit('mf:panel', { id, open: false });
  }
  document.addEventListener('click', e => {
    const o = e.target.closest('[data-open-panel]');
    if (o) { e.preventDefault(); openPanel(o.dataset.openPanel, o.dataset.focusSel); return; }
    if (e.target.closest('[data-panel-close]') || (openP && e.target.classList.contains('scrim'))) closePanel();
  });
  document.addEventListener('keydown', e => {
    if (!openP) return;
    if (e.key === 'Escape' && !document.documentElement.classList.contains('pick-sheet-open') && !e.defaultPrevented) {
      if (e.target.closest && e.target.closest('.combo') && e.target.getAttribute('aria-expanded') === 'true') return;
      e.preventDefault(); closePanel(); return;
    }
    if (e.key !== 'Tab') return;
    const f = focusables(openP);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  $$('.panel').forEach(p => p.setAttribute('tabindex', '-1'));

  // Kept for code that still asks for the old input drawers.
  window.Shell = {
    openPanel, closePanel,
    openDrawer: (id, focusSel) => openPanel(id === 'pfRail' ? (focusSel === '#syncBox' ? 'panelSheet' : 'panelAdd') : id, focusSel === '#syncBox' ? null : focusSel),
    closeDrawer: closePanel,
    isOpen: id => !!(openP && (!id || openP.id === id)),
    sheetMode: () => !window.matchMedia('(min-width: 760px)').matches
  };

  /* ---------- pages ---------- */
  let current = null;
  function show(view, fromHash) {
    if (!VIEWS.includes(view)) view = 'home';
    // A panel opened for the page being shown (e.g. "Add a SIP in this fund") stays open.
    if (openP && !(openP.closest(`[data-view="${view}"]`) || !openP.closest('.view'))) closePanel(false);
    $$('.view').forEach(v => { v.hidden = v.dataset.view !== view; });
    const navView = NAV_OF[view] || view;
    $$('.nav a, .tabbar a').forEach(a => {
      if (a.dataset.view === navView) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.title = `${TITLES[view]} · SIPs`;
    document.documentElement.dataset.view = view;
    store.set('corpus-planner:view', view);
    if (current && current !== view && fromHash) window.scrollTo(0, 0);
    current = view;
    emit('mf:view', { view });
  }

  /* ---------- theme ---------- */
  function setThemeLabel() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    $$('.theme-toggle').forEach(b => { b.setAttribute('aria-label', `Switch to the ${next} theme`); b.title = `Switch to the ${next} theme`; });
    document.documentElement.dataset.shown = currentTheme();
  }
  $$('.theme-toggle').forEach(b => b.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store.set(THEME_KEY, next);
    setThemeLabel();
    emit('mf:theme', { theme: next });
  }));
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (!document.documentElement.getAttribute('data-theme')) { setThemeLabel(); emit('mf:theme', {}); } };
    if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
  }
  setThemeLabel();

  window.addEventListener('hashchange', () => show(location.hash.slice(1), true));
  const saved = store.get('corpus-planner:view');
  show(location.hash.slice(1) || (VIEWS.includes(saved) ? saved : 'home'));
})();
