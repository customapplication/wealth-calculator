/* The CAS reader (site/js/cas.js) against a made-up statement laid out the way
   pdf.js reads a real CAMS + KFintech one: pieces of text with x/y positions,
   headings that wrap, an ISIN drawn in pieces, balances a point off their row,
   and the registrar's name on a row of its own. Every name, PAN, folio and
   amount here is invented. */
const test = require('node:test');
const assert = require('node:assert/strict');
const cas = require('../site/js/cas.js');

const W = 4.2;                                   // rough width of one character at the statement's font size
const it = (x, y, s, w) => ({ str: s, transform: [1, 0, 0, 1, x, y], width: w ?? s.length * W });
const f2 = v => v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/(\d)(?=(\d{3})+\.)/g, '$1,');
const fmt = (v, dp) => {
  const [i, d] = Math.abs(v).toFixed(dp).split('.');
  const s = i.replace(/\B(?=(\d{3})+$)/g, ',') + (d ? '.' + d : '');
  return v < 0 ? `(${s})` : s;
};

/* A table row the way CAMS draws it: date, words, then numbers centred under their column headings. */
function txn(y, date, desc, amount, units, price, balance, opts = {}) {
  const out = [it(53, y, date, 34)];
  if (desc) out.push(it(96, opts.descY ?? y, desc));
  const num = (mid, s, dy = 0) => out.push(it(mid - (s.length * W) / 2, y + dy, s, s.length * W));
  if (amount != null) num(364, fmt(amount, 2));
  if (units != null) num(424, fmt(units, 3));
  if (price != null) num(477, fmt(price, 4));
  if (balance != null) num(549, fmt(balance, 3), opts.balanceDy || 0);
  return out;
}
const header = y => [it(53, y, 'Date', 15), it(96, y, 'Transaction', 39), it(351, y, 'Amount', 26), it(414, y, 'Units', 18), it(468, y, 'Price', 17), it(533, y, 'Unit', 15),
  it(363, y - 9, '(INR)', 14), it(472, y - 9, '(INR)', 14), it(533, y - 8, 'Balance', 27)];
const pageTop = () => [it(176, 737, 'Consolidated Account Statement'), it(251, 724, '01-Apr-2019 To 31-Mar-2026')];
const pageFoot = n => [it(519, 60, `Page ${n} of 2`), it(580, 41, 'CAMSCASWS-000000000000 Version:V3.5 Live-1018')];

function statement({ dropRow = false } = {}) {
  // Alpha: two SIPs, one redemption. Beta: a switch in, IDCW, an STP out, a purchase; then a second scheme on the same folio.
  const alphaValue = +(148 * 70.9459).toFixed(2), betaValue = +(1195.455 * 17.5665).toFixed(2), smallValue = 2200;
  const p1 = [
    ...pageTop(),
    it(58, 693, 'Email Id: test.person@example.com'), it(58, 676, 'Test Person'), it(58, 650, '12 Example Road, Pune'), it(58, 600, 'Mobile: +910000000000'),
    it(314, 694, 'This Consolidated Account Statement is brought to you as an investor'),
    it(265, 566, 'PORTFOLIO SUMMARY'), it(288, 552, 'Cost Value'), it(453, 552, 'Market Value'),
    it(64, 531, 'Alpha Mutual Fund'), it(290, 531, '7,400.00'), it(459, 531, f2(alphaValue)),
    it(64, 517, 'Beta Mutual Fund'), it(290, 517, '12,800.00'), it(459, 517, f2(betaValue + smallValue)),
    it(130, 503, 'Total'), it(288, 503, '20,200.00'), it(457, 503, f2(alphaValue + betaValue + smallValue)),
    ...header(336),
    it(53, 314, 'Alpha Mutual Fund'),
    it(53, 301, 'Folio No:'), it(111, 301, '12345678 / 90'), it(354, 301, 'PAN:'), it(369, 301, 'ABCDE1234F'), it(502, 301, 'KYC: OK PAN: OK'),
    it(53, 280, 'A12-Alpha Flexi Cap Fund - Direct Plan - Growth (formerly Alpha Equity Fund) (Non'), it(509, 281, 'Registrar : CAMS'),
    it(53, 272, '-Demat) - ISIN:', 60), it(116, 272, 'INF', 12.6), it(128.6, 272, '999', 12.6), it(141.2, 272, 'A', 4.2), it(145.4, 272, '01234', 21), it(170, 272, '(Advisor: DIRECT)'),
    it(55, 262, 'Nominee 1:'), it(100, 262, 'MADE UP NOMINEE'), it(245, 262, 'Nominee 2:'), it(290, 262, 'SECOND MADEUP'), it(414, 262, 'Nominee 3:'),
    it(475, 252, 'Opening Unit Balance: 0.000'),
    ...txn(243, '10-Apr-2019', 'SIP Purchase - Instalment 1/120 - via Internet', 4999.75, 100, 49.9975, 100),
    ...txn(235, '10-Apr-2019', '*** Stamp Duty ***', 0.25),
    ...(dropRow ? [] : txn(226, '10-May-2019', 'SIP Purchase - Instalment 2/120 - via Internet', 4999.75, 98, 51.0179, 198, { balanceDy: 1 })),
    ...txn(218, '10-May-2019', '', 0.25),
    ...txn(209, '15-Jun-2019', 'Redemption - ELECTRONIC PAYOUT', -2600, -50, 52, 148),
    ...txn(201, '15-Jun-2019', '*** STT Paid ***', 0.03),
    ...txn(192, '20-Jun-2019', '*** Address Updated from KRA Data ***'),
    it(53, 180, 'Closing Unit Balance: 148.000'), it(180, 180, 'NAV on 31-Mar-2026: INR 70.9459'), it(300, 180, 'Total Cost Value: 7,400.00'),
    it(426, 181, `Market Value on 31-Mar-2026: INR ${f2(alphaValue)}`),
    it(53, 170, 'Entry Load: Nil. Exit Load: 1% if redeemed within 1 year.'),
    ...pageFoot(1)
  ];
  const p2 = [
    ...pageTop(), ...header(696),
    it(53, 677, 'Beta Mutual Fund'),
    it(53, 668, 'Folio No:'), it(111, 668, '9876543 / 21'), it(354, 668, 'PAN:'), it(369, 668, 'ABCDE1234F'), it(502, 668, 'KYC: OK PAN: OK'),
    it(527, 662, 'Registrar :'), it(53, 660, 'B7GR-BETA HYBRID FUND - REGULAR GROWTH (Non Demat) - ISIN: INF000B01AA1(Advisor: ARN-00001)'), it(529, 654, 'KFINTECH'),
    it(55, 642, 'Nominee 1:'), it(245, 642, 'Nominee 2:'), it(414, 642, 'Nominee 3:'),
    it(475, 632, 'Opening Unit Balance: 0.000'),
    ...txn(623, '01-Jan-2020', 'Switch In - From Beta Liquid Fund', 10000, 1000, 10, 1000),
    ...txn(615, '01-Jan-2020', '*** Stamp Duty ***', 0.5),
    ...txn(606, '15-Mar-2021', 'IDCW Reinvestment @ Rs.0.50 per unit', 500, 45.455, 11, 1045.455),
    ...txn(598, '15-Mar-2022', 'IDCW Paid @ Rs.0.40 per unit', 418.18),
    ...txn(589, '10-Apr-2023', 'Systematic Transfer Plan Out - To Beta Small Cap Fund', -1200, -100, 12, 945.455),
    ...txn(580, '11-Apr-2023', 'Purchase - via', 3000, 250, 12, 1195.455, { descY: 581 }),
    it(96, 572, 'Internet (NEFT)'),
    it(53, 562, 'Closing Unit Balance: 1,195.455'), it(180, 562, 'NAV on 31-Mar-2026: INR 17.5665'), it(300, 562, 'Total Cost Value: 10,800.00'),
    it(426, 556, `Market Value on 31-Mar-2026: INR ${f2(betaValue)}`),
    it(53, 549, 'Current Load Structure: Exit Load: 1% if redeemed on or before 365 days'),
    it(53, 543, 'from the date of allotment. Nil after that.'),
    it(53, 537, '"Please ensure that your account information is up to date."'),
    it(527, 532, 'Registrar :'), it(53, 530, 'B9DG-Beta Small Cap Fund - Direct Plan - Growth (Non Demat) - ISIN: INF000B01BB9'), it(529, 524, 'KFINTECH'),
    it(55, 512, 'Nominee 1:'),
    it(475, 502, 'Opening Unit Balance: 0.000'),
    ...txn(493, '05-May-2024', 'Systematic Investment (1/60)', 1999.9, 20, 99.995, 20),
    ...txn(485, '05-May-2024', '*** Stamp Duty ***', 0.1),
    it(53, 470, 'Closing Unit Balance: 20.000'), it(180, 470, 'NAV on 31-Mar-2026: INR 110.00'), it(300, 470, 'Total Cost Value: 2,000.00'),
    it(426, 471, 'Market Value on 31-Mar-2026: INR 2,200.00'),
    ...pageFoot(2)
  ];
  return [p1, p2];
}

test('reads every fund, transaction and check from a statement', () => {
  const out = cas.parse(statement());
  assert.equal(out.format, 'mf-corpus-planner/cas-v1');
  assert.deepEqual(out.statement_period, { from: '2019-04-01', to: '2026-03-31' });
  assert.deepEqual(out.warnings, []);
  assert.equal(out.holdings.length, 3);
  assert.equal(out.check.unitsOk, 3);
  assert.ok(Math.abs(out.check.summaryValue - out.check.readValue) < 0.02);

  const [alpha, beta, small] = out.holdings;
  assert.equal(alpha.isin, 'INF999A01234', 'an ISIN drawn in pieces is joined');
  assert.equal(alpha.name, 'Alpha Flexi Cap Fund - Direct Plan - Growth', 'code, old name and demat note are dropped');
  assert.equal(alpha.amc, 'Alpha Mutual Fund');
  assert.equal(alpha.folio, '12345678/90', 'the whole folio, spaces taken out');
  assert.equal(alpha.rta, 'CAMS');
  assert.equal(alpha.advisor, 'DIRECT');
  assert.equal(alpha.demat, false);
  assert.equal(alpha.kyc, 'OK');
  assert.equal(alpha.pan_ok, true);
  assert.deepEqual(alpha.nominees, ['MADE UP NOMINEE', 'SECOND MADEUP']);
  assert.equal(alpha.load, 'Entry Load: Nil. Exit Load: 1% if redeemed within 1 year.');
  assert.equal(alpha.close_units, 148);
  assert.equal(alpha.cost, 7400);
  assert.deepEqual(alpha.valuation, { date: '2026-03-31', nav: 70.9459, value: +(148 * 70.9459).toFixed(2) });
  assert.deepEqual(alpha.txns.map(t => t.type), ['PURCHASE_SIP', 'STAMP_DUTY_TAX', 'PURCHASE_SIP', 'STAMP_DUTY_TAX', 'REDEMPTION', 'STT_TAX']);
  assert.deepEqual(alpha.txns[2], { date: '2019-05-10', type: 'PURCHASE_SIP', amount: 4999.75, units: 98, nav: 51.0179, desc: 'SIP Purchase - Instalment 2/120 - via Internet' });
  assert.equal(alpha.txns[4].amount, -2600);
  assert.equal(alpha.txns[4].units, -50);

  assert.equal(beta.rta, 'KFINTECH', 'the registrar on a row of its own');
  assert.equal(beta.isin, 'INF000B01AA1');
  assert.equal(beta.name, 'BETA HYBRID FUND - REGULAR GROWTH');
  assert.equal(beta.advisor, 'ARN-00001');
  assert.deepEqual(beta.nominees, [], 'no nominee on this folio');
  assert.equal(beta.load, 'Current Load Structure: Exit Load: 1% if redeemed on or before 365 days from the date of allotment. Nil after that.',
    'wording over two rows, without the reminder that follows');
  assert.deepEqual(beta.txns.map(t => t.type), ['SWITCH_IN', 'STAMP_DUTY_TAX', 'DIVIDEND_REINVEST', 'DIVIDEND_PAYOUT', 'SWITCH_OUT', 'PURCHASE']);
  assert.equal(beta.txns[5].desc, 'Purchase - via Internet (NEFT)', 'a wrapped description is joined');
  assert.equal(beta.valuation.value, +(1195.455 * 17.5665).toFixed(2), 'a market value printed below the closing row');

  assert.equal(small.folio, beta.folio, 'a second scheme under the same folio heading');
  assert.equal(small.name, 'Beta Small Cap Fund - Direct Plan - Growth');
  assert.deepEqual(small.txns.map(t => t.type), ['PURCHASE_SIP', 'STAMP_DUTY_TAX']);
  assert.equal(small.close_units, 20);
  assert.equal(small.load, null);
  assert.equal(small.folio, '9876543/21');
});

test("keeps nothing personal about the investor", () => {
  const json = JSON.stringify(cas.parse(statement()));
  for (const s of ['ABCDE1234F', 'test.person', 'Test Person', 'Example Road', '0000000000', 'Mobile']) {
    assert.ok(!json.includes(s), `${s} isn't in the result`);
  }
});

test('says so when the units do not add up', () => {
  const out = cas.parse(statement({ dropRow: true }));
  const alpha = out.holdings[0];
  assert.equal(alpha.units_ok, false);
  assert.equal(out.check.unitsOk, 2);
  assert.match(out.warnings.join('\n'), /Alpha Flexi Cap Fund.*don't add up/);
});

test('turns away statements it cannot use', () => {
  const code = pages => { try { cas.parse(pages); return 'parsed'; } catch (e) { assert.ok(e instanceof cas.CasError); return e.code; } };
  assert.equal(code([[]]), 'empty');
  assert.equal(code([[it(100, 700, 'Consolidated Account Summary'), it(100, 680, 'Folio No: 1')]]), 'summary');
  assert.equal(code([[it(100, 700, 'NSDL Consolidated Account Statement'), it(100, 680, 'Holdings')]]), 'depository');
  assert.equal(code([[it(100, 700, 'Electricity bill'), it(100, 680, 'Amount due 1,234.00')]]), 'not-cas');
});

test('rows are rebuilt from pieces', () => {
  const rows = cas.lines([it(96, 508, 'Net SIP Purchase'), it(538, 508, '519.804', 22), it(53, 507, '06-Jan-2026', 34), it(352, 507, '1,999.90', 25),
    it(53, 490, 'INF', 12.6), it(65.6, 490, '209', 12.6), it(80, 490, 'K01140')]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, '06-Jan-2026 Net SIP Purchase 1,999.90 519.804');
  assert.equal(rows[1].text, 'INF209 K01140', 'touching pieces join, a gap keeps its space');
});

test('names each kind of transaction', () => {
  const k = (desc, amount, units) => cas.kindOf({ desc, amount, units });
  assert.equal(k('Purchase', 1000, 10), 'PURCHASE');
  assert.equal(k('Sys. Investment Invest Easy (15/120)', 1000, 10), 'PURCHASE_SIP');
  assert.equal(k('Systematic Investment ISIP (19/120)', 1000, 10), 'PURCHASE_SIP');
  assert.equal(k('Redemption', -1000, -10), 'REDEMPTION');
  assert.equal(k('SWP Redemption', -1000, -10), 'REDEMPTION');
  assert.equal(k('Switch-Out - To Liquid Fund', -1000, -10), 'SWITCH_OUT');
  assert.equal(k('Switch Out - Merger', -1000, -10), 'SWITCH_OUT_MERGER');
  assert.equal(k('Lateral Shift In (Merger)', null, 10), 'SWITCH_IN_MERGER');
  assert.equal(k('Purchase Reversal - Cheque returned', -1000, -10), 'REVERSAL');
  assert.equal(k('IDCW Reinvestment', 50, 0.5), 'DIVIDEND_REINVEST');
  assert.equal(k('Dividend Payout', 50, null), 'DIVIDEND_PAYOUT');
  assert.equal(k('*** TDS on above ***', 5, null), 'TDS_TAX');
  assert.equal(k('Segregated Portfolio units', null, 10), 'SEGREGATION');
  assert.equal(k('Bonus units', null, 10), 'BONUS');
  assert.equal(k('Transmission - In', null, 10), 'TRANSFER_IN');
  assert.equal(k('*** Address Updated from KRA Data ***', null, null), null);
});
