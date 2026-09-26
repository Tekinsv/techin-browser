'use strict';
// Password manager. Passwords are encrypted with the OS key store
// (safeStorage = DPAPI on Windows, tied to this Windows account) before they
// touch the disk; without it nothing is saved at all.
//
// Pages talk to it only through src/preload/page.js (isolated world) and only
// about their *own* origin, taken from the sending frame in the main process -
// never from the message. A page learns usernames for its origin when a login
// field is focused, and a password only when the user clicks one of our
// suggestions. Listing, revealing, copying and exporting is UI-only.
const { ipcMain, safeStorage, clipboard } = require('electron');
const { newId } = require('./library');

const MAX_ITEMS = 5000;
const MAX_USER = 256;
const MAX_PASS = 512;

function cleanOrigin(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

function sanitizePasswords(obj) {
  const items = [];
  const seen = new Set();
  for (const it of Array.isArray(obj?.items) ? obj.items : []) {
    if (!it || typeof it.id !== 'string' || typeof it.pw !== 'string' || it.pw.length > 4096) continue;
    const origin = cleanOrigin(it.origin);
    const username = typeof it.username === 'string' ? it.username.slice(0, MAX_USER) : '';
    if (!origin || seen.has(it.id)) continue;
    seen.add(it.id);
    items.push({
      id: it.id,
      origin,
      username,
      pw: it.pw,
      created: Number.isFinite(it.created) ? it.created : Date.now(),
      updated: Number.isFinite(it.updated) ? it.updated : Date.now(),
      used: Number.isFinite(it.used) ? it.used : 0
    });
    if (items.length >= MAX_ITEMS) break;
  }
  const never = [];
  for (const o of Array.isArray(obj?.never) ? obj.never : []) {
    const c = cleanOrigin(o);
    if (c && !never.includes(c)) never.push(c);
    if (never.length >= 2000) break;
  }
  return { items, never };
}

// ---- CSV (Chrome / Google Password Manager / Edge / Firefox exports)

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f !== ''));
}

const csvField = (v) => (/[",\r\n]/.test(v) || /^[=+\-@\t]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

class Passwords {
  constructor(ctl, store) {
    this.ctl = ctl;
    this.store = store;
    // tab webContents id -> { origin, username, password, at, frameKey }
    this.pending = new Map();
    // `${wcId}|${origin}` -> { value, at }: username typed on step 1 of a two-step login
    this.lastUser = new Map();
  }

  get items() {
    return this.store.data.items;
  }

  available() {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  _enc(password) {
    return safeStorage.encryptString(password).toString('base64');
  }

  _dec(item) {
    try {
      return safeStorage.decryptString(Buffer.from(item.pw, 'base64'));
    } catch {
      return null;
    }
  }

  _changed() {
    this.store.save();
    for (const w of this.ctl.windows) w.sendEvent('passwords-changed', {});
  }

  /** Everything the settings page shows - never the passwords themselves. */
  list() {
    return this.items
      .map((it) => ({ id: it.id, origin: it.origin, host: new URL(it.origin).host, username: it.username, updated: it.updated, used: it.used }))
      .sort((a, b) => a.host.localeCompare(b.host) || a.username.localeCompare(b.username));
  }

  status() {
    return { available: this.available(), count: this.items.length, never: [...this.store.data.never] };
  }

  find(origin, username) {
    return this.items.find((it) => it.origin === origin && it.username === username) || null;
  }

  reveal(id) {
    const it = this.items.find((x) => x.id === id);
    return it ? this._dec(it) : null;
  }

  copy(id) {
    const pw = this.reveal(id);
    if (pw === null) return false;
    clipboard.writeText(pw);
    // Don't leave the password on the clipboard forever.
    clearTimeout(this._clipTimer);
    this._clipTimer = setTimeout(() => {
      if (clipboard.readText() === pw) clipboard.clear();
    }, 45000);
    return true;
  }

  save({ origin, username = '', password }) {
    origin = cleanOrigin(origin);
    if (!origin || typeof password !== 'string' || !password || password.length > MAX_PASS || typeof username !== 'string' || username.length > MAX_USER) return null;
    if (!this.available()) return null;
    const now = Date.now();
    let it = this.find(origin, username);
    if (it) {
      it.pw = this._enc(password);
      it.updated = now;
    } else {
      if (this.items.length >= MAX_ITEMS) return null;
      it = { id: newId('p'), origin, username, pw: this._enc(password), created: now, updated: now, used: 0 };
      this.items.push(it);
    }
    this._changed();
    return it.id;
  }

  update(id, { username, password, origin }) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return false;
    if (typeof origin === 'string') {
      const o = cleanOrigin(origin);
      if (!o) return false;
      it.origin = o;
    }
    if (typeof username === 'string' && username.length <= MAX_USER) it.username = username;
    if (typeof password === 'string' && password && password.length <= MAX_PASS && this.available()) it.pw = this._enc(password);
    it.updated = Date.now();
    this._changed();
    return true;
  }

  remove(id) {
    const n = this.items.length;
    this.store.data.items = this.items.filter((x) => x.id !== id);
    if (this.items.length !== n) this._changed();
    return this.items.length !== n;
  }

  setNever(origin, on) {
    const o = cleanOrigin(origin);
    if (!o) return;
    const list = this.store.data.never.filter((x) => x !== o);
    if (on) list.push(o);
    this.store.data.never = list;
    this._changed();
  }

  importCsv(text) {
    const rows = parseCsv(String(text).replace(/^﻿/, ''));
    const res = { added: 0, updated: 0, skipped: 0 };
    if (!rows.length) return res;
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const col = (...names) => head.findIndex((h) => names.includes(h));
    const iUrl = col('url', 'origin', 'website', 'login_uri');
    const iUser = col('username', 'login', 'user', 'login_username', 'email');
    const iPass = col('password', 'login_password');
    if (iUrl < 0 || iPass < 0) return { ...res, error: 'format' };
    for (const r of rows.slice(1)) {
      const origin = cleanOrigin((r[iUrl] || '').trim());
      const password = r[iPass] || '';
      const username = iUser >= 0 ? r[iUser] || '' : '';
      if (!origin || !password) {
        res.skipped++;
        continue;
      }
      const had = this.find(origin, username);
      if (had && this._dec(had) === password) {
        res.skipped++;
        continue;
      }
      if (this.save({ origin, username, password })) res[had ? 'updated' : 'added']++;
      else res.skipped++;
    }
    return res;
  }

  /** Chrome's export format, so it can be imported anywhere. */
  exportCsv() {
    const lines = ['name,url,username,password,note'];
    for (const it of this.items) {
      const pw = this._dec(it);
      if (pw === null) continue;
      lines.push([new URL(it.origin).host, it.origin + '/', it.username, pw, ''].map(csvField).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  // ------------------------------------------------------------ pages

  /** The sending frame's origin, or null for anything we don't serve. */
  _frameOrigin(event) {
    const tab = this.ctl.tabByWcId(event.sender.id);
    const popup = this.ctl.popups.get(event.sender.id);
    if (!tab && !popup) return null;
    const frame = event.senderFrame;
    if (!frame) return null;
    return { tab, origin: cleanOrigin(frame.url) };
  }

  _canOffer(tab, origin) {
    const s = this.ctl.settings.data;
    return !!(tab && origin && s.passwordSave && !tab.win.incognito && this.available() && !this.store.data.never.includes(origin));
  }

  /** A login form was submitted; wait for signs of success before asking. */
  onSubmit(tab, origin, username, password) {
    if (!this._canOffer(tab, origin)) return;
    const key = `${tab.wc.id}|${origin}`;
    const remembered = this.lastUser.get(key);
    if (!username && remembered && Date.now() - remembered.at < 10 * 60 * 1000) username = remembered.value;
    this.pending.set(tab.wc.id, { tab, origin, username: username || '', password, at: Date.now() });
  }

  /** Navigation, or the password field went away: the login most likely worked. */
  onSuccessHint(tab) {
    if (!tab || !tab.wc) return;
    const p = this.pending.get(tab.wc.id);
    if (!p) return;
    this.pending.delete(tab.wc.id);
    if (Date.now() - p.at > 20000) return;
    // Let the navigation settle (infobars of the old page are cleared first).
    setTimeout(() => this._offer(p), 300);
  }

  _offer(p) {
    const { tab, origin, username, password } = p;
    if (!tab.win || tab.win.win.isDestroyed()) return;
    const had = this.find(origin, username);
    if (had && this._dec(had) === password) return; // already saved
    tab.win.dismissInfobar((b) => b.type === 'password' && b.tabId === tab.id);
    tab.win.showInfobar({
      type: 'password',
      tabId: tab.id,
      origin,
      host: new URL(origin).host,
      username,
      mode: had ? 'update' : 'save',
      resolve: (choice) => {
        if (choice === 'save') {
          if (this.save({ origin, username, password })) this.ctl.toast(this.ctl.t('Parola kaydedildi'), 'key');
        } else if (choice === 'never') {
          this.setNever(origin, true);
        }
      }
    });
  }

  install() {
    const text = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
    ipcMain.on('techin:pw', (event, msg) => {
      try {
        if (!msg || typeof msg !== 'object') return;
        const src = this._frameOrigin(event);
        if (!src || !src.origin) return;
        if (msg.type === 'user') {
          const v = text(msg.value, MAX_USER);
          if (v) this.lastUser.set(`${event.sender.id}|${src.origin}`, { value: v, at: Date.now() });
          if (this.lastUser.size > 200) this.lastUser.delete(this.lastUser.keys().next().value);
        } else if (msg.type === 'submit') {
          const pw = text(msg.password, MAX_PASS);
          const user = text(msg.username, MAX_USER) || '';
          if (pw) this.onSubmit(src.tab, src.origin, user, pw);
        } else if (msg.type === 'gone') {
          this.onSuccessHint(src.tab);
        }
      } catch (err) {
        console.error('[passwords]', err);
      }
    });
    // Usernames saved for the asking frame's own origin (shown in our suggestion list).
    ipcMain.handle('techin:pw-query', (event) => {
      const src = this._frameOrigin(event);
      if (!src || !src.origin || !this.ctl.settings.data.passwordAutofill) return [];
      return this.items
        .filter((it) => it.origin === src.origin)
        .sort((a, b) => b.used - a.used)
        .slice(0, 20)
        .map((it) => ({ id: it.id, username: it.username }));
    });
    // The password itself, only for that origin and only after a real click on a suggestion.
    ipcMain.handle('techin:pw-fill', (event, id) => {
      const src = this._frameOrigin(event);
      if (!src || !src.origin || typeof id !== 'string' || !this.ctl.settings.data.passwordAutofill) return null;
      const it = this.items.find((x) => x.id === id && x.origin === src.origin);
      if (!it) return null;
      const password = this._dec(it);
      if (password === null) return null;
      it.used = Date.now();
      this.store.save();
      return { username: it.username, password };
    });
  }
}

module.exports = { Passwords, sanitizePasswords, parseCsv, cleanOrigin };
