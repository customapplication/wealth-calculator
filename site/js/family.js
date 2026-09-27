/* Home's Family card: everyone's portfolio summary, for the Sheet's owner and
   the family members the owner shares it with (Security -> Family). Read-only:
   fund names and figures from each person's latest valuation, never folios,
   nominees, units or transactions. It needs Code.gs v6 and a login. */
(() => {
  'use strict';
  const { $, esc, full, pct, fmtDate } = MF;
  const S = () => window.Sync;
  let people = null, loadedAt = 0, busy = false;

  const signedIn = () => { const st = S() && S().status(); return !!(st && S().connected() && st.session); };
  const signCls = v => v < 0 ? 'loss' : 'gain';
  const signed = (v, f) => (v < 0 ? '−' : '+') + f(Math.abs(v));
  const when = ms => ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

  async function load(force) {
    if (!signedIn()) { people = null; render(); return; }
    if (busy || (!force && people && Date.now() - loadedAt < 5 * 60e3)) { render(); return; }
    busy = true;
    try {
      const r = await S().call('familySummary', {});
      people = Array.isArray(r.people) ? r.people : [];
      loadedAt = Date.now();
    } catch (e) {
      people = null;             // not shared with this person, an older script, or offline: no card
    } finally { busy = false; }
    render();
  }

  function render() {
    const card = $('#homeFamily');
    if (!card) return;
    // Worth showing only when there's someone besides you.
    card.hidden = !people || people.length < 2;
    if (card.hidden) return;
    const withFig = people.filter(p => p.totals);
    const total = withFig.reduce((s, p) => s + (p.totals.value || 0), 0);
    $('#homeFamilySub').textContent = `${people.length} people${withFig.length > 1 ? ` · ${full(total)} together` : ''} · view only`;
    $('#homeFamilyList').innerHTML = people.map((p, i) => {
      const t = p.totals, g = t && t.net > 0 ? t.gain / t.net : null;
      return `<li><button type="button" class="fam-row" data-fam="${i}"${t ? '' : ' disabled'}>
          <span class="who"><b>${esc(p.name)}${p.you ? ' <small>(you)</small>' : ''}</b>
            <small>${t ? `${p.rows.length} fund${p.rows.length === 1 ? '' : 's'} · valued ${when(p.valuedAt)}` : 'Not valued yet: shows once they open SIPs'}</small></span>
          ${t ? `<span class="fig"><b>${full(t.value)}</b><small class="${signCls(t.gain)}">${g != null ? signed(g, x => pct(x, 1)) : ''}${t.xirr != null ? ` · XIRR ${pct(t.xirr, 1)}` : ''}</small></span>` : ''}
        </button></li>`;
    }).join('');
  }

  function openPerson(i) {
    const p = people && people[i];
    if (!p || !p.totals) return;
    const t = p.totals;
    $('#panelFamilyTitle').textContent = p.you ? 'Your portfolio' : `${p.name}'s portfolio`;
    $('#famSub').textContent = `Valued ${when(p.valuedAt)}${p.navDate ? `, NAVs of ${fmtDate(p.navDate)}` : ''} · view only`;
    const fig = (k, v, d, cls) => `<div><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;
    $('#famFigs').innerHTML = fig('Worth', full(t.value)) + fig('Put in', full(t.net)) +
      fig('Gain', signed(t.gain, full), t.net > 0 ? pct(t.gain / t.net, 1) : '', signCls(t.gain)) + fig('XIRR', t.xirr != null ? pct(t.xirr, 1) : '—');
    const rows = p.rows.slice().sort((a, b) => (b.value || 0) - (a.value || 0));
    $('#famFunds').innerHTML = rows.map(r => r.error
      ? `<li><span class="nm">${esc(r.name)}<small>Couldn't be valued</small></span></li>`
      : `<li><span class="nm">${esc(r.name)}<small>${r.sip ? esc(r.sip.startsWith('Stopped') ? 'SIP ' + r.sip.toLowerCase() : 'SIP ' + r.sip) : !r.value && r.net <= 0 ? 'Sold: no units left' : r.kind === 'lump' ? 'One-time' : 'No SIP running'}</small></span>
          <span class="fig"><b>${full(r.value)}</b><small>${!r.value && r.net <= 0 ? 'gain' : `put in ${full(r.net)} ·`} <span class="${signCls(r.gain)}">${signed(r.gain, full)}</span>${r.xirr != null ? ` · ${pct(r.xirr, 1)} a year` : ''}</small></span></li>`).join('') ||
      '<li><span class="nm">No investments yet.</span></li>';
    window.Shell.openPanel('panelFamily');
  }

  $('#homeFamilyList').addEventListener('click', e => { const b = e.target.closest('[data-fam]'); if (b) openPerson(+b.dataset.fam); });
  document.addEventListener('mf:view', e => { if (e.detail.view === 'home') load(false); });
  document.addEventListener('mf:family', () => load(true));
  document.addEventListener('mf:account', () => { people = null; loadedAt = 0; if (document.documentElement.dataset.view === 'home') load(true); });
  document.addEventListener('mf:synced', () => { if (document.documentElement.dataset.view === 'home') load(true); });
})();
