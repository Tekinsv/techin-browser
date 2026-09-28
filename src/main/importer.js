'use strict';
// Import bookmarks and history from the other browsers on this computer:
// Chrome, Edge, Brave, Vivaldi, Opera, Opera GX (Chromium) and Firefox, Zen
// (Firefox). Their files are copied to a temporary folder first (a running
// browser keeps them open) and only ever read - never written.
// Passwords aren't read here: Chromium browsers now lock them to their own app
// and Firefox uses its own key store. The UI explains the CSV export instead.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

const CHROMIUM = [
  { id: 'chrome', name: 'Google Chrome', dir: path.join(LOCAL, 'Google', 'Chrome', 'User Data') },
  { id: 'edge', name: 'Microsoft Edge', dir: path.join(LOCAL, 'Microsoft', 'Edge', 'User Data') },
  { id: 'brave', name: 'Brave', dir: path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data') },
  { id: 'vivaldi', name: 'Vivaldi', dir: path.join(LOCAL, 'Vivaldi', 'User Data') },
  { id: 'opera', name: 'Opera', dir: path.join(ROAMING, 'Opera Software', 'Opera Stable'), single: true },
  { id: 'operagx', name: 'Opera GX', dir: path.join(ROAMING, 'Opera Software', 'Opera GX Stable'), single: true }
];
const FIREFOX = [
  { id: 'firefox', name: 'Firefox', dir: path.join(ROAMING, 'Mozilla', 'Firefox', 'Profiles') },
  { id: 'zen', name: 'Zen', dir: path.join(ROAMING, 'zen', 'Profiles') }
];

const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Browsers found on this computer, with their profiles. */
function detect() {
  const out = [];
  for (const b of CHROMIUM) {
    if (!exists(b.dir)) continue;
    let names = {};
    try {
      names = JSON.parse(fs.readFileSync(path.join(b.single ? b.dir : b.dir, 'Local State'), 'utf8'))?.profile?.info_cache || {};
    } catch {}
    const dirs = b.single ? [''] : fs.readdirSync(b.dir).filter((d) => d === 'Default' || /^Profile \d+$/.test(d));
    const profiles = dirs
      .map((d) => ({ id: d || 'main', dir: path.join(b.dir, d), name: (names[d] && names[d].name) || (d === 'Default' || !d ? 'Varsayılan' : d) }))
      .filter((p) => exists(path.join(p.dir, 'Bookmarks')) || exists(path.join(p.dir, 'History')));
    if (profiles.length) out.push({ id: b.id, name: b.name, kind: 'chromium', profiles });
  }
  for (const b of FIREFOX) {
    if (!exists(b.dir)) continue;
    const profiles = fs
      .readdirSync(b.dir)
      .map((d) => ({ id: d, dir: path.join(b.dir, d), name: d.replace(/^[a-z0-9]+\./i, '') }))
      .filter((p) => exists(path.join(p.dir, 'places.sqlite')))
      .sort((a, b2) => fs.statSync(path.join(b2.dir, 'places.sqlite')).mtimeMs - fs.statSync(path.join(a.dir, 'places.sqlite')).mtimeMs);
    if (profiles.length) out.push({ id: b.id, name: b.name, kind: 'firefox', profiles });
  }
  return out;
}

/** Copies a (possibly locked) database and its journal files to a temp folder. */
function tempCopy(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'techin-import-'));
  const dst = path.join(dir, path.basename(file));
  fs.copyFileSync(file, dst);
  for (const ext of ['-wal', '-shm', '-journal']) if (exists(file + ext)) fs.copyFileSync(file + ext, dst + ext);
  // Windows may hold the closed database a moment longer: retry, never fail the import over it.
  const cleanup = (tries = 5) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      if (tries > 0) setTimeout(() => cleanup(tries - 1), 500).unref?.();
    }
  };
  return { dst, cleanup: () => cleanup() };
}

function openDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file);
}

// ---- Chromium

function chromiumBookmarks(dir) {
  const file = path.join(dir, 'Bookmarks');
  if (!exists(file)) return [];
  const roots = JSON.parse(fs.readFileSync(file, 'utf8')).roots || {};
  const conv = (n) =>
    n.type === 'folder' ? { type: 'folder', title: n.name || '', children: (n.children || []).map(conv).filter(Boolean) } : n.type === 'url' ? { type: 'url', title: n.name || '', url: n.url } : null;
  const out = (roots.bookmark_bar?.children || []).map(conv).filter(Boolean);
  const other = (roots.other?.children || []).map(conv).filter(Boolean);
  if (other.length) out.push({ type: 'folder', title: 'Diğer yer imleri', children: other });
  const synced = (roots.synced?.children || []).map(conv).filter(Boolean);
  if (synced.length) out.push({ type: 'folder', title: 'Mobil yer imleri', children: synced });
  return out;
}

function chromiumHistory(dir, limit) {
  const file = path.join(dir, 'History');
  if (!exists(file)) return [];
  const c = tempCopy(file);
  try {
    const db = openDb(c.dst);
    const rows = db.prepare('SELECT url, title, visit_count AS v, (last_visit_time / 1000 - 11644473600000) AS t FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ?').all(limit);
    db.close();
    // microseconds since 1601-01-01 -> ms since 1970
    return rows.map((r) => ({ url: r.url, title: r.title, visits: Number(r.v), last: Number(r.t) }));
  } finally {
    c.cleanup();
  }
}

// ---- Firefox / Zen

function firefoxData(dir, { bookmarks, history, limit }) {
  const c = tempCopy(path.join(dir, 'places.sqlite'));
  try {
    const db = openDb(c.dst);
    const out = { bookmarks: [], history: [] };
    if (bookmarks) {
      const rows = db
        .prepare('SELECT b.id, b.type, b.parent, b.position, b.title, b.guid, p.url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position')
        .all();
      const kids = new Map();
      for (const r of rows) {
        if (!kids.has(r.parent)) kids.set(r.parent, []);
        kids.get(r.parent).push(r);
      }
      const byGuid = new Map(rows.map((r) => [r.guid, r]));
      const conv = (r, depth = 0) => {
        if (r.type === 1) return r.url && /^(https?|file):/.test(r.url) ? { type: 'url', title: r.title || '', url: r.url } : null;
        if (r.type === 2 && depth < 20) return { type: 'folder', title: r.title || '', children: (kids.get(r.id) || []).map((k) => conv(k, depth + 1)).filter(Boolean) };
        return null;
      };
      const list = (guid) => {
        const root = byGuid.get(guid);
        return root ? (kids.get(root.id) || []).map((k) => conv(k)).filter(Boolean) : [];
      };
      out.bookmarks = list('toolbar_____');
      const menu = list('menu________');
      if (menu.length) out.bookmarks.push({ type: 'folder', title: 'Yer imleri menüsü', children: menu });
      const other = list('unfiled_____');
      if (other.length) out.bookmarks.push({ type: 'folder', title: 'Diğer yer imleri', children: other });
      const mobile = list('mobile______');
      if (mobile.length) out.bookmarks.push({ type: 'folder', title: 'Mobil yer imleri', children: mobile });
    }
    if (history) {
      out.history = db
        .prepare('SELECT url, title, visit_count AS v, (last_visit_date / 1000) AS t FROM moz_places WHERE visit_count > 0 AND hidden = 0 AND last_visit_date IS NOT NULL ORDER BY last_visit_date DESC LIMIT ?')
        .all(limit)
        .map((r) => ({ url: r.url, title: r.title, visits: Number(r.v), last: Number(r.t) }));
    }
    db.close();
    return out;
  } finally {
    c.cleanup();
  }
}

/**
 * Reads one profile. Returns { bookmarks: tree[], history: item[] } or throws
 * with a readable message (e.g. the browser keeps the file locked).
 */
function read(sourceId, profileId, { bookmarks = true, history = true, limit = 20000 } = {}) {
  const src = detect().find((s) => s.id === sourceId);
  const prof = src && src.profiles.find((p) => p.id === profileId);
  if (!src || !prof) throw new Error('not-found');
  try {
    if (src.kind === 'chromium') return { name: src.name, bookmarks: bookmarks ? chromiumBookmarks(prof.dir) : [], history: history ? chromiumHistory(prof.dir, limit) : [] };
    return { name: src.name, ...firefoxData(prof.dir, { bookmarks, history, limit }) };
  } catch (err) {
    if (/EBUSY|EPERM|locked|SQLITE_BUSY/i.test(String(err && (err.code || err.message)))) throw new Error('locked');
    throw err;
  }
}

module.exports = { detect, read, chromiumBookmarks, chromiumHistory, firefoxData };
