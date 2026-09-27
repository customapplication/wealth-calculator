/* Fund data: how fresh it is, and "Update now", which starts the nightly
   GitHub workflow through your Google Sheet's script (it holds the GitHub
   token; the site never does). The workflow also re-enables itself, so this
   covers GitHub pausing the schedule after 60 days without a commit. */
(() => {
  'use strict';
  const { $, esc, getJSON } = MF;
  const STALE_HOURS = 30;                  // the build runs every night at 02:00 IST
  const POLL = 20e3, POLL_FOR = 25 * 60e3;
  let meta = null, polling = null, watchFrom = 0;

  /** owner/repository, from a github.io address; the Sheet's GITHUB_REPO covers a custom domain. */
  function siteRepo() {
    const h = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);
    if (!h) return null;
    const seg = location.pathname.split('/').filter(Boolean)[0];
    return `${h[1]}/${seg && !/\.html?$/i.test(seg) ? seg : h[1] + '.github.io'}`;
  }
  const actionsUrl = repo => `https://github.com/${repo}/actions/workflows/nightly.yml`;
  const when = ms => new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const hoursOld = () => meta && meta.built_at ? (Date.now() - Date.parse(meta.built_at)) / 36e5 : null;

  async function loadMeta() {
    try { meta = await getJSON('data/meta.json'); } catch (e) { meta = null; }
    const old = hoursOld(), box = $('#dataStale');
    if (!box) return;
    box.hidden = !(old == null || old > STALE_HOURS);
    if (box.hidden) return;
    $('#dataStaleTitle').textContent = meta ? 'Fund data is out of date' : "The fund data isn't built yet";
    $('#dataStaleText').textContent = meta
      ? `It was last rebuilt ${when(Date.parse(meta.built_at))}, with NAVs up to ${MF.fmtDate(meta.nav_date)}. GitHub may have paused the nightly update.`
      : 'Run the nightly update once to build it.';
  }

  const msg = (t, bad) => { const m = $('#dataMsg'); m.textContent = t; m.classList.toggle('bad', !!bad); };
  const row = (k, v, cls) => `<div><dt>${k}</dt><dd${cls ? ` class="${cls}"` : ''}>${v}</dd></div>`;
  const STATE = { active: ['On, every night', 'ok'], disabled_inactivity: ['Paused by GitHub after 60 quiet days', 'bad'], disabled_manually: ['Turned off on GitHub', 'bad'] };
  function runText(r) {
    if (!r) return 'None yet';
    if (r.status !== 'completed') return `${r.status === 'queued' ? 'Waiting to start' : 'Running'}, started ${when(r.created)}`;
    return `${r.conclusion === 'success' ? 'Finished' : r.conclusion === 'cancelled' ? 'Cancelled' : 'Failed'} ${when(r.updated)}`;
  }

  async function render() {
    const facts = $('#dataFacts'), setup = $('#dataSetup'), go = $('#dataGo');
    const s = window.Sync, st = s ? s.status() : {}, repo = siteRepo();
    const rows = [];
    if (meta) {
      const old = hoursOld();
      rows.push(row('NAVs up to', esc(MF.fmtDate(meta.nav_date))));
      rows.push(row('Last rebuilt', esc(when(Date.parse(meta.built_at))) + (old > STALE_HOURS ? ' (late)' : ''), old > STALE_HOURS ? 'bad' : ''));
    } else rows.push(row('Fund data', 'Not built yet', 'bad'));
    facts.innerHTML = rows.join('');
    const linkOut = repo ? `<a href="${esc(actionsUrl(repo))}" target="_blank" rel="noopener">GitHub Actions<svg class="ic" aria-hidden="true"><use href="#i-out"/></svg></a>` : 'GitHub Actions';
    const byHand = `<p class="hint">Or on ${linkOut}: press <b>Enable workflow</b> if GitHub shows it, then <b>Run workflow</b>.</p>`;
    if (!s || !s.connected() || !(st.version >= 3)) {
      go.hidden = true;
      setup.innerHTML = `<p class="note">${s && s.connected() ? 'Your Sheet runs an older script. Paste the new <code>sheets/Code.gs</code> and deploy a new version to update the fund data from here.'
        : 'Connect your Google Sheet to update the fund data from here.'}</p>${byHand}`;
      return;
    }
    go.hidden = false;
    let g = null;
    try { g = (await s.call('dataStatus', { repo })).github; } catch (e) { setup.innerHTML = `<p class="hint bad">${esc(e.message)}</p>${byHand}`; return; }
    if (!g.configured) {
      go.hidden = true;
      setup.innerHTML = `<p class="note"><b>One-time setup, so this button can start the update.</b></p>
        <ol class="steps-mini">
          <li>On GitHub, open your picture, then <b>Settings → Developer settings → Personal access tokens → Fine-grained tokens</b>, and press <b>Generate new token</b>.</li>
          <li>Name it <i>SIPs update</i>, choose the longest expiry, and under <b>Repository access</b> pick <b>Only select repositories</b>: ${esc(repo || 'this site\'s repository')}.</li>
          <li>Under <b>Permissions → Repository permissions</b>, set <b>Actions</b> to <b>Read and write</b>. Nothing else. Generate it and copy it.</li>
          <li>In your Sheet's Apps Script, <b>Project Settings → Script properties</b>, add <code>GITHUB_TOKEN</code> with the token${repo ? '' : ', and <code>GITHUB_REPO</code> with owner/repository'}.</li>
          <li>Optional: in the Sheet, <b>SIPs → Keep the nightly data update running</b> checks it every morning and restarts it for you.</li>
        </ol>${byHand}`;
      return;
    }
    if (g.error) { setup.innerHTML = `<p class="hint bad">${esc(g.error)}</p>${byHand}`; return; }
    const [label, cls] = STATE[g.state] || [g.state || 'Unknown', ''];
    facts.innerHTML += row('Nightly update', esc(label), cls) + row('Latest run', g.run ? `<a href="${esc(g.run.url)}" target="_blank" rel="noopener">${esc(runText(g.run))}</a>` : 'None yet') +
      row('Daily check', g.checking ? `On${g.watch ? `: ${esc(g.watch.did)}` : ''}` : g.checking === false ? 'Off (SIPs menu in the Sheet → Keep the nightly data update running)' : 'Unknown');
    setup.innerHTML = byHand;
    return g;
  }

  async function start() {
    const go = $('#dataGo');
    go.disabled = true; msg('Asking GitHub to start the update…');
    try {
      const r = await window.Sync.call('dataRefresh', { repo: siteRepo() });
      if (r.started) { msg(`Started${r.enabled ? ', and switched the paused nightly update back on' : ''}. It takes a few minutes; this panel follows it.`); watchFrom = Date.now(); follow(); }
      else if (r.reason === 'running') { msg('An update is already running. This panel follows it.'); watchFrom = Date.now() - 60e3; follow(); }
      else if (r.reason === 'recent') msg('An update started less than 10 minutes ago. Try again once it finishes.');
      await render();
    } catch (e) { msg(e.message, true); }
    finally { go.disabled = false; }
  }

  function follow() {
    clearInterval(polling);
    polling = setInterval(async () => {
      if (Date.now() - watchFrom > POLL_FOR) { clearInterval(polling); return; }
      const g = await render().catch(() => null);
      const r = g && g.run;
      if (!r || r.created < watchFrom - 5 * 60e3) return;
      if (r.status !== 'completed') { msg(`${runText(r)}. It usually takes 2 to 6 minutes.`); return; }
      clearInterval(polling);
      if (r.conclusion === 'success') { msg('The fund data is updated.'); $('#dataReload').hidden = false; }
      else msg('The update didn\'t finish. Open the latest run to see why.', true);
    }, POLL);
  }

  $('#dataGo').addEventListener('click', start);
  $('#dataReload').addEventListener('click', async () => { if (window.Lock) await window.Lock.flush(); location.reload(); });
  document.addEventListener('mf:panel', e => { if (e.detail.id === 'panelData' && e.detail.open) { msg(''); render(); } });
  loadMeta();
})();
