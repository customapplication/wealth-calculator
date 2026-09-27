/* Tests for sheets/Archive.gs, run against the in-memory Drive in fake-google.js:
   node --test sheets/tests/*.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const crypto = require('crypto');
const { load } = require('./fake-google');

const SECRET = 'archive-secret-0123456789';
const NAVALL = 'Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date\n\n' +
  'Open Ended Schemes(Equity Scheme - Flexi Cap Fund)\n\nPPFAS Mutual Fund\n\n122639;INF879O01027;-;Parag Parikh Flexi Cap Fund;Direct Plan;Growth Option;92.1234;25-Sep-2026\n';

function setup(props = { SECRET }) {
  const g = load(props, 'Archive.gs');
  g.call = (action, body = {}) => g.post(Object.assign({ secret: SECRET, action }, body));
  return g;
}
const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const daily = (date, text = NAVALL) => ({ date, md5: md5(text), size: Buffer.byteLength(text), data: zlib.gzipSync(text).toString('base64') });
const part = (id, n, of, buf) => ({ id, part: n, parts: of, sha256: crypto.createHash('sha256').update(buf).digest('hex'), data: buf.toString('base64') });

test('refuses everything until SECRET is set, and a wrong secret', () => {
  const bare = load({}, 'Archive.gs');
  let r = bare.post({ secret: 'x'.repeat(20), action: 'status' });
  assert.equal(r.ok, false); assert.equal(r.setup, true); assert.equal(r.app, 'corpus-planner-archive');
  const g = setup();
  r = g.post({ secret: 'not-the-secret-000000', action: 'putDaily', ...daily('2026-09-26') });
  assert.equal(r.ok, false); assert.equal(r.badSecret, true);
  assert.deepEqual(g.drive.paths(), [], 'nothing written');
  assert.equal(g.lock.held, 0);
});

test("stores the day's NAVAll.txt, gzipped, by year and month", () => {
  const g = setup();
  const r = g.call('putDaily', daily('2026-09-26'));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.stored, true);
  assert.equal(r.name, 'NAVAll-2026-09-26.txt.gz');
  assert.equal(r.snapshot, null);
  assert.deepEqual(g.drive.paths(), ['SIPs archive/NAVAll/2026/09/NAVAll-2026-09-26.txt.gz']);
  const f = g.drive.file('SIPs archive/NAVAll/2026/09/NAVAll-2026-09-26.txt.gz');
  assert.equal(zlib.gunzipSync(f.getBlob().buf).toString(), NAVALL, 'unzips to the exact file');
  assert.equal(f.getMimeType(), 'application/gzip');
  assert.equal(JSON.parse(f.getDescription()).md5, md5(NAVALL));
});

test('the same file twice in a day is stored once; a changed one is kept as -2', () => {
  const g = setup();
  g.call('putDaily', daily('2026-09-26'));
  let r = g.call('putDaily', daily('2026-09-26'));
  assert.equal(r.stored, false); assert.equal(r.name, 'NAVAll-2026-09-26.txt.gz');
  r = g.call('putDaily', daily('2026-09-26', NAVALL + '999;X;-;Late Fund;Direct Plan;Growth Option;10;25-Sep-2026\n'));
  assert.equal(r.stored, true); assert.equal(r.name, 'NAVAll-2026-09-26-2.txt.gz');
  r = g.call('putDaily', daily('2026-10-02'));
  assert.equal(r.name, 'NAVAll-2026-10-02.txt.gz');
  assert.deepEqual(g.drive.paths(), [
    'SIPs archive/NAVAll/2026/09/NAVAll-2026-09-26-2.txt.gz',
    'SIPs archive/NAVAll/2026/09/NAVAll-2026-09-26.txt.gz',
    'SIPs archive/NAVAll/2026/10/NAVAll-2026-10-02.txt.gz'
  ]);
});

test('turns down a bad date, a missing checksum or an empty file', () => {
  const g = setup();
  assert.match(g.call('putDaily', { ...daily('2026-09-26'), date: '26-09-2026' }).error, /Not a date/);
  assert.match(g.call('putDaily', { ...daily('2026-09-26'), md5: '' }).error, /checksum/);
  assert.match(g.call('putDaily', { ...daily('2026-09-26'), data: '' }).error, /No file/);
  assert.deepEqual(g.drive.paths(), []);
});

test('a history copy arrives in parts and appears only once complete', () => {
  const g = setup();
  const bufs = [Buffer.from('part one'), Buffer.from('part two'), Buffer.from('part three')];
  bufs.forEach((b, i) => assert.equal(g.call('snapshotPut', part('2026-10-01', i + 1, 3, b)).ok, true));
  assert.equal(g.call('putDaily', daily('2026-10-01')).snapshot, null, 'not a copy until committed');
  const r = g.call('snapshotCommit', { id: '2026-10-01', parts: 3, manifest: { funds: 3947 } });
  assert.equal(r.ok, true, r.error);
  const paths = g.drive.paths().filter(p => p.includes('NAV history'));
  assert.deepEqual(paths, [
    'SIPs archive/NAV history/NAV history 2026-10-01/manifest.json',
    'SIPs archive/NAV history/NAV history 2026-10-01/nav-history-2026-10-01-part1of3.tar.gz',
    'SIPs archive/NAV history/NAV history 2026-10-01/nav-history-2026-10-01-part2of3.tar.gz',
    'SIPs archive/NAV history/NAV history 2026-10-01/nav-history-2026-10-01-part3of3.tar.gz'
  ]);
  const p2 = g.drive.file('SIPs archive/NAV history/NAV history 2026-10-01/nav-history-2026-10-01-part2of3.tar.gz');
  assert.equal(p2.getBlob().buf.toString(), 'part two');
  assert.deepEqual(g.call('putDaily', daily('2026-10-02')).snapshot, { id: '2026-10-01' });
});

test('a damaged part is refused, and a commit with a part missing changes nothing', () => {
  const g = setup();
  const bad = part('2026-10-01', 1, 2, Buffer.from('abc'));
  bad.sha256 = '0'.repeat(64);
  assert.match(g.call('snapshotPut', bad).error, /damaged/);
  g.call('snapshotPut', part('2026-10-01', 1, 2, Buffer.from('abc')));
  const r = g.call('snapshotCommit', { id: '2026-10-01', parts: 2 });
  assert.equal(r.ok, false); assert.match(r.error, /missing.*2/);
  assert.equal(g.call('status').snapshot, null);
});

test('a retried part replaces the first try', () => {
  const g = setup();
  g.call('snapshotPut', part('2026-10-01', 1, 1, Buffer.from('first try')));
  g.call('snapshotPut', part('2026-10-01', 1, 1, Buffer.from('second try')));
  g.call('snapshotCommit', { id: '2026-10-01', parts: 1 });
  const f = g.drive.file('SIPs archive/NAV history/NAV history 2026-10-01/nav-history-2026-10-01-part1of1.tar.gz');
  assert.equal(f.getBlob().buf.toString(), 'second try');
});

test('keeps the two newest history copies and clears half-sent ones', () => {
  const g = setup();
  for (const id of ['2026-08-01', '2026-09-01', '2026-10-01']) {
    g.call('snapshotPut', part(id, 1, 1, Buffer.from(id)));
    assert.equal(g.call('snapshotCommit', { id, parts: 1 }).ok, true);
  }
  g.call('snapshotPut', part('2026-10-15', 1, 2, Buffer.from('half')));     // never committed
  g.call('snapshotPut', part('2026-11-01', 1, 1, Buffer.from('nov')));
  const r = g.call('snapshotCommit', { id: '2026-11-01', parts: 1 });
  assert.deepEqual(r.trashed, ['NAV history 2026-09-01']);
  const folders = [...new Set(g.drive.paths().filter(p => p.includes('NAV history/')).map(p => p.split('/')[2]))];
  assert.deepEqual(folders, ['NAV history 2026-10-01', 'NAV history 2026-11-01']);
  assert.deepEqual(g.call('status').snapshot, { id: '2026-11-01' });
});

test('finds its folder by id after a rename, and makes it again if it was deleted', () => {
  const g = setup();
  g.call('putDaily', daily('2026-09-26'));
  const root = g.drive.getRootFolder().folders[0];
  root.setName('My AMFI files');
  g.call('putDaily', daily('2026-09-27'));
  assert.equal(root.folders[0].folders[0].folders[0].files.length, 2, 'still one folder, renamed');
  root.setTrashed(true);
  g.call('putDaily', daily('2026-09-28'));
  assert.deepEqual(g.drive.paths(), ['SIPs archive/NAVAll/2026/09/NAVAll-2026-09-28.txt.gz']);
});

test('an unknown action or bad JSON is reported, not thrown', () => {
  const g = setup();
  assert.match(g.call('deleteEverything').error, /Unknown action/);
  const r = JSON.parse(g.ctx.doPost({ postData: { contents: '{nope' } }).getContent());
  assert.equal(r.ok, false); assert.equal(r.app, 'corpus-planner-archive');
  assert.equal(g.lock.held, 0);
});
