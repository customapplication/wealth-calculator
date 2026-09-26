/* An in-memory stand-in for the Apps Script services Code.gs uses, so it can be
   tested with plain Node. It copies the Sheets behaviour the script depends on:
   getRange() throws past the sheet's edge, a new tab is 1000 x 26, a value typed
   into an ordinary cell is read the way Sheets reads typing (= and + start a
   formula, digits become a number, 2026-09-25 becomes a date), and a cell
   formatted as plain text (@) keeps exactly what was written. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class Range {
  constructor(sh, row, col, nr, nc) {
    if (row < 1 || col < 1 || nr < 1 || nc < 1 || row + nr - 1 > sh.maxRows || col + nc - 1 > sh.maxCols) {
      throw new Error(`The coordinates of the range are outside the dimensions of the sheet (${sh.name}: ${row},${col} ${nr}x${nc} in ${sh.maxRows}x${sh.maxCols})`);
    }
    Object.assign(this, { sh, row, col, nr, nc });
  }
  each(fn) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.row + i, this.col + j, i, j); }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { const r = []; for (let j = 0; j < this.nc; j++) r.push(this.sh.get(this.row + i, this.col + j)); out.push(r); } return out; }
  setValues(v) {
    if (!Array.isArray(v) || v.length !== this.nr || v.some(r => !Array.isArray(r) || r.length !== this.nc)) {
      throw new Error(`The number of rows or columns in the data does not match the range (${this.nr}x${this.nc})`);
    }
    this.each((r, c, i, j) => this.sh.put(r, c, v[i][j]));
    return this;
  }
  setNumberFormat(f) { this.each((r, c) => { this.sh.fmt.set(`${r},${c}`, f); }); return this; }
  setNumberFormats(f) {
    if (f.length !== this.nr || f.some(r => r.length !== this.nc)) throw new Error('Number formats do not match the range');
    this.each((r, c, i, j) => { this.sh.fmt.set(`${r},${c}`, f[i][j]); }); return this;
  }
  getNumberFormats() { const out = []; for (let i = 0; i < this.nr; i++) { const r = []; for (let j = 0; j < this.nc; j++) r.push(this.sh.fmt.get(`${this.row + i},${this.col + j}`) || ''); out.push(r); } return out; }
  setFontWeight() { return this; }
}

let sheetIds = 0;
class Sheet {
  constructor(name) { this.name = name; this.id = ++sheetIds; this.maxRows = 1000; this.maxCols = 26; this.cells = new Map(); this.fmt = new Map(); this.hidden = false; this.frozen = 0; }
  get(r, c) { const v = this.cells.get(`${r},${c}`); return v === undefined ? '' : v; }
  put(r, c, v) {
    const f = this.fmt.get(`${r},${c}`);
    if (v === null || v === undefined || v === '') { this.cells.delete(`${r},${c}`); return; }
    if (typeof v === 'string' && f !== '@') v = typed(v);
    this.cells.set(`${r},${c}`, v);
  }
  getRange(row, col, nr = 1, nc = 1) { return new Range(this, row, col, nr, nc); }
  getLastRow() { let m = 0; for (const k of this.cells.keys()) m = Math.max(m, +k.split(',')[0]); return m; }
  getLastColumn() { let m = 0; for (const k of this.cells.keys()) m = Math.max(m, +k.split(',')[1]); return m; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  shift(axis, from, by) {
    for (const map of [this.cells, this.fmt]) {
      const moved = new Map();
      for (const [k, v] of map) {
        const [r, c] = k.split(',').map(Number);
        const p = axis === 'r' ? r : c;
        if (by < 0 && p >= from && p < from - by) continue;          // deleted
        const np = p >= from ? p + by : p;
        moved.set(axis === 'r' ? `${np},${c}` : `${r},${np}`, v);
      }
      map.clear(); for (const [k, v] of moved) map.set(k, v);
    }
  }
  insertRowsAfter(after, n) { this.shift('r', after + 1, n); this.maxRows += n; return this; }
  deleteRows(start, n) { if (start + n - 1 > this.maxRows || this.maxRows - n < 1) throw new Error('deleteRows out of range'); this.shift('r', start, -n); this.maxRows -= n; }
  insertColumnsAfter(after, n) { this.shift('c', after + 1, n); this.maxCols += n; return this; }
  deleteColumns(start, n) { if (start + n - 1 > this.maxCols || this.maxCols - n < 1) throw new Error('deleteColumns out of range'); this.shift('c', start, -n); this.maxCols -= n; }
  clear() { this.cells.clear(); this.fmt.clear(); return this; }
  hideSheet() { this.hidden = true; return this; }
  showSheet() { this.hidden = false; return this; }
  isSheetHidden() { return this.hidden; }
  setFrozenRows(n) { this.frozen = n; }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getSheetId() { return this.id; }
  /** Test helper: the tab as rows of values, header included. */
  dump() { const n = this.getLastRow(), w = this.getLastColumn(); return n ? this.getRange(1, 1, n, w).getValues() : []; }
}

/** How Sheets reads a string written into an ordinary (not plain-text) cell. */
function typed(s) {
  if (s.startsWith("'")) return s.slice(1);
  if (/^[=+]/.test(s) || /^-\D/.test(s)) return '#ERROR!';
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00');
  return s;
}

class Spreadsheet {
  constructor() { this.sheets = [new Sheet('Sheet1')]; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  getSheets() { return this.sheets.slice(); }
  insertSheet(name, index) {
    if (this.getSheetByName(name)) throw new Error(`A sheet with the name "${name}" already exists.`);
    const s = new Sheet(name);
    if (index === undefined || index < 0 || index > this.sheets.length) this.sheets.push(s); else this.sheets.splice(index, 0, s);
    return s;
  }
  deleteSheet(sh) {
    if (this.sheets.length === 1) throw new Error("You can't remove all the sheets in a document.");
    this.sheets = this.sheets.filter(s => s !== sh);
  }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/TEST-SHEET/edit'; }
  getId() { return 'TEST-SHEET'; }
  getName() { return 'Test Sheet'; }
}

class Properties {
  constructor(init) { this.m = new Map(Object.entries(init || {})); }
  getProperty(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setProperty(k, v) { this.m.set(k, String(v)); return this; }
  deleteProperty(k) { this.m.delete(k); return this; }
}

/** A fresh Code.gs with its own Sheet and script properties. */
function load(props) {
  const ss = new Spreadsheet();
  const properties = new Properties(props);
  const lock = { held: 0, waitLock() { this.held++; }, releaseLock() { this.held--; } };
  const logs = [];
  const ctx = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss, openById: () => ss, flush() {},
      getUi() { throw new Error('Cannot call SpreadsheetApp.getUi() from this context.'); }
    },
    PropertiesService: { getScriptProperties: () => properties },
    LockService: { getScriptLock: () => lock },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: s => ({ s, mime: null, setMimeType(m) { this.mime = m; return this; }, getContent() { return this.s; } })
    },
    Logger: { log: m => logs.push(String(m)) },
    Utilities: { formatDate: d => d.toISOString() },
    Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
    console
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  /** POST a body the way the site does; returns the parsed JSON answer. */
  const post = body => {
    const out = ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
    if (out.mime !== 'application/json') throw new Error('Answer was not marked as JSON');
    return JSON.parse(out.getContent());
  };
  return { ctx, ss, properties, lock, logs, post };
}

module.exports = { load, typed };
