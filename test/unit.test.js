'use strict';
// Unit tests for the pure (Electron-free) modules: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const url = require('../src/main/url');
const policy = require('../src/main/policy');
const settings = require('../src/main/settings');
const { History, sanitizeHistory, fold } = require('../src/main/history');
const { Library, sanitizeLibrary } = require('../src/main/library');
const i18n = require('../src/shared/i18n');

const G = url.SEARCH_ENGINES.google.url;
const go = (s) => url.normalizeInput(s, G);

test('address bar: domains become https URLs', () => {
  assert.equal(go('example.com').url, 'https://example.com/');
  assert.equal(go('youtube.com/watch?v=1').url, 'https://youtube.com/watch?v=1');
  assert.equal(go('sub.example.co.uk').url, 'https://sub.example.co.uk/');
  assert.equal(go('my.github.io').url, 'https://my.github.io/');
  assert.equal(go('şişe.com').search, false);
});

test('address bar: local addresses stay http', () => {
  assert.equal(go('localhost:3000').url, 'http://localhost:3000/');
  assert.equal(go('192.168.1.1').url, 'http://192.168.1.1/');
  assert.equal(go('127.0.0.1:8080/api').url, 'http://127.0.0.1:8080/api');
  assert.equal(go('printer.local').url, 'http://printer.local/');
  assert.equal(go('[::1]:5000').url, 'http://[::1]:5000/');
});

test('address bar: text becomes a search', () => {
  assert.equal(go('nas/').url, 'http://nas/');
  assert.equal(go('router:8080').url, 'http://router:8080/');
  assert.equal(go('localhost').url, 'http://localhost/');
  for (const s of ['youtube', 'Instagram', 'hava', 'hello world', 'node.js', 'hava durumu', 'a.b', 'user@example.com', '3.14']) {
    assert.equal(go(s).search, true, s);
  }
  assert.equal(go('kedi resimleri').url, 'https://www.google.com/search?q=kedi%20resimleri');
});

test('address bar: dangerous schemes are never navigated', () => {
  for (const s of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'chrome://settings', 'vbscript:x', 'ms-msdt:/id x', 'blob:https://a.com/x']) {
    const r = go(s);
    assert.ok(r.search, s);
    assert.ok(r.url.startsWith('https://www.google.com/search?q='), s);
  }
});

test('address bar: explicit schemes and paths', () => {
  assert.equal(go('https://example.com/a b').url, 'https://example.com/a%20b');
  assert.equal(go('http://neverssl.com').url, 'http://neverssl.com/');
  assert.equal(go('about:blank').url, 'about:blank');
  assert.equal(go('view-source:example.com').url, 'view-source:https://example.com/');
  assert.match(go('C:\\Users\\test\\file.pdf').url, /^file:\/\/\/C:\/Users\/test\/file\.pdf$/);
  assert.equal(go('   '), null);
});

test('navigation allow-lists', () => {
  assert.ok(url.isNavigable('https://a.com'));
  assert.ok(url.isNavigable('file:///C:/x.html'));
  assert.ok(url.isNavigable('view-source:https://a.com'));
  assert.ok(!url.isNavigable('javascript:alert(1)'));
  assert.ok(!url.isNavigable('chrome://gpu'));
  assert.ok(!url.isNavigable('view-source:file:///C:/x'));
  assert.ok(url.isOpenableFromPage('https://a.com'));
  assert.ok(!url.isOpenableFromPage('file:///C:/Windows/win.ini'), 'pages cannot open local files');
  assert.ok(!url.isOpenableFromPage('data:text/html,x'));
  assert.ok(url.isOpenableFromPage('blob:https://a.com/1234'));
});

test('local host detection (no HTTPS upgrade)', () => {
  for (const h of ['localhost', 'app.localhost', '10.0.0.5', '172.20.1.1', '192.168.0.10', 'nas', 'router.lan']) assert.ok(url.isLocalHost(h), h);
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1']) assert.ok(!url.isLocalHost(h), h);
});

test('security state and display host', () => {
  assert.equal(url.securityState('https://a.com'), 'secure');
  assert.equal(url.securityState('http://a.com'), 'insecure');
  assert.equal(url.securityState('http://localhost:3000'), 'local');
  assert.equal(url.securityState('https://a.com', { certError: true }), 'cert-error');
  assert.equal(url.displayHost('https://www.youtube.com/watch?v=1'), 'youtube.com');
});

test('search suggestion parsing is defensive', () => {
  assert.deepEqual(url.parseSuggestResponse(['q', ['a', 'b', 5, 'c']]), ['a', 'b', 'c']);
  assert.deepEqual(url.parseSuggestResponse({ evil: true }), []);
  assert.deepEqual(url.parseSuggestResponse(null), []);
});

test('permissions: defaults are safe', () => {
  assert.equal(policy.decide('camera'), 'ask');
  assert.equal(policy.decide('geolocation'), 'ask');
  assert.equal(policy.decide('notifications'), 'ask');
  assert.equal(policy.decide('mediaKeySystem'), 'allow', 'DRM must work');
  assert.equal(policy.decide('fullscreen'), 'allow');
  for (const p of ['hid', 'serial', 'usb', 'unknown', 'bluetooth']) assert.equal(policy.decide(p), 'deny', p);
  assert.equal(policy.decide('camera', 'allow'), 'allow');
  assert.equal(policy.decide('fullscreen', 'deny'), 'deny');
  assert.deepEqual(policy.expandPermission('media', { mediaTypes: ['video', 'audio'] }), ['camera', 'microphone']);
  assert.deepEqual(policy.expandPermission('media', { mediaTypes: ['audio'] }), ['microphone']);
  assert.equal(policy.combine(['allow', 'ask']), 'ask');
  assert.equal(policy.combine(['allow', 'deny', 'ask']), 'deny');
});

test('downloads: file names are made safe', () => {
  assert.equal(policy.sanitizeFilename('..\\..\\Windows\\evil.exe'), '_.._Windows_evil.exe');
  assert.equal(policy.sanitizeFilename('CON.txt'), '_CON.txt');
  assert.equal(policy.sanitizeFilename('report\u202Efdp.exe'), 'report_fdp.exe', 'right-to-left override trick removed');
  assert.equal(policy.sanitizeFilename('   '), 'download');
  assert.equal(policy.sanitizeFilename('a:b*c?.pdf'), 'a_b_c_.pdf');
  assert.ok(policy.sanitizeFilename('x'.repeat(400) + '.zip').endsWith('.zip'));
  assert.ok(policy.sanitizeFilename('x'.repeat(400) + '.zip').length <= 180);
});

test('downloads: dangerous types and unique names', () => {
  for (const n of ['setup.exe', 'a.MSI', 'x.ps1', 'y.bat', 'z.js', 'doc.docm', 'k.lnk']) assert.ok(policy.isDangerousFile(n), n);
  for (const n of ['photo.jpg', 'movie.mp4', 'notes.txt', 'paper.pdf']) assert.ok(!policy.isDangerousFile(n), n);
  const taken = new Set([path.join('D', 'a.txt'), path.join('D', 'a (1).txt')]);
  assert.equal(policy.uniquePath('D', 'a.txt', (p) => taken.has(p)), path.join('D', 'a (2).txt'));
  const z = policy.zoneIdentifier('https://x.com/f.exe', 'https://x.com/page');
  assert.match(z, /ZoneId=3/);
  assert.match(z, /HostUrl=https:\/\/x\.com\/f\.exe/);
  assert.doesNotMatch(policy.zoneIdentifier('https://x.com/\r\nZoneId=0', ''), /\r\nZoneId=0/);
});

test('load errors are classified', () => {
  assert.equal(policy.classifyLoadError(-105), 'dns');
  assert.equal(policy.classifyLoadError(-106), 'offline');
  assert.equal(policy.classifyLoadError(-202), 'cert');
  assert.equal(policy.classifyLoadError(-20), 'blocked');
  assert.equal(policy.classifyLoadError(-102), 'network');
  assert.equal(policy.classifyLoadError(-999), 'generic');
});

test('hosts blocklist parser', () => {
  const set = policy.parseHostsList('# c\n0.0.0.0 bad.example\n0.0.0.0 EVIL.test\n\n0.0.0.0 0.0.0.0\nplain.host\n0.0.0.0 inv@lid');
  assert.deepEqual([...set].sort(), ['bad.example', 'evil.test', 'plain.host']);
});

test('settings: sanitize rejects junk', () => {
  const s = settings.sanitizeSettings({ theme: 'purple', sidebarWidth: 9999, adblock: 'yes', tabSleepMinutes: 7, customSearchUrl: 'javascript:%s', adblockAllowlist: ['ok.com', 'bad host', 5, 'OK.com'], __proto__: { polluted: true } });
  assert.equal(s.theme, 'system');
  assert.equal(s.sidebarWidth, 420);
  assert.equal(s.adblock, true);
  assert.equal(s.tabSleepMinutes, 15);
  assert.equal(s.customSearchUrl, '');
  assert.deepEqual(s.adblockAllowlist, ['ok.com']);
  assert.equal(settings.sanitizeChange('theme', 'dark'), 'dark');
  assert.equal(settings.sanitizeChange('nope', 1), undefined);
  assert.equal(settings.sanitizeChange('__proto__', {}), undefined);
  assert.equal(settings.sanitizeChange('customSearchUrl', 'https://s.com/?q=%s'), 'https://s.com/?q=%s');
  assert.equal(settings.sanitizeChange('customSearchUrl', 'http://s.com/?q=%s'), undefined, 'http search leaks queries');
  assert.equal(settings.sanitizeSettings(null).adblock, true);
});

test('history: visits, ranking, clearing', () => {
  const store = { data: sanitizeHistory({ items: [] }), save() {} };
  const h = new History(store);
  h.add('https://www.youtube.com/', 'YouTube');
  h.add('https://www.youtube.com/watch?v=1', 'Kedi videosu');
  h.add('https://example.com/', 'Example');
  h.add('javascript:alert(1)', 'x');
  assert.equal(h.items.length, 3);
  assert.equal(h.search('you')[0].url, 'https://www.youtube.com/');
  assert.equal(h.search('KEDİ')[0].title, 'Kedi videosu');
  assert.equal(h.topSites(1)[0].host, 'youtube.com');
  h.remove('https://example.com/');
  assert.equal(h.items.length, 2);
  h.clear(0);
  assert.equal(h.items.length, 0);
  assert.equal(fold('IŞIK Çiçek'), 'isik cicek');
});

test('library: sanitize and moves', () => {
  const data = sanitizeLibrary({ spaces: [{ name: 'Test', pinned: [{ url: 'javascript:1' }, { url: 'https://a.com', title: 'A' }] }], favorites: [{ url: 'https://b.com' }] });
  assert.equal(data.spaces[0].pinned.length, 1, 'bad URLs dropped');
  const lib = new Library({ data, save() {} });
  const sp = lib.spaces[0];
  const pinned = sp.pinned[0];
  assert.ok(lib.moveItem(pinned.id, 'favorite', null, 0));
  assert.equal(lib.favorites[0].url, 'https://a.com/');
  assert.equal(lib.find(pinned.id).kind, 'favorite');
  const s2 = lib.addSpace({ name: 'İş', icon: '💼' });
  assert.equal(lib.spaces.length, 2);
  assert.ok(lib.removeSpace(s2.id));
  assert.ok(!lib.removeSpace(sp.id), 'last space cannot be removed');
  assert.equal(sanitizeLibrary({}).spaces.length, 1, 'always one space');
});

test('i18n: English translations and placeholders', () => {
  assert.equal(i18n.translate('en', 'Yeni sekme'), 'New tab');
  assert.equal(i18n.translate('tr', 'Yeni sekme'), 'Yeni sekme');
  assert.equal(i18n.translate('en', '{0} reklam/izleyici engellendi', 5), '5 ads/trackers blocked');
  assert.equal(i18n.translate('en', 'çevrilmemiş metin'), 'çevrilmemiş metin');
});
