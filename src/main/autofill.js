'use strict';
// Addresses and payment cards: offered for saving when a form is sent, offered
// for filling under the focused field (src/preload/page.js, section 4b).
// Card numbers are encrypted with the OS key store (DPAPI) like passwords; the
// security code (CVC) is never stored. A page only gets card data after a real
// click on one of our suggestions, and only on a secure (https) page.
const { ipcMain, safeStorage } = require('electron');
const { newId } = require('./library');

const MAX_CARDS = 50;
const MAX_ADDRESSES = 50;
const ADDRESS_KEYS = ['name', 'org', 'street', 'line2', 'city', 'state', 'zip', 'country', 'phone', 'email'];

const str = (v, max = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');
const digits = (v) => String(v || '').replace(/\D/g, '');

function luhn(num) {
  if (!/^\d{12,19}$/.test(num)) return false;
  let sum = 0;
  for (let i = 0; i < num.length; i++) {
    let d = +num[num.length - 1 - i];
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function brandOf(num) {
  if (/^4/.test(num)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(num)) return 'Mastercard';
  if (/^3[47]/.test(num)) return 'Amex';
  if (/^9792/.test(num)) return 'Troy';
  if (/^(6011|65|64[4-9])/.test(num)) return 'Discover';
  return 'Kart';
}

function cleanMonth(v) {
  const m = parseInt(digits(v), 10);
  return m >= 1 && m <= 12 ? m : 0;
}

function cleanYear(v) {
  let y = parseInt(digits(v), 10);
  if (!y) return 0;
  if (y < 100) y += 2000;
  return y >= 2000 && y <= 2100 ? y : 0;
}

function sanitizeAutofill(obj) {
  const cards = (Array.isArray(obj?.cards) ? obj.cards : [])
    .filter((c) => c && typeof c.num === 'string' && /^\d{4}$/.test(c.last4 || ''))
    .slice(0, MAX_CARDS)
    .map((c) => ({ id: typeof c.id === 'string' ? c.id : newId('c'), name: str(c.name, 100), num: c.num, last4: c.last4, brand: str(c.brand, 20) || 'Kart', expM: cleanMonth(c.expM), expY: cleanYear(c.expY), used: Number(c.used) || 0 }));
  const addresses = (Array.isArray(obj?.addresses) ? obj.addresses : [])
    .filter((a) => a && typeof a === 'object')
    .slice(0, MAX_ADDRESSES)
    .map((a) => {
      const out = { id: typeof a.id === 'string' ? a.id : newId('a'), used: Number(a.used) || 0 };
      for (const k of ADDRESS_KEYS) out[k] = str(a[k], k === 'street' ? 300 : 120);
      return out;
    });
  return { cards, addresses };
}

class Autofill {
  constructor(ctl, store) {
    this.ctl = ctl;
    this.store = store;
  }

  get cards() {
    return this.store.data.cards;
  }

  get addresses() {
    return this.store.data.addresses;
  }

  available() {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  _changed() {
    this.store.save();
    for (const w of this.ctl.windows) w.sendEvent('autofill-changed', {});
  }

  _num(card) {
    try {
      return safeStorage.decryptString(Buffer.from(card.num, 'base64'));
    } catch {
      return null;
    }
  }

  /** What the settings page shows: never a full card number. */
  list() {
    return {
      cards: this.cards.map((c) => ({ id: c.id, name: c.name, last4: c.last4, brand: c.brand, exp: c.expM && c.expY ? `${String(c.expM).padStart(2, '0')}/${String(c.expY).slice(2)}` : '' })),
      addresses: this.addresses.map((a) => ({ ...a }))
    };
  }

  remove(kind, id) {
    const list = kind === 'card' ? this.cards : this.addresses;
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    this._changed();
    return true;
  }

  saveCard({ number, name, expM, expY }) {
    const num = digits(number);
    if (!luhn(num) || !this.available()) return false;
    const had = this.cards.find((c) => c.last4 === num.slice(-4) && this._num(c) === num);
    if (had) {
      Object.assign(had, { name: str(name, 100) || had.name, expM: cleanMonth(expM) || had.expM, expY: cleanYear(expY) || had.expY });
    } else {
      if (this.cards.length >= MAX_CARDS) this.cards.shift();
      this.cards.push({ id: newId('c'), name: str(name, 100), num: safeStorage.encryptString(num).toString('base64'), last4: num.slice(-4), brand: brandOf(num), expM: cleanMonth(expM), expY: cleanYear(expY), used: Date.now() });
    }
    this._changed();
    return true;
  }

  saveAddress(a) {
    const clean = {};
    for (const k of ADDRESS_KEYS) clean[k] = str(a[k], k === 'street' ? 300 : 120);
    const same = this.addresses.find((x) => ADDRESS_KEYS.every((k) => !clean[k] || x[k] === clean[k]));
    if (same) {
      for (const k of ADDRESS_KEYS) if (clean[k]) same[k] = clean[k];
    } else {
      if (this.addresses.length >= MAX_ADDRESSES) this.addresses.shift();
      this.addresses.push({ id: newId('a'), ...clean, used: Date.now() });
    }
    this._changed();
    return true;
  }

  _knownCard(num) {
    return this.cards.find((c) => c.last4 === num.slice(-4) && this._num(c) === num);
  }

  _knownAddress(a) {
    return this.addresses.find((x) => ADDRESS_KEYS.every((k) => !a[k] || x[k] === a[k]));
  }

  /** A form with a card / an address was sent: ask once whether to keep it. */
  onCapture(tab, msg) {
    const s = this.ctl.settings.data;
    if (!tab || tab.win.incognito || tab.win.win.isDestroyed()) return;
    if (msg.type === 'card') {
      const num = digits(msg.number);
      if (!s.autofillCards || !luhn(num) || !this.available() || this._knownCard(num)) return;
      const label = `${brandOf(num)} •••• ${num.slice(-4)}`;
      tab.win.dismissInfobar((b) => b.type === 'autofill' && b.tabId === tab.id);
      tab.win.showInfobar({
        type: 'autofill',
        mode: 'card',
        tabId: tab.id,
        host: label,
        username: str(msg.name, 100),
        resolve: (choice) => choice === 'save' && this.saveCard({ number: num, name: msg.name, expM: msg.expM, expY: msg.expY }) && this.ctl.toast(this.ctl.t('Kart kaydedildi'), 'check')
      });
    } else if (msg.type === 'address') {
      const a = {};
      for (const k of ADDRESS_KEYS) a[k] = str(msg[k], k === 'street' ? 300 : 120);
      if (!s.autofillAddresses || !a.street || !(a.city || a.zip) || this._knownAddress(a)) return;
      tab.win.dismissInfobar((b) => b.type === 'autofill' && b.tabId === tab.id);
      tab.win.showInfobar({
        type: 'autofill',
        mode: 'address',
        tabId: tab.id,
        host: [a.name, a.street].filter(Boolean).join(', ').slice(0, 80),
        username: [a.city, a.zip].filter(Boolean).join(' '),
        resolve: (choice) => choice === 'save' && this.saveAddress(a) && this.ctl.toast(this.ctl.t('Adres kaydedildi'), 'check')
      });
    }
  }

  install() {
    // Only our own tabs (and their sign-in pop-ups), never other webContents.
    const fromTab = (event) => {
      const tab = this.ctl.tabByWcId(event.sender.id);
      return tab && event.senderFrame ? { tab, url: event.senderFrame.url || '' } : null;
    };
    const secure = (url) => /^https:/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url);
    ipcMain.on('techin:af', (event, msg) => {
      try {
        const src = fromTab(event);
        if (!src || !msg || typeof msg !== 'object') return;
        if (msg.type === 'card' && !secure(src.url)) return;
        this.onCapture(src.tab, msg);
      } catch (err) {
        console.error('[autofill]', err);
      }
    });
    // Suggestions: labels only.
    ipcMain.handle('techin:af-query', (event, kind) => {
      const src = fromTab(event);
      const s = this.ctl.settings.data;
      if (!src || src.tab.win.incognito) return [];
      if (kind === 'card') {
        if (!s.autofillCards || !secure(src.url)) return [];
        return [...this.cards].sort((a, b) => b.used - a.used).map((c) => ({ id: c.id, title: `${c.brand} •••• ${c.last4}`, sub: [c.name, c.expM && c.expY ? `${String(c.expM).padStart(2, '0')}/${String(c.expY).slice(2)}` : ''].filter(Boolean).join(' · ') }));
      }
      if (kind === 'address') {
        if (!s.autofillAddresses) return [];
        return [...this.addresses].sort((a, b) => b.used - a.used).map((a) => ({ id: a.id, title: a.name || a.street, sub: [a.street, a.city].filter(Boolean).join(', ').slice(0, 80) }));
      }
      return [];
    });
    // The data itself, after a real click on a suggestion (checked in the page's isolated world).
    ipcMain.handle('techin:af-fill', (event, kind, id) => {
      const src = fromTab(event);
      const s = this.ctl.settings.data;
      if (!src || src.tab.win.incognito || typeof id !== 'string') return null;
      if (kind === 'card') {
        const c = s.autofillCards && secure(src.url) && this.cards.find((x) => x.id === id);
        const number = c && this._num(c);
        if (!number) return null;
        c.used = Date.now();
        this.store.save();
        return { number, name: c.name, expM: c.expM, expY: c.expY };
      }
      if (kind === 'address') {
        const a = s.autofillAddresses && this.addresses.find((x) => x.id === id);
        if (!a) return null;
        a.used = Date.now();
        this.store.save();
        const out = {};
        for (const k of ADDRESS_KEYS) out[k] = a[k];
        return out;
      }
      return null;
    });
  }
}

module.exports = { Autofill, sanitizeAutofill, luhn, brandOf, ADDRESS_KEYS };
