'use strict';
// Browsing history: one entry per URL with visit count and last visit time.
const MAX_ENTRIES = 12000;

function sanitizeHistory(obj) {
  const items = Array.isArray(obj?.items) ? obj.items : [];
  const out = [];
  const seen = new Set();
  for (const it of items) {
    if (!it || typeof it.url !== 'string' || !/^https?:\/\//.test(it.url) || it.url.length > 4096) continue;
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    out.push({
      url: it.url,
      title: typeof it.title === 'string' ? it.title.slice(0, 300) : '',
      visits: Number.isFinite(it.visits) ? Math.max(1, Math.floor(it.visits)) : 1,
      last: Number.isFinite(it.last) ? it.last : 0
    });
    if (out.length >= MAX_ENTRIES) break;
  }
  return { items: out };
}

function fold(s) {
  return String(s || '')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

class History {
  constructor(store) {
    this.store = store;
    this.byUrl = new Map(store.data.items.map((it) => [it.url, it]));
  }

  get items() {
    return this.store.data.items;
  }

  add(url, title) {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url) || url.length > 4096) return;
    let it = this.byUrl.get(url);
    const now = Date.now();
    if (it) {
      // Reloads and in-page hops within a few seconds are not new visits.
      if (now - it.last > 5000) it.visits++;
      it.last = now;
      if (title) it.title = String(title).slice(0, 300);
    } else {
      it = { url, title: title ? String(title).slice(0, 300) : '', visits: 1, last: now };
      this.items.push(it);
      this.byUrl.set(url, it);
      if (this.items.length > MAX_ENTRIES) this.trim();
    }
    this.store.save();
  }

  setTitle(url, title) {
    const it = this.byUrl.get(url);
    if (it && title && it.title !== title) {
      it.title = String(title).slice(0, 300);
      this.store.save();
    }
  }

  trim() {
    this.items.sort((a, b) => b.last - a.last);
    const removed = this.items.splice(Math.floor(MAX_ENTRIES * 0.9));
    for (const it of removed) this.byUrl.delete(it.url);
  }

  /** Ranked matches for the command bar. */
  search(text, limit = 6) {
    const terms = fold(text).split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const now = Date.now();
    const scored = [];
    for (const it of this.items) {
      const hay = fold(it.title + ' ' + it.url.replace(/^https?:\/\/(www\.)?/, ''));
      if (!terms.every((t) => hay.includes(t))) continue;
      const host = it.url.replace(/^https?:\/\/(www\.)?/, '');
      let score = Math.log2(1 + it.visits) * 2;
      const ageDays = (now - it.last) / 86400000;
      score += Math.max(0, 6 - Math.log2(1 + ageDays) * 1.5);
      if (fold(host).startsWith(terms[0])) score += 8;
      if (/^https?:\/\/[^/]+\/?$/.test(it.url)) score += 2; // prefer site roots
      scored.push({ it, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ it }) => ({ url: it.url, title: it.title }));
  }

  topSites(limit = 8) {
    const byHost = new Map();
    for (const it of this.items) {
      const m = /^https?:\/\/([^/]+)/.exec(it.url);
      if (!m) continue;
      const host = m[1].replace(/^www\./, '');
      const cur = byHost.get(host) || { host, url: `${it.url.split('/').slice(0, 3).join('/')}/`, title: '', visits: 0 };
      cur.visits += it.visits;
      if (!cur.title && /^https?:\/\/[^/]+\/?$/.test(it.url)) cur.title = it.title;
      byHost.set(host, cur);
    }
    return [...byHost.values()].sort((a, b) => b.visits - a.visits).slice(0, limit);
  }

  list({ query = '', offset = 0, limit = 100 } = {}) {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    const sorted = [...this.items].sort((a, b) => b.last - a.last);
    const filtered = terms.length ? sorted.filter((it) => terms.every((t) => fold(it.title + ' ' + it.url).includes(t))) : sorted;
    return { total: filtered.length, items: filtered.slice(offset, offset + limit) };
  }

  remove(url) {
    const it = this.byUrl.get(url);
    if (!it) return;
    this.items.splice(this.items.indexOf(it), 1);
    this.byUrl.delete(url);
    this.store.save();
  }

  /** Removes entries visited since `sinceMs` (0 = everything). */
  clear(sinceMs = 0) {
    const keep = this.items.filter((it) => sinceMs > 0 && it.last < sinceMs);
    this.store.data.items = keep;
    this.byUrl = new Map(keep.map((it) => [it.url, it]));
    this.store.save();
  }
}

module.exports = { History, sanitizeHistory, fold };
