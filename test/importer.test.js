'use strict';
// Importer on fake profiles (never the real browsers of this computer).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { chromiumBookmarks, chromiumHistory, firefoxData } = require('../src/main/importer');
const { Bookmarks, sanitizeBookmarks } = require('../src/main/bookmarks');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'techin-imptest-'));

test('Chromium: bookmarks bar, other bookmarks and history', () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, 'Bookmarks'),
    JSON.stringify({
      roots: {
        bookmark_bar: { children: [{ type: 'url', name: 'YouTube', url: 'https://www.youtube.com/' }, { type: 'folder', name: 'İş', children: [{ type: 'url', name: 'Mail', url: 'https://mail.example.com/' }] }] },
        other: { children: [{ type: 'url', name: 'Diğer', url: 'https://other.example.com/' }] },
        synced: { children: [] }
      }
    })
  );
  const db = new DatabaseSync(path.join(dir, 'History'));
  db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER)');
  // 2026-01-01T00:00:00Z in Chromium time (µs since 1601)
  const t = (BigInt(Date.UTC(2026, 0, 1)) + 11644473600000n) * 1000n;
  db.prepare('INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, 0)').run('https://example.com/a', 'A', 5, t);
  db.close();
  const bm = chromiumBookmarks(dir);
  assert.equal(bm[0].url, 'https://www.youtube.com/');
  assert.equal(bm[1].type, 'folder');
  assert.equal(bm[1].children[0].url, 'https://mail.example.com/');
  assert.equal(bm[2].title, 'Diğer yer imleri');
  const hist = chromiumHistory(dir, 100);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].last, Date.UTC(2026, 0, 1));
  assert.equal(hist[0].visits, 5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Firefox / Zen: toolbar, menu folders and history from places.sqlite', () => {
  const dir = tmp();
  const db = new DatabaseSync(path.join(dir, 'places.sqlite'));
  db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, hidden INTEGER, last_visit_date INTEGER);
           CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT, guid TEXT);`);
  const p = db.prepare('INSERT INTO moz_places (id, url, title, visit_count, hidden, last_visit_date) VALUES (?, ?, ?, ?, 0, ?)');
  p.run(1, 'https://twitter.com/', 'X', 3, Date.UTC(2026, 1, 2) * 1000);
  p.run(2, 'place:sort=8', 'smart', 0, null);
  const b = db.prepare('INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, guid) VALUES (?, ?, ?, ?, ?, ?, ?)');
  b.run(1, 2, null, 0, 0, '', 'root________');
  b.run(2, 2, null, 1, 0, 'toolbar', 'toolbar_____');
  b.run(3, 2, null, 1, 1, 'menu', 'menu________');
  b.run(4, 1, 1, 2, 0, 'X', 'aaaaaaaaaaaa');
  b.run(5, 1, 2, 2, 1, 'smart', 'bbbbbbbbbbbb'); // place: query -> skipped
  b.run(6, 1, 1, 3, 0, 'X again', 'cccccccccccc');
  db.close();
  const r = firefoxData(dir, { bookmarks: true, history: true, limit: 100 });
  assert.deepEqual(r.bookmarks[0], { type: 'url', title: 'X', url: 'https://twitter.com/' });
  assert.equal(r.bookmarks.length, 2);
  assert.equal(r.bookmarks[1].title, 'Yer imleri menüsü');
  assert.equal(r.history.length, 1);
  assert.equal(r.history[0].last, Date.UTC(2026, 1, 2));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Bookmarks: star toggle, import merges without duplicates', () => {
  const store = { data: sanitizeBookmarks({}), save() {} };
  const bm = new Bookmarks({}, store);
  assert.equal(bm.toggle({ url: 'https://a.com/', title: 'A' }), true);
  assert.equal(bm.isBookmarked('https://a.com/'), true);
  assert.equal(bm.toggle({ url: 'https://a.com/', title: 'A' }), false);
  assert.equal(bm.isBookmarked('https://a.com/'), false);
  const tree = [{ type: 'url', title: 'B', url: 'https://b.com/' }, { type: 'folder', title: 'F', children: [{ type: 'url', title: 'C', url: 'https://c.com/' }] }];
  assert.equal(bm.importTree('Chrome (içe aktarıldı)', tree), 2);
  assert.equal(bm.importTree('Chrome (içe aktarıldı)', tree), 0); // second import adds nothing
  assert.equal(bm.bar.length, 1);
  assert.equal(bm.isBookmarked('https://c.com/'), true);
  assert.equal(bm.toggle({ url: 'javascript:alert(1)', title: 'x' }), false);
});
