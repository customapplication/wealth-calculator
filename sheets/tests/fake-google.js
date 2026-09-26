/* An in-memory stand-in for the Apps Script services Code.gs and Archive.gs use,
   so they can be tested with plain Node. It copies the Sheets behaviour the script depends on:
   getRange() throws past the sheet's edge, a new tab is 1000 x 26, a value typed
   into an ordinary cell is read the way Sheets reads typing (= and + start a
   formula, digits become a number, 2026-09-25 becomes a date), and a cell
   formatted as plain text (@) keeps exactly what was written. Its Drive keeps
   trashed items in folder listings, as DriveApp does, and byte arrays are
   signed (-128..127), as Apps Script's are. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

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

/* ---------- Drive ---------- */
const toBuf = bytes => Buffer.from(bytes.map(b => b & 255));
const signed = buf => Array.from(buf, b => (b > 127 ? b - 256 : b));
const iter = arr => { let i = 0; const a = arr.slice(); return { hasNext: () => i < a.length, next: () => a[i++] }; };

class Blob {
  constructor(bytes, type, name) { this.buf = Buffer.isBuffer(bytes) ? bytes : toBuf(bytes); this.type = type || null; this.name = name || null; }
  getBytes() { return signed(this.buf); }
  getContentType() { return this.type; }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getDataAsString() { return this.buf.toString('utf8'); }
}

let driveIds = 0;
class DriveFile {
  constructor(blob, parent) { this.id = 'file' + (++driveIds); this.name = blob.getName(); this.blob = blob; this.parent = parent; this.description = ''; this.trashed = false; }
  getId() { return this.id; }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getSize() { return this.blob.buf.length; }
  getBlob() { return this.blob; }
  getMimeType() { return this.blob.getContentType(); }
  getDescription() { return this.description; }
  setDescription(d) { this.description = d; return this; }
  isTrashed() { return this.trashed; }
  setTrashed(t) { this.trashed = !!t; return this; }
}
class DriveFolder {
  constructor(name, parent) { this.id = 'folder' + (++driveIds); this.name = name; this.parent = parent; this.folders = []; this.files = []; this.trashed = false; }
  getId() { return this.id; }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getUrl() { return 'https://drive.google.com/drive/folders/' + this.id; }
  isTrashed() { return this.trashed; }
  setTrashed(t) { this.trashed = !!t; return this; }
  getFolders() { return iter(this.folders); }
  getFoldersByName(n) { return iter(this.folders.filter(f => f.name === n)); }
  getFiles() { return iter(this.files); }
  getFilesByName(n) { return iter(this.files.filter(f => f.name === n)); }
  createFolder(n) { const f = new DriveFolder(n, this); this.folders.push(f); return f; }
  createFile(blob) { const f = new DriveFile(blob, this); this.files.push(f); return f; }
  inTrash() { let x = this; while (x) { if (x.trashed) return true; x = x.parent; } return false; }
}
class Drive {
  constructor() { this.root = new DriveFolder('My Drive', null); }
  getRootFolder() { return this.root; }
  all() { const out = []; const walk = f => { out.push(f); f.folders.forEach(walk); f.files.forEach(x => out.push(x)); }; walk(this.root); return out; }
  getFolderById(id) { const f = this.all().find(x => x.id === id && x instanceof DriveFolder); if (!f) throw new Error('No item with the given ID could be found.'); return f; }
  /** Test helper: every file not in the trash, as 'folder/sub/name'. */
  paths() {
    const out = [];
    const walk = (f, pre) => {
      if (f.trashed) return;
      f.files.forEach(x => { if (!x.trashed) out.push(pre + x.name); });
      f.folders.forEach(d => walk(d, pre + d.name + '/'));
    };
    walk(this.root, '');
    return out.sort();
  }
  file(path) {
    let f = this.root; const parts = path.split('/'); const name = parts.pop();
    for (const p of parts) f = f.folders.find(d => d.name === p && !d.trashed);
    return f && f.files.find(x => x.name === name && !x.trashed);
  }
}

class Properties {
  constructor(init) { this.m = new Map(Object.entries(init || {})); }
  getProperty(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setProperty(k, v) { this.m.set(k, String(v)); return this; }
  deleteProperty(k) { this.m.delete(k); return this; }
}

/** A fresh copy of a script (Code.gs by default) with its own Sheet, Drive and script properties. */
function load(props, file = 'Code.gs') {
  const ss = new Spreadsheet();
  const drive = new Drive();
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
    DriveApp: drive,
    Utilities: {
      formatDate: d => d.toISOString(),
      base64Decode: s => signed(Buffer.from(s, 'base64')),
      newBlob: (data, type, name) => new Blob(typeof data === 'string' ? Buffer.from(data, 'utf8') : data, type, name),
      DigestAlgorithm: { MD5: 'md5', SHA_256: 'sha256' },
      computeDigest: (alg, bytes) => signed(crypto.createHash(alg).update(typeof bytes === 'string' ? Buffer.from(bytes) : toBuf(bytes)).digest())
    },
    Session: { getScriptTimeZone: () => 'Asia/Kolkata' },
    console
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx, { filename: file });
  /** POST a body the way the site does; returns the parsed JSON answer. */
  const post = body => {
    const out = ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
    if (out.mime !== 'application/json') throw new Error('Answer was not marked as JSON');
    return JSON.parse(out.getContent());
  };
  return { ctx, ss, drive, properties, lock, logs, post };
}

module.exports = { load, typed };
