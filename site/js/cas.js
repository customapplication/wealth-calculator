/* Reads a CAMS + KFintech Consolidated Account Statement (CAS) PDF in the browser.

   The file never leaves the device. pdf.js (self-hosted in vendor/pdfjs) pulls
   the text out here, lines() puts it back into rows, and parse() turns the rows
   into the portfolio's import format. Kept for each fund: the scheme, its
   ISIN, the fund house, the folio number, the registrar, the distributor
   (ARN) or DIRECT, the nominees' names, whether KYC and PAN are marked OK,
   demat or not, the statement's cost and value, its exit load wording, and
   every transaction. The investor's name, PAN, email, phone and address are
   never read into the result.

   Works in Node too (module.exports), so the parser is tested without a browser. */
(function (root) {
  'use strict';
  const FORMAT = 'mf-corpus-planner/cas-v1';
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const DATE = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/;
  const DATE_AT_START = /^(\d{1,2}-[A-Za-z]{3}-\d{4})\b\s*/;
  const NUM = /^\(?-?[\d,]*\d(?:\.\d+)?\)?$/;
  const SAME_LINE = 2.5;       // points: text this close vertically is one row
  const UNITS_EPS = 0.002;     // units are printed to 3 decimals

  class CasError extends Error {
    constructor(code, message) { super(message); this.code = code; this.name = 'CasError'; }
  }

  function iso(s) {
    const m = DATE.exec(String(s || '').trim());
    if (!m || !MONTHS[m[2].toLowerCase()]) return null;
    return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  function num(s) {
    if (s == null) return null;
    const t = String(s).trim();
    if (!NUM.test(t)) return null;
    const v = Number(t.replace(/[,()]/g, ''));
    if (!Number.isFinite(v)) return null;
    return t.startsWith('(') ? -Math.abs(v) : v;
  }
  const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

  /* One page's pdf.js text items -> rows, top to bottom. Each row keeps its
     pieces with their x positions, and a text form: pieces that touch are joined
     without a space (an ISIN is often drawn in several pieces). */
  function lines(items) {
    const its = [];
    for (const i of items || []) {
      const s = String(i.str || '').replace(/\s+/g, ' ').trim();
      if (!s) continue;
      const x = i.transform[4], y = i.transform[5];
      its.push({ x, y, r: x + (i.width || 0), s });
    }
    its.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const it of its) {
      const row = rows.length && Math.abs(rows[rows.length - 1].y - it.y) <= SAME_LINE ? rows[rows.length - 1] : null;
      if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
    }
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      let text = '', prev = null;
      for (const it of row.items) {
        if (prev) text += it.x - prev.r > 1 ? ' ' : '';
        text += it.s;
        prev = it;
      }
      row.text = text.replace(/\s+/g, ' ').trim();
    }
    return rows;
  }

  const NOISE = [
    /^Consolidated Account Statement$/i,
    /^\d{1,2}-[A-Za-z]{3}-\d{4} To \d{1,2}-[A-Za-z]{3}-\d{4}$/i,
    /^Page \d+ of \d+$/i,
    /^CAMSCAS/i,
    /Version\s*:\s*V[\d.]+/i,
    /^\(INR\)/i,
    /^Balance$/i
  ];
  const isNoise = t => NOISE.some(re => re.test(t));

  /* Where the Amount, Units, Price and Balance columns sit, from the table header. */
  function headerColumns(row) {
    const find = re => row.items.find(i => re.test(i.s));
    const a = find(/^Amount/i), u = find(/^Units/i), p = find(/^(Price|NAV)/i), b = find(/^(Unit(\s*Balance)?|Balance)$/i);
    if (!a || !u || !p) return null;
    const mid = i => (i.x + i.r) / 2;
    return { amount: mid(a), units: mid(u), nav: mid(p), balance: b ? mid(b) : mid(p) + (mid(p) - mid(u)) };
  }

  /* A transaction row: its date, its words, and its numbers put in their columns. */
  function txnRow(row, cols) {
    const m = DATE_AT_START.exec(row.text);
    const date = iso(m[1]);
    const rest = row.items.slice();
    // The date can be one piece or glued to the first words.
    const first = rest.shift();
    const lead = first.s.replace(DATE_AT_START, '').trim();
    const words = [], nums = [];
    if (lead) words.push(lead);
    const numberZone = cols ? Math.min(cols.amount, cols.units) - 30 : -Infinity;
    for (const it of rest) {
      const mid = (it.x + it.r) / 2;
      if (NUM.test(it.s) && mid >= numberZone) nums.push({ v: num(it.s), mid });
      else words.push(it.s);
    }
    const out = { date, desc: words.join(' ').replace(/\s+/g, ' ').trim(), amount: null, units: null, nav: null, balance: null };
    if (cols) {
      const keys = ['amount', 'units', 'nav', 'balance'];
      const taken = new Set();
      let clash = false;
      for (const n of nums) {
        const k = keys.reduce((best, key) => Math.abs(cols[key] - n.mid) < Math.abs(cols[best] - n.mid) ? key : best, keys[0]);
        if (taken.has(k)) clash = true;
        taken.add(k); out[k] = n.v;
      }
      if (!clash) return out;
      keys.forEach(k => { out[k] = null; });
    }
    // No header seen, or two numbers fell in one column: go by order.
    const order = nums.length === 1 ? ['amount'] : nums.length === 2 ? ['units', 'balance'] : ['amount', 'units', 'nav', 'balance'];
    nums.slice(0, 4).forEach((n, i) => { out[order[i]] = n.v; });
    return out;
  }

  /* What a transaction is, in the names the portfolio page uses. */
  function kindOf(t) {
    const d = t.desc.toLowerCase();
    if (!t.units) {
      if (t.amount == null) return null;                       // a note, not money: "Address updated" etc.
      if (/stamp/.test(d)) return 'STAMP_DUTY_TAX';
      if (/\bstt\b|securities transaction/.test(d)) return 'STT_TAX';
      if (/\btds\b|tax deducted/.test(d)) return 'TDS_TAX';
      if (/div|idcw|income distribution/.test(d)) return 'DIVIDEND_PAYOUT';
      return d ? 'MISC' : 'CHARGE';
    }
    if (/revers|reject/.test(d)) return 'REVERSAL';
    const merger = /merg|amalgamat/.test(d);
    const transfer = /switch|systematic transfer|\bstp\b|\bst[io]\b/.test(d);
    if (t.units > 0) {
      if (transfer) return merger ? 'SWITCH_IN_MERGER' : 'SWITCH_IN';
      if (/reinv/.test(d) && /div|idcw|income distribution/.test(d)) return 'DIVIDEND_REINVEST';
      if (/segregat/.test(d)) return 'SEGREGATION';
      if (/bonus/.test(d)) return 'BONUS';
      if (t.amount == null) return merger ? 'SWITCH_IN_MERGER' : 'TRANSFER_IN';
      if (/\bsip\b|isip|systematic|sys\.? ?invest|instal/.test(d)) return 'PURCHASE_SIP';
      return 'PURCHASE';
    }
    if (transfer) return merger ? 'SWITCH_OUT_MERGER' : 'SWITCH_OUT';
    if (t.amount == null) return merger ? 'SWITCH_OUT_MERGER' : 'TRANSFER_OUT';
    return 'REDEMPTION';
  }

  /* "12345678 / 90" -> "12345678/90". The folio is kept whole: it's what a fund
     house or registrar asks for. The page shows only its end unless asked. */
  function cleanFolio(f) {
    return String(f || '').replace(/\s*\/\s*/g, '/').replace(/[^A-Za-z0-9/]/g, '').slice(0, 30);
  }
  /* "Folio No: 12345678 / 90 PAN: ABCDE1234F KYC: OK PAN: OK": the statuses only, never the PAN. */
  function folioStatus(t) {
    const kyc = /KYC\s*:\s*([A-Za-z][A-Za-z ]{0,15}?)\s*(?=PAN\s*:|$)/i.exec(t);
    const pan = /PAN\s*:\s*([A-Za-z][A-Za-z ]{0,15}?)\s*$/i.exec(t);
    return { kyc: kyc ? kyc[1].trim().toUpperCase() : null, pan: pan ? pan[1].trim().toUpperCase() : null };
  }
  /* "Nominee 1: A PERSON Nominee 2: Nominee 3:" -> ["A PERSON"] */
  function nomineesOf(t) {
    return t.split(/Nominee\s*\d\s*:?/i).map(x => x.replace(/\s+/g, ' ').trim()).filter(x => x && x.length <= 80);
  }
  const LOAD_START = /\b(entry|exit)\s*load\b|load\s*structure|lock-?\s*in/i;
  const HEADING_ROW = /^[A-Z0-9]{1,14}\s*-\s*\S|ISIN\s*:|Registrar\s*:|^(KFINTECH|KARVY|CAMS)$|^Folio No|^Nominee\s*\d|Opening Unit Balance|Mutual Fund$|^PORTFOLIO/i;

  /* The scheme's heading, which can wrap over two or three rows:
     "A12-Alpha ELSS Tax Saver Fund-Regular Plan-Growth (Non-Demat) - ISIN: INF999A01234(Advisor: ARN-00001)" */
  function schemeHeading(rows) {
    let text = rows.join(' ');
    const rta = /Registrar\s*:?\s*(CAMS|KFINTECH|KARVY)/i.exec(text) || /\b(KFINTECH|KARVY|CAMS)\b/.exec(text);
    text = text.replace(/Registrar\s*:?\s*(CAMS|KFINTECH|KARVY)?/ig, ' ').replace(/(^|\s)(KFINTECH|KARVY)(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
    const at = text.search(/ISIN\s*:/i);
    const dm = /\(\s*(Non\s*-?\s*)?Demat\s*\)/i.exec(text);
    let isin = null, name = text, advisor = null;
    if (at >= 0) {
      const tail = text.slice(at).replace(/^ISIN\s*:\s*/i, '');
      const compact = tail.replace(/\s+/g, '');
      const m = /^(IN[A-Z0-9]{9}\d)/.exec(compact);
      if (m) isin = m[1];
      const adv = /Advisor\s*:\s*([^)]*)\)/i.exec(tail);
      if (adv) advisor = adv[1].replace(/\s+/g, '').trim() || null;
      name = text.slice(0, at);
    }
    name = name
      .replace(/^[A-Z0-9]{1,14}\s*-\s*(?=\S)/, '')                     // the registrar's scheme code
      .replace(/\s*\((?:formerly|erstwhile|earlier)\b[^)]*\)/ig, ' ')      // old names
      .replace(/\s*-\s*$/, '')
      .replace(/\(\s*(Non\s*-?\s*)?Demat\s*\)\s*$/i, '')
      .replace(/\s*-\s*$/, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*-\s*/g, m => (m.trim() === '-' ? ' - ' : m))
      .replace(/ - (?=[a-z])/g, '-')
      .trim();
    if (advisor) advisor = advisor.toUpperCase().replace(/^ARN(\d)/, 'ARN-$1');
    return { name, isin, advisor, demat: dm ? !dm[1] : null, rta: rta ? rta[1].toUpperCase().replace('KARVY', 'KFINTECH') : null };
  }

  /* Rows of every page -> the import format. `pages` is an array of pdf.js
     text-item arrays, one per page. */
  function parse(pages) {
    const all = [];
    pages.forEach((items, p) => lines(items).forEach(r => { r.page = p + 1; all.push(r); }));
    const text = all.map(r => r.text);
    if (!all.length) throw new CasError('empty', "This PDF has no readable text. If it's a scan or photo, download the statement again from CAMS or MF Central.");
    if (text.some(t => /Consolidated Account Summary/i.test(t)) && !text.some(t => /Opening Unit Balance/i.test(t))) {
      throw new CasError('summary', "This is a summary statement: it has balances but no transactions. Request a Detailed statement instead.");
    }
    if (text.slice(0, 40).some(t => /\b(NSDL|CDSL)\b/.test(t)) && !text.some(t => /Folio No/i.test(t))) {
      throw new CasError('depository', "This is an NSDL or CDSL statement. Use the CAMS + KFintech statement, which lists every mutual fund transaction.");
    }
    if (!text.some(t => /Folio No/i.test(t))) {
      throw new CasError('not-cas', "This doesn't look like a CAMS + KFintech Consolidated Account Statement.");
    }

    let period = null;
    for (const t of text.slice(0, 20)) {
      const m = /(\d{1,2}-[A-Za-z]{3}-\d{4})\s+To\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i.exec(t);
      if (m) { period = { from: iso(m[1]), to: iso(m[2]) }; break; }
    }

    const holdings = [], warnings = [];
    let cols = null, amc = null, folio = null, status = null, pending = [], cur = null, lastTxn = null, headDone = false, summary = null, closed = null;
    let loadRows = 0;                                      // rows of exit load wording read after a scheme closes

    const finishHeading = () => {
      // the heading is the block from the scheme-code line (or the ISIN line) to here
      let end = pending.length - 1;
      let isinAt = -1;
      for (let i = end; i >= 0; i--) if (/ISIN\s*:/i.test(pending[i])) { isinAt = i; break; }
      let start = isinAt >= 0 ? isinAt : Math.max(0, end);
      for (let i = isinAt; i >= Math.max(0, isinAt - 3); i--) {
        if (/^[A-Z0-9]{1,14}\s*-\s*\S/.test(pending[i])) { start = i; break; }
      }
      const h = schemeHeading(pending.slice(start, end + 1));
      cur = {
        amfi: null, isin: h.isin, name: h.name, amc, folio: cleanFolio(folio), rta: h.rta,
        advisor: h.advisor, demat: h.demat, kyc: status ? status.kyc : null, pan_ok: status && status.pan ? status.pan === 'OK' : null,
        nominees: null, load: null,
        open_units: null, close_units: null, cost: null,
        valuation: { date: null, nav: null, value: null }, txns: [], _bal: []
      };
      holdings.push(cur);
      pending = [];
      headDone = true;
    };

    for (const row of all) {
      const t = row.text;
      if (/^Date\s+Transaction\b/i.test(t)) { cols = headerColumns(row) || cols; continue; }
      if (isNoise(t)) continue;
      if (/^PORTFOLIO SUMMARY/i.test(t)) { summary = []; continue; }
      if (summary && !cur && !folio) {
        // the portfolio summary on page 1: fund house, cost, market value
        const m = /^(.+? Mutual Fund)\s+([\d,.]+)\s+([\d,.]+)$/i.exec(t);
        if (m) { summary.push({ amc: m[1], cost: num(m[2]), value: num(m[3]) }); continue; }
      }
      if (/^[A-Za-z][A-Za-z0-9 &.()'-]* Mutual Fund$/.test(t) && !/\d/.test(t)) {
        amc = t; folio = null; cur = null; pending = []; headDone = false; continue;
      }
      const f = /^Folio No\s*:?\s*(.*?)(?:\s+PAN\s*:.*)?$/i.exec(t);
      if (f) { folio = f[1].trim(); status = folioStatus(t); cur = null; pending = []; headDone = false; loadRows = 0; continue; }

      // The exit load, in the statement's words, printed after a scheme's closing balance.
      if (closed && !cur && loadRows >= 0 && !/Market Value on/i.test(t)) {
        // The KYC reminder that follows ("Please ensure that your account…") can break over rows anywhere.
        const reminder = /["“]?\s*Please(\s+ensure\b|\s*$)/i;
        if (loadRows > 0 && /^ensure that your account/i.test(t)) loadRows = -1;
        else if (loadRows === 0 ? LOAD_START.test(t) : !HEADING_ROW.test(t) && !DATE_AT_START.test(t) && loadRows < 9) {
          const cut = t.split(reminder)[0].replace(/"{2,}/g, '"').trim();
          if (cut) {
            const all = (closed.load ? closed.load.replace(/…$/, '') + ' ' : '') + cut;
            closed.load = all.length > 800 ? all.slice(0, 799).trimEnd() + '…' : all;
          }
          loadRows = reminder.test(t) ? -1 : loadRows + 1;
          if (loadRows > 0 || cut) continue;
        } else loadRows = -1;
      }

      if (!cur || headDone === false) {
        if (!folio) continue;                                  // page 1's name and address, legal notes
        const late = /Market Value on (\d{1,2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\d,.()-]+)/i.exec(t);
        if (late && closed && closed.valuation.value == null) { closed.valuation.value = num(late[2]); continue; }
        if (/^Nominee\s*1/i.test(t)) { if (pending.length) finishHeading(); if (cur) cur.nominees = nomineesOf(t); continue; }
        const ob = /Opening Unit Balance\s*:?\s*([\d,.()-]+)/i.exec(t);
        if (ob) {
          if (!cur || !headDone) finishHeading();
          cur.open_units = num(ob[1]);
          continue;
        }
        pending.push(t);
        continue;
      }

      // inside a scheme: after its heading, until "Closing Unit Balance"
      if (/^Nominee\s*\d/i.test(t)) { if (/^Nominee\s*1/i.test(t)) cur.nominees = nomineesOf(t); continue; }
      const ob = /Opening Unit Balance\s*:?\s*([\d,.()-]+)/i.exec(t);
      if (ob) { if (cur.open_units == null) cur.open_units = num(ob[1]); continue; }
      const mv = /Market Value on (\d{1,2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\d,.()-]+)/i.exec(t);
      if (mv) { cur.valuation.date = iso(mv[1]); cur.valuation.value = num(mv[2]); }
      const cb = /Closing Unit Balance\s*:?\s*([\d,.()-]+)/i.exec(t);
      if (cb) {
        cur.close_units = num(cb[1]);
        const nv = /NAV on (\d{1,2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\d,.()-]+)/i.exec(t);
        if (nv) { cur.valuation.date = iso(nv[1]); cur.valuation.nav = num(nv[2]); }
        const cv = /(?:Total )?Cost Value\s*:?\s*([\d,.()-]+)/i.exec(t);
        if (cv) cur.cost = num(cv[1]);
        headDone = false; pending = []; lastTxn = null;
        // stay on this folio: CAS can list several schemes under one folio heading
        closed = cur; cur = null; loadRows = 0;
        continue;
      }
      if (mv) continue;
      if (/No transactions during/i.test(t)) continue;
      if (DATE_AT_START.test(t)) {
        const tx = txnRow(row, cols);
        if (tx.amount == null && tx.units == null) {
          if (tx.balance != null && lastTxn && lastTxn.balance == null) lastTxn.balance = tx.balance;
          continue;                                           // a note such as "Address updated"
        }
        const type = kindOf(tx);
        if (!type) continue;
        lastTxn = { date: tx.date, type, amount: tx.amount, units: tx.units, nav: tx.nav, balance: tx.balance, desc: tx.desc.slice(0, 80) };
        cur.txns.push(lastTxn);
        continue;
      }
      // A row with no date: a wrapped description, or a balance printed a little apart.
      const onlyNums = row.items.every(i => NUM.test(i.s));
      if (onlyNums && lastTxn && row.items.length === 1) {
        if (lastTxn.balance == null) lastTxn.balance = num(row.items[0].s);
        continue;
      }
      if (lastTxn && !onlyNums && cols && row.items[0].x < cols.amount - 60 && row.items[0].x > 60) {
        lastTxn.desc = (lastTxn.desc + ' ' + t).trim().slice(0, 80);
      }
    }

    // Charges with no words (seen in re-saved or redacted copies): stamp duty is 0.005% of a same-day purchase.
    for (const h of holdings) {
      for (const x of h.txns) {
        if (x.type !== 'CHARGE') continue;
        const buy = h.txns.find(y => y.date === x.date && y.units > 0 && y.amount > 0);
        const stamp = buy && Math.abs(round((buy.amount + x.amount) * 0.00005, 2) - x.amount) <= 0.011;
        x.type = stamp ? 'STAMP_DUTY_TAX' : 'MISC';
      }
    }

    // Check every scheme: the opening units plus each transaction's units should
    // reach the closing units, and each printed running balance on the way.
    let bad = 0;
    for (const h of holdings) {
      let run = h.open_units || 0, rowsOff = 0;
      for (const x of h.txns) {
        if (x.units) run = round(run + x.units, 4);
        if (x.balance != null && Math.abs(run - x.balance) > UNITS_EPS) { rowsOff++; run = x.balance; }
      }
      h.units_ok = h.close_units != null && Math.abs(run - h.close_units) <= UNITS_EPS && rowsOff === 0;
      if (!h.units_ok) {
        bad++;
        warnings.push(`${h.name}: the units read from the statement don't add up to its closing balance of ${h.close_units ?? 'unknown'}. Some entries may not have been read.`);
      }
      if (h.close_units == null) warnings.push(`${h.name}: no closing balance was found.`);
      if (!h.isin) warnings.push(`${h.name}: no ISIN was found, so the page may not find its NAVs.`);
      h.txns.forEach(x => { delete x.balance; });
      delete h._bal;
    }
    if (!holdings.length) throw new CasError('no-schemes', "No funds were found in this statement.");

    const check = { schemes: holdings.length, unitsOk: holdings.length - bad };
    if (summary && summary.length) {
      const sumCost = summary.reduce((s, x) => s + (x.cost || 0), 0), sumValue = summary.reduce((s, x) => s + (x.value || 0), 0);
      const readValue = holdings.reduce((s, h) => s + (h.valuation.value || 0), 0);
      check.summaryValue = round(sumValue, 2);
      check.readValue = round(readValue, 2);
      check.summaryCost = round(sumCost, 2);
      if (Math.abs(sumValue - readValue) > 1) warnings.push(`The funds read are worth ${round(readValue, 2)} on the statement date, but its summary says ${round(sumValue, 2)}. Some funds may be missing.`);
    }
    return {
      format: FORMAT,
      created: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      source: 'pdf',
      statement_period: period || { from: null, to: null },
      cas_type: 'DETAILED',
      holdings,
      check,
      warnings
    };
  }

  /* ---------- the browser part: open the PDF with pdf.js ---------- */
  let lib = null;
  function pdfjs() {
    if (!lib) {
      const base = new URL('vendor/pdfjs/', document.baseURI).href;
      lib = import(base + 'pdf.min.js').then(m => {
        m.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js';
        return m;
      }).catch(e => { lib = null; throw e; });
    }
    return lib;
  }

  /* data: ArrayBuffer or Uint8Array of the PDF. progress(page, pages) is optional. */
  async function read(data, password, progress) {
    let m;
    try { m = await pdfjs(); } catch (e) { throw new CasError('no-reader', "The PDF reader didn't load. Check your connection and try again."); }
    const task = m.getDocument({
      data: data instanceof Uint8Array ? data : new Uint8Array(data),
      password: password || undefined,
      isEvalSupported: false, disableFontFace: true, useSystemFonts: false, enableXfa: false, stopAtErrors: false
    });
    let doc;
    try {
      doc = await task.promise;
    } catch (e) {
      if (e && e.name === 'PasswordException') {
        throw e.code === 2
          ? new CasError('wrong-password', "That password didn't open the PDF. It's the one you chose when you requested the statement.")
          : new CasError('needs-password', 'This PDF is locked. Type its password.');
      }
      throw new CasError('unreadable', "This file couldn't be opened as a PDF.");
    }
    try {
      const pages = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        pages.push(tc.items);
        page.cleanup();
        if (progress) progress(p, doc.numPages);
      }
      return parse(pages);
    } finally {
      doc.destroy();
    }
  }

  const api = { FORMAT, parse, read, lines, schemeHeading, kindOf, CasError };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CasReader = api;
})(typeof self !== 'undefined' ? self : this);
