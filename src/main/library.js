'use strict';
// Global (cross-window) data: spaces with their pinned sites, and favorites.
// Windows create tabs for these items lazily and link them by refId.
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { safeURL } = require('./url');

const newId = (p) => `${p}-${randomUUID().slice(0, 8)}`;
const ID_RE = /^[a-z]{1,3}-[0-9a-f]{8}$/;

function cleanItem(it) {
  if (!it || typeof it !== 'object') return null;
  const u = safeURL(it.url);
  if (!u || !/^(https?|file):$/.test(u.protocol)) return null;
  return {
    id: typeof it.id === 'string' && ID_RE.test(it.id) ? it.id : newId('i'),
    url: u.href,
    title: typeof it.title === 'string' ? it.title.slice(0, 300) : '',
    customTitle: it.customTitle === true,
    favicon: typeof it.favicon === 'string' && it.favicon.startsWith('data:image/') && it.favicon.length < 150000 ? it.favicon : null
  };
}

function cleanSpace(sp, i) {
  if (!sp || typeof sp !== 'object') return null;
  return {
    id: typeof sp.id === 'string' && ID_RE.test(sp.id) ? sp.id : newId('s'),
    name: typeof sp.name === 'string' && sp.name.trim() ? sp.name.trim().slice(0, 40) : `Alan ${i + 1}`,
    icon: typeof sp.icon === 'string' && sp.icon.length <= 8 ? sp.icon : '',
    hue: Number.isFinite(sp.hue) ? ((Math.round(sp.hue) % 360) + 360) % 360 : 214,
    pinned: Array.isArray(sp.pinned) ? sp.pinned.map(cleanItem).filter(Boolean).slice(0, 200) : []
  };
}

function sanitizeLibrary(obj) {
  const spaces = Array.isArray(obj?.spaces) ? obj.spaces.map(cleanSpace).filter(Boolean).slice(0, 20) : [];
  if (!spaces.length) spaces.push(cleanSpace({ name: 'Kişisel', icon: '🏠', hue: 214 }, 0));
  const favorites = Array.isArray(obj?.favorites) ? obj.favorites.map(cleanItem).filter(Boolean).slice(0, 24) : [];
  return { spaces, favorites };
}

class Library extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
  }

  get spaces() {
    return this.store.data.spaces;
  }

  get favorites() {
    return this.store.data.favorites;
  }

  changed() {
    this.store.save();
    this.emit('changed');
  }

  space(id) {
    return this.spaces.find((s) => s.id === id) || null;
  }

  /** Finds a favorite or pinned item: { item, list, kind, spaceId }. */
  find(itemId) {
    let idx = this.favorites.findIndex((i) => i.id === itemId);
    if (idx >= 0) return { item: this.favorites[idx], list: this.favorites, kind: 'favorite', spaceId: null };
    for (const sp of this.spaces) {
      idx = sp.pinned.findIndex((i) => i.id === itemId);
      if (idx >= 0) return { item: sp.pinned[idx], list: sp.pinned, kind: 'pinned', spaceId: sp.id };
    }
    return null;
  }

  addItem(kind, spaceId, data, index) {
    const item = cleanItem({ ...data, id: undefined });
    if (!item) return null;
    const list = kind === 'favorite' ? this.favorites : this.space(spaceId)?.pinned;
    if (!list) return null;
    if (kind === 'favorite' && list.length >= 24) return null;
    const at = Number.isInteger(index) ? Math.max(0, Math.min(list.length, index)) : list.length;
    list.splice(at, 0, item);
    this.changed();
    return item;
  }

  removeItem(itemId) {
    const found = this.find(itemId);
    if (!found) return null;
    found.list.splice(found.list.indexOf(found.item), 1);
    this.changed();
    return found;
  }

  moveItem(itemId, kind, spaceId, index) {
    const found = this.find(itemId);
    if (!found) return false;
    const target = kind === 'favorite' ? this.favorites : this.space(spaceId)?.pinned;
    if (!target) return false;
    if (kind === 'favorite' && target !== found.list && target.length >= 24) return false;
    found.list.splice(found.list.indexOf(found.item), 1);
    const at = Number.isInteger(index) ? Math.max(0, Math.min(target.length, index)) : target.length;
    target.splice(at, 0, found.item);
    this.changed();
    return true;
  }

  updateItem(itemId, patch) {
    const found = this.find(itemId);
    if (!found) return;
    const it = found.item;
    let dirty = false;
    if (typeof patch.title === 'string' && patch.title !== it.title) {
      it.title = patch.title.slice(0, 300);
      if (patch.custom === true) it.customTitle = true;
      dirty = true;
    }
    if (typeof patch.favicon === 'string' && patch.favicon !== it.favicon && patch.favicon.length < 150000) {
      it.favicon = patch.favicon;
      dirty = true;
    }
    if (typeof patch.url === 'string') {
      const u = safeURL(patch.url);
      if (u && /^(https?|file):$/.test(u.protocol) && u.href !== it.url) {
        it.url = u.href;
        dirty = true;
      }
    }
    if (dirty) this.changed();
  }

  addSpace({ name, icon, hue } = {}) {
    if (this.spaces.length >= 20) return null;
    const sp = cleanSpace({ name, icon, hue: Number.isFinite(hue) ? hue : (this.spaces.length * 67 + 214) % 360 }, this.spaces.length);
    this.spaces.push(sp);
    this.changed();
    return sp;
  }

  updateSpace(id, patch) {
    const sp = this.space(id);
    if (!sp) return;
    if (typeof patch.name === 'string' && patch.name.trim()) sp.name = patch.name.trim().slice(0, 40);
    if (typeof patch.icon === 'string' && patch.icon.length <= 8) sp.icon = patch.icon;
    if (Number.isFinite(patch.hue)) sp.hue = ((Math.round(patch.hue) % 360) + 360) % 360;
    this.changed();
  }

  removeSpace(id) {
    if (this.spaces.length <= 1) return false;
    const idx = this.spaces.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    this.spaces.splice(idx, 1);
    this.changed();
    return true;
  }

  moveSpace(id, index) {
    const idx = this.spaces.findIndex((s) => s.id === id);
    if (idx < 0 || !Number.isInteger(index)) return;
    const [sp] = this.spaces.splice(idx, 1);
    this.spaces.splice(Math.max(0, Math.min(this.spaces.length, index)), 0, sp);
    this.changed();
  }
}

module.exports = { Library, sanitizeLibrary, newId, ID_RE };
