'use strict';
// Bookmarks: a tree of links and folders. The top level is the bookmarks bar
// under the address bar; folders open as menus. Imported browsers land in their
// own folder ("Chrome'dan", "Firefox'tan" ...).
const { newId } = require('./library');

const MAX_NODES = 20000;
const MAX_DEPTH = 24;

function cleanUrl(u) {
  return typeof u === 'string' && u.length <= 4096 && /^(https?|file):\/\//i.test(u) ? u : null;
}

function cleanNode(n, depth, count) {
  if (!n || typeof n !== 'object' || count.n >= MAX_NODES || depth > MAX_DEPTH) return null;
  const title = typeof n.title === 'string' ? n.title.slice(0, 300) : '';
  if (n.type === 'folder') {
    count.n++;
    const children = [];
    for (const c of Array.isArray(n.children) ? n.children : []) {
      const k = cleanNode(c, depth + 1, count);
      if (k) children.push(k);
    }
    return { id: typeof n.id === 'string' && n.id.length < 40 ? n.id : newId('k'), type: 'folder', title: title || 'Klasör', children };
  }
  const url = cleanUrl(n.url);
  if (!url) return null;
  count.n++;
  const favicon = typeof n.favicon === 'string' && n.favicon.startsWith('data:image/') && n.favicon.length < 60000 ? n.favicon : null;
  return { id: typeof n.id === 'string' && n.id.length < 40 ? n.id : newId('k'), type: 'url', title, url, favicon };
}

function sanitizeBookmarks(obj) {
  const count = { n: 0 };
  const bar = [];
  for (const n of Array.isArray(obj?.bar) ? obj.bar : []) {
    const k = cleanNode(n, 0, count);
    if (k) bar.push(k);
  }
  return { bar };
}

class Bookmarks {
  constructor(ctl, store) {
    this.ctl = ctl;
    this.store = store;
    this._index = null;
    this.rev = 0; // bumps on every change (the manager in Settings reloads on it)
  }

  get bar() {
    return this.store.data.bar;
  }

  changed() {
    this._index = null;
    this.rev++;
    this.store.save();
    this.ctl.onBookmarksChanged?.();
  }

  /** url -> node, for the star in the address bar */
  index() {
    if (this._index) return this._index;
    const m = new Map();
    const walk = (list) => {
      for (const n of list) {
        if (n.type === 'url') {
          if (!m.has(n.url)) m.set(n.url, n);
        } else walk(n.children);
      }
    };
    walk(this.bar);
    this._index = m;
    return m;
  }

  isBookmarked(url) {
    return !!url && this.index().has(url);
  }

  /** node + the list it lives in */
  find(id, list = this.bar) {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n.id === id) return { node: n, list, index: i };
      if (n.type === 'folder') {
        const r = this.find(id, n.children);
        if (r) return r;
      }
    }
    return null;
  }

  add({ url, title, favicon, parentId = null }) {
    const n = cleanNode({ type: 'url', url, title, favicon }, 0, { n: 0 });
    if (!n) return null;
    const parent = parentId ? this.find(parentId) : null;
    const list = parent && parent.node.type === 'folder' ? parent.node.children : this.bar;
    list.push(n);
    this.changed();
    return n;
  }

  addFolder(title, parentId = null) {
    const n = { id: newId('k'), type: 'folder', title: String(title || 'Yeni klasör').slice(0, 300), children: [] };
    const parent = parentId ? this.find(parentId) : null;
    (parent && parent.node.type === 'folder' ? parent.node.children : this.bar).push(n);
    this.changed();
    return n;
  }

  /** The star: bookmark the page, or remove every bookmark of it. Returns the new state. */
  toggle({ url, title, favicon }) {
    if (!cleanUrl(url)) return false;
    if (this.isBookmarked(url)) {
      this.removeUrl(url);
      return false;
    }
    return !!this.add({ url, title, favicon });
  }

  removeUrl(url) {
    const walk = (list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].type === 'url' && list[i].url === url) list.splice(i, 1);
        else if (list[i].type === 'folder') walk(list[i].children);
      }
    };
    walk(this.bar);
    this.changed();
  }

  remove(id) {
    const f = this.find(id);
    if (!f) return false;
    f.list.splice(f.index, 1);
    this.changed();
    return true;
  }

  update(id, { title, url }) {
    const f = this.find(id);
    if (!f) return false;
    if (typeof title === 'string') f.node.title = title.slice(0, 300);
    if (f.node.type === 'url' && url !== undefined) {
      const u = cleanUrl(url);
      if (!u) return false;
      f.node.url = u;
    }
    this.changed();
    return true;
  }

  /** Moves a bar item to another position on the bar (drag and drop). */
  moveOnBar(id, index) {
    const f = this.find(id);
    if (!f || f.list !== this.bar) return;
    this.move(id, null, index);
  }

  /** Id of the folder a node is in (null = the bar itself). */
  parentId(id, list = this.bar, parent = null) {
    for (const n of list) {
      if (n.id === id) return parent;
      if (n.type === 'folder') {
        const r = this.parentId(id, n.children, n.id);
        if (r !== undefined) return r;
      }
    }
    return undefined;
  }

  /**
   * Moves a bookmark or folder into a folder (null = the bar), at `index` or at the end.
   * A folder can't go into itself or one of its own subfolders.
   */
  move(id, parentId = null, index = null, beforeId = null) {
    const f = this.find(id);
    if (!f || id === beforeId) return false;
    let dest = this.bar;
    if (parentId) {
      const p = this.find(parentId);
      if (!p || p.node.type !== 'folder') return false;
      if (f.node.type === 'folder' && (p.node === f.node || this.find(parentId, f.node.children))) return false;
      dest = p.node.children;
    }
    f.list.splice(f.index, 1);
    const before = beforeId ? dest.findIndex((x) => x.id === beforeId) : -1;
    const at = before >= 0 ? before : Number.isInteger(index) ? Math.max(0, Math.min(dest.length, index)) : dest.length;
    dest.splice(at, 0, f.node);
    this.changed();
    return true;
  }

  /** Every folder, flattened in tree order, for folder pickers. */
  folders(list = this.bar, depth = 0, out = []) {
    for (const n of list) {
      if (n.type !== 'folder') continue;
      out.push({ id: n.id, title: n.title, depth });
      if (depth < 12) this.folders(n.children, depth + 1, out);
    }
    return out;
  }

  /** The whole tree for the bookmark manager (small icons only). */
  tree(list = this.bar, depth = 0, count = { n: 0 }) {
    const out = [];
    for (const n of list) {
      if (++count.n > 5000) break;
      if (n.type === 'folder') out.push({ id: n.id, type: 'folder', title: n.title, children: depth < 12 ? this.tree(n.children, depth + 1, count) : [] });
      else out.push({ id: n.id, type: 'url', title: n.title, url: n.url, favicon: n.favicon && n.favicon.length < 8000 ? n.favicon : null });
    }
    return out;
  }

  /** Imported tree -> one folder on the bar (or merged into an existing one of the same name). */
  importTree(folderTitle, nodes) {
    const count = { n: this.countAll() };
    const children = [];
    for (const n of nodes) {
      const k = cleanNode(n, 1, count);
      if (k) children.push(k);
    }
    if (!children.length) return 0;
    let folder = this.bar.find((n) => n.type === 'folder' && n.title === folderTitle);
    if (!folder) {
      folder = { id: newId('k'), type: 'folder', title: folderTitle, children: [] };
      this.bar.push(folder);
    }
    // skip links that are already in that folder (importing twice)
    const have = new Set();
    const walk = (list) => list.forEach((n) => (n.type === 'url' ? have.add(n.url) : walk(n.children)));
    walk(folder.children);
    let added = 0;
    const addAll = (src, dst) => {
      for (const n of src) {
        if (n.type === 'url') {
          if (have.has(n.url)) continue;
          have.add(n.url);
          dst.push(n);
          added++;
        } else {
          let f = dst.find((x) => x.type === 'folder' && x.title === n.title);
          if (!f) {
            f = { ...n, children: [] };
            dst.push(f);
          }
          addAll(n.children, f.children);
        }
      }
    };
    addAll(children, folder.children);
    this.changed();
    return added;
  }

  countAll(list = this.bar) {
    let c = 0;
    for (const n of list) c += 1 + (n.type === 'folder' ? this.countAll(n.children) : 0);
    return c;
  }

  /** What the bookmarks bar shows (top level only; folders open as menus). */
  barState() {
    return this.bar.map((n) => ({ id: n.id, type: n.type, title: n.title, url: n.url || null, favicon: n.favicon || null }));
  }
}

module.exports = { Bookmarks, sanitizeBookmarks, cleanNode };
