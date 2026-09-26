/* Page switching (Plan, Explore funds, My portfolio) and the light/dark theme. */
(() => {
  'use strict';
  const { $, $$, store, currentTheme, emit } = MF;
  const VIEWS = ['plan', 'explore', 'portfolio'];
  const THEME_KEY = 'corpus-planner:theme';
  const TITLES = { plan: 'Plan', explore: 'Explore funds', portfolio: 'My portfolio' };

  function show(view) {
    if (!VIEWS.includes(view)) view = 'plan';
    $$('.view').forEach(v => { v.hidden = v.dataset.view !== view; });
    $$('.views a').forEach(a => {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.title = `${TITLES[view]}: Corpus planner`;
    store.set('corpus-planner:view', view);
    emit('mf:view', { view });
  }

  function setThemeLabel() {
    $('#themeToggle').textContent = currentTheme() === 'dark' ? 'Light theme' : 'Dark theme';
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
