'use strict';
// Chrome extensions. Installing/updating from the Chrome Web Store is done by
// electron-chrome-web-store; Electron itself runs the extensions but lacks much
// of Chrome's extension API. src/preload/extension.js fills that gap inside
// every extension context and asks this module, which answers from this
// browser's own tabs and windows: toolbar button (+ popup), context menus,
// tabs, windows, notifications, offscreen documents, cookies, downloads.
// Only the normal (non-incognito) profile has extensions, like Chrome.
const fs = require('node:fs');
const path = require('node:path');
const { app, session, ipcMain, webContents, WebContentsView, BrowserWindow, Notification, nativeImage } = require('electron');

const EXT_URL = /^chrome-extension:\/\/([a-p]{32})(?:\/|$)/;
const STORE_URL = 'https://chromewebstore.google.com/';
const PRELOAD = path.join(__dirname, '..', 'preload', 'extension.js');
const SYNTHETIC_TAB_BASE = 1000000;
const DEBUG = !app.isPackaged && !!process.env.TECHIN_EXT_DEBUG;

const extIdOf = (url) => {
  const m = EXT_URL.exec(String(url || ''));
  return m ? m[1] : null;
};

/** Chrome match pattern ("*://*.example.com/*", "<all_urls>") -> RegExp. */
function matchPattern(p) {
  if (p === '<all_urls>') return /^(https?|file|ftp):\/\//;
  const m = /^(\*|https?|file|ftp|wss?|chrome-extension):\/\/([^/]*)(\/.*)?$/.exec(String(p));
  if (!m) return null;
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const scheme = m[1] === '*' ? 'https?' : esc(m[1]);
  let host = m[2];
  if (host === '*') host = '[^/]*';
  else if (host.startsWith('*.')) host = '(?:[^/]*\\.)?' + esc(host.slice(2));
  else host = esc(host);
  const pathRe = esc(m[3] || '/').replace(/\*/g, '.*');
  return new RegExp(`^${scheme}://${host}(?::\\d+)?${pathRe}$`);
}

function matchesAny(patterns, url) {
  if (!Array.isArray(patterns) || !patterns.length) return true;
  return patterns.some((p) => {
    const re = matchPattern(p);
    return re ? re.test(url) : false;
  });
}

const globRe = (g) => new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');

/** Font family names installed on this computer (Windows keeps them in the registry). */
function systemFonts() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(['Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana']);
    const names = new Set();
    const keys = ['HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'];
    let left = keys.length;
    for (const key of keys) {
      require('node:child_process').execFile('reg', ['query', key], { windowsHide: true, timeout: 5000 }, (err, out) => {
        if (!err) {
          for (const line of String(out).split(/\r?\n/)) {
            const m = /^\s+(.+?)\s+REG_SZ\s/.exec(line);
            if (!m) continue;
            const name = m[1]
              .replace(/\s*\((TrueType|OpenType|All res)\)\s*$/i, '')
              .replace(/\s+(Bold|Italic|Light|Semibold|SemiBold|Black|Medium|Thin|ExtraLight|Regular|Oblique|Condensed|Demibold|Heavy)(\s+(Bold|Italic|Oblique))*$/i, '')
              .split(' & ')[0]
              .trim();
            if (name && name.length < 80) names.add(name);
          }
        }
        if (--left === 0) resolve([...names].sort((a, b) => a.localeCompare(b)).slice(0, 1000));
      });
    }
  });
}

function cssColor(c) {
  if (typeof c === 'string') return c.slice(0, 40);
  if (Array.isArray(c) && c.length >= 3) return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${c.length > 3 ? (c[3] | 0) / 255 : 1})`;
  return null;
}

class Extensions {
  constructor(ctl) {
    this.ctl = ctl;
    this.ses = session.defaultSession;
    this.dir = path.join(ctl.userData, 'Extensions');
    this.actions = new Map(); // extId -> { g: state, t: Map(tabId -> state) }
    this.menus = new Map(); // extId -> Map(menuId -> item), in creation order
    this.listening = new Map(); // extId -> Set(event name)
    this.cache = new Map(); // extId -> { name, icon, messages }
    this.offscreen = new Map(); // extId -> BrowserWindow
    this.notes = new Map(); // `${extId}\n${notificationId}` -> Notification
    this.workers = new WeakSet(); // ServiceWorkerMain objects we wired
    this.synthetic = new Map(); // techin tab id -> id for tabs without a page
    this.snapshots = new Map(); // tabId -> last reported tab fields (tabs.onUpdated)
    this.popup = null;
    this.downloadSeq = 0;
    this.ready = false;
    // Kept on disk like Chrome: installed versions (to tell install / update)
    // and context menus (extensions create them once, in onInstalled).
    this.stateFile = path.join(ctl.userData, 'extensions.json');
    this.saved = { versions: {}, menus: {} };
    this.pending = new Map(); // extId -> [event name, args] waiting for the worker's listener
  }

  get api() {
    return this.ses.extensions || this.ses;
  }

  // ------------------------------------------------------------ setup

  async init() {
    const ses = this.ses;
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (s && typeof s === 'object') this.saved = { versions: s.versions && typeof s.versions === 'object' ? s.versions : {}, menus: s.menus && typeof s.menus === 'object' ? s.menus : {} };
    } catch {}
    for (const [id, list] of Object.entries(this.saved.menus)) {
      if (/^[a-p]{32}$/.test(id) && Array.isArray(list)) this.menus.set(id, new Map(list.filter((it) => it && it.id != null).slice(0, 1000).map((it) => [it.id, it])));
    }
    ses.registerPreloadScript({ id: 'techin-extensions', type: 'frame', filePath: PRELOAD });
    try {
      ses.registerPreloadScript({ id: 'techin-extensions-sw', type: 'service-worker', filePath: PRELOAD });
    } catch (err) {
      console.error('[extensions] service worker preload', err);
    }
    ipcMain.handle('techin-ext', (e, method, args) => {
      const id = this._frameExtId(e);
      if (!id) throw new Error('Forbidden');
      return this.call(id, method, args, { wc: e.sender });
    });
    ipcMain.on('techin-ext-listen', (e, name) => {
      const id = this._frameExtId(e);
      if (id) this._listen(id, name);
    });
    ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
      if (runningStatus === 'starting' || runningStatus === 'running') this._wireWorker(versionId);
    });
    this.api.on('extension-loaded', (_e, ext) => this._onLoaded(ext));
    this.api.on('extension-unloaded', (_e, ext) => {
      this._rebindStorePages();
      this._forget(ext.id);
    });
    ses.cookies.on('changed', (_e, cookie, cause, removed) => {
      const url = `http${cookie.secure ? 's' : ''}://${String(cookie.domain || '').replace(/^\./, '')}${cookie.path || '/'}`;
      for (const id of this._listeners('cookies.onChanged')) {
        if (this._has(id, 'cookies') && this._hostAllowed(id, url)) this._emit(id, 'cookies.onChanged', [{ removed, cause, cookie: this._cookie(cookie) }]);
      }
    });

    const { installChromeWebStore } = require('electron-chrome-web-store');
    await installChromeWebStore({
      session: ses,
      extensionsPath: this.dir,
      autoUpdate: true,
      beforeInstall: (d) => this._confirmInstall(d)
    });
    this.ready = true;
    this._changed();
  }

  _frameExtId(e) {
    const url = (e.senderFrame && e.senderFrame.url) || (e.sender && !e.sender.isDestroyed() ? e.sender.getURL() : '');
    const id = extIdOf(url);
    return id && this.api.getExtension(id) ? id : null;
  }

  /** Each (re)start of an extension's worker: answer its calls (idempotent). */
  _wireWorker(versionId) {
    let w;
    try {
      w = this.ses.serviceWorkers.getWorkerFromVersionID(versionId);
    } catch {
      return;
    }
    this._wire(w);
  }

  /** Every ServiceWorkerMain handle we get (a woken worker may come as a new one). */
  _wire(w) {
    const id = w && extIdOf(w.scope);
    if (!id || this.workers.has(w)) return w;
    this.workers.add(w);
    w.ipc.removeHandler('techin-ext');
    w.ipc.handle('techin-ext', (_e, method, args) => this.call(id, method, args, { worker: w }));
    w.ipc.removeAllListeners('techin-ext-listen');
    w.ipc.on('techin-ext-listen', (_e, name) => this._listen(id, name));
    return w;
  }

  _listen(id, name) {
    if (typeof name !== 'string' || name.length > 80) return;
    if (!this.listening.has(id)) this.listening.set(id, new Set());
    this.listening.get(id).add(name);
    // The worker just subscribed to onInstalled / onStartup: deliver the one waiting.
    const p = this.pending.get(id);
    if (p && p[0] === name) {
      this.pending.delete(id);
      setTimeout(() => this._emit(id, p[0], p[1]), 0);
    }
  }

  /** Chromium restores its broken store API on store pages after every (un)install (src/preload/page.js). */
  _rebindStorePages() {
    for (const wc of webContents.getAllWebContents()) {
      try {
        if (!wc.isDestroyed() && /^https:\/\/chromewebstore\.google\.com\//.test(wc.getURL())) wc.mainFrame.send('techin:store-rebind');
      } catch {}
    }
  }

  /** A loaded extension: new, updated or just the browser starting. */
  _onLoaded(ext) {
    this._rebindStorePages();
    const before = this.saved.versions[ext.id];
    if (before !== ext.version) {
      // Chrome drops an extension's context menus on install/update; onInstalled makes them again.
      this.menus.delete(ext.id);
      delete this.saved.menus[ext.id];
      this.pending.set(ext.id, ['runtime.onInstalled', [before ? { reason: 'update', previousVersion: before } : { reason: 'install' }]]);
      this.saved.versions[ext.id] = ext.version;
      this._save();
    } else {
      this.pending.set(ext.id, ['runtime.onStartup', []]);
    }
    this._changed();
  }

  _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(this.stateFile, JSON.stringify(this.saved));
      } catch (err) {
        console.error('[extensions] save', err.message);
      }
    }, 300);
  }

  _menusChanged(id) {
    const items = this.menus.get(id);
    if (items && items.size) this.saved.menus[id] = [...items.values()];
    else delete this.saved.menus[id];
    this._save();
  }

  _listeners(name) {
    const out = [];
    for (const [id, set] of this.listening) if (set.has(name) && this.api.getExtension(id)) out.push(id);
    return out;
  }

  /** Sends an event to the extension's pages and its service worker (started if needed). */
  _emit(id, name, args) {
    if (DEBUG) console.log('[ext] emit', Date.now(), id.slice(0, 6), name, this.listening.get(id)?.has(name) ? '' : '(no listener)');
    if (!this.listening.get(id)?.has(name)) return;
    const prefix = `chrome-extension://${id}/`;
    for (const wc of webContents.getAllWebContents()) {
      try {
        if (!wc.isDestroyed() && wc.getURL().startsWith(prefix)) wc.send('techin-ext-event', name, args);
      } catch {}
    }
    const ext = this.api.getExtension(id);
    if (!ext?.manifest?.background?.service_worker) return;
    const running = Object.entries(this.ses.serviceWorkers.getAllRunning()).find(([, info]) => info.scope === prefix);
    const send = (w) => {
      try {
        this._wire(w).send('techin-ext-event', name, args);
      } catch {}
    };
    if (running) {
      const w = this.ses.serviceWorkers.getWorkerFromVersionID(Number(running[0]));
      if (w) return send(w);
    }
    this.ses.serviceWorkers
      .startWorkerForScope(prefix)
      .then(send)
      .catch(() => {});
  }

  _broadcast(name, args) {
    for (const id of this._listeners(name)) {
      // Navigation events carry every address you visit: only for extensions that asked for them.
      if (name.startsWith('webNavigation.') && !this._has(id, 'webNavigation')) continue;
      this._emit(id, name, typeof args === 'function' ? args(id) : args);
    }
  }

  _forget(id) {
    this.actions.delete(id);
    this.listening.delete(id);
    this.pending.delete(id);
    this.cache.delete(id);
    const off = this.offscreen.get(id);
    if (off && !off.isDestroyed()) off.destroy();
    this.offscreen.delete(id);
    if (this.popup && this.popup.id === id) this.closePopup();
    this._changed();
  }

  _changed() {
    clearTimeout(this._changedTimer);
    this._changedTimer = setTimeout(() => this.ctl.broadcastState(), 30);
  }

  // ------------------------------------------------------------ installing / removing

  async _confirmInstall(d) {
    let w = null;
    try {
      const owner = d.frame && webContents.fromFrame(d.frame);
      const tab = owner && this.ctl.tabByWcId(owner.id);
      w = tab ? tab.win : this.ctl.lastWindow();
    } catch {}
    if (!w || w.incognito) return { action: 'deny' };
    const perms = this._permissionWarnings(d.manifest);
    const icon = d.icon && !d.icon.isEmpty() ? d.icon.resize({ width: 48 }).toDataURL() : null;
    return await new Promise((resolve) => {
      w.openModal({
        type: 'extInstall',
        data: { id: d.id, name: String(d.localizedName || d.manifest.name || '').slice(0, 100), icon, perms },
        onClose: (result) => resolve({ action: result && result.ok ? 'allow' : 'deny' })
      });
    });
  }

  /** Human words for what an extension may do (shown before installing). */
  _permissionWarnings(manifest) {
    const t = this.ctl.t.bind(this.ctl);
    const perms = new Set([...(manifest.permissions || []), ...(manifest.host_permissions || [])]);
    const cs = (manifest.content_scripts || []).flatMap((c) => c.matches || []);
    const out = [];
    const hosts = [...perms].filter((p) => typeof p === 'string' && (p.includes('://') || p === '<all_urls>')).concat(cs);
    if (hosts.some((h) => h === '<all_urls>' || /^(\*|https?):\/\/\*\//.test(h))) out.push(t('Tüm web sitelerindeki verilerinizi okuyup değiştirebilir'));
    else if (hosts.length) out.push(t('Şu sitelerdeki verilerinizi okuyup değiştirebilir: {0}', [...new Set(hosts.map((h) => h.replace(/^[^:]+:\/\/|\/.*$/g, '')))].slice(0, 5).join(', ')));
    if (perms.has('tabs') || perms.has('webNavigation')) out.push(t('Tarama geçmişinizi okuyabilir'));
    if (perms.has('cookies')) out.push(t('Çerezleri okuyup değiştirebilir'));
    if (perms.has('downloads')) out.push(t('İndirmeleri yönetebilir'));
    if (perms.has('notifications')) out.push(t('Bildirim gösterebilir'));
    if (perms.has('clipboardRead')) out.push(t('Panonuzu okuyabilir'));
    if (perms.has('nativeMessaging')) out.push(t('Bilgisayardaki başka programlarla konuşmak isteyebilir (desteklenmiyor)'));
    return out.slice(0, 8);
  }

  async uninstall(id) {
    if (!this.api.getExtension(id)) return false;
    const { uninstallExtension } = require('electron-chrome-web-store');
    try {
      await uninstallExtension(id, { session: this.ses, extensionsPath: this.dir });
    } catch (err) {
      console.error('[extensions] uninstall', err);
      try {
        this.api.removeExtension(id);
      } catch {}
    }
    this._forget(id);
    this.menus.delete(id);
    delete this.saved.menus[id];
    delete this.saved.versions[id];
    this._save();
    return true;
  }

  // ------------------------------------------------------------ names, icons

  _messages(ext) {
    const c = this.cache.get(ext.id) || {};
    if (c.messages) return c.messages;
    const tryLang = [this.ctl.lang, this.ctl.lang === 'tr' ? 'tr_TR' : 'en_US', 'en', ext.manifest.default_locale].filter(Boolean);
    let messages = {};
    for (const l of tryLang) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(ext.path, '_locales', l, 'messages.json'), 'utf8'));
        messages = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v && v.message]));
        break;
      } catch {}
    }
    c.messages = messages;
    this.cache.set(ext.id, c);
    return messages;
  }

  _text(ext, s) {
    const m = /^__MSG_(\w+)__$/.exec(String(s || ''));
    if (!m) return String(s || '');
    return this._messages(ext)[m[1].toLowerCase()] || '';
  }

  name(ext) {
    return this._text(ext, ext.manifest.name) || ext.name || ext.id;
  }

  /** Best icon file near 32 px from a Chrome icon spec (string or {size: path}). */
  _iconFile(ext, spec) {
    if (!spec) return null;
    let rel = spec;
    if (typeof spec === 'object') {
      const sizes = Object.keys(spec).filter((k) => /^\d+$/.test(k)).map(Number);
      if (!sizes.length) return null;
      const best = sizes.sort((a, b) => (a >= 32) - (b >= 32) || (a >= 32 ? a - b : b - a))[0];
      rel = spec[best];
    }
    if (typeof rel !== 'string') return null;
    const file = path.resolve(ext.path, rel.replace(/^\/+/, ''));
    return file.startsWith(path.resolve(ext.path) + path.sep) ? file : null;
  }

  _imageUrl(file) {
    if (!file) return null;
    try {
      const img = nativeImage.createFromPath(file);
      if (img.isEmpty()) return null;
      const size = img.getSize();
      return (size.width > 64 ? img.resize({ width: 64, quality: 'best' }) : img).toDataURL();
    } catch {
      return null;
    }
  }

  icon(ext) {
    const c = this.cache.get(ext.id) || {};
    if (c.icon === undefined) {
      const a = ext.manifest.action || ext.manifest.browser_action || {};
      c.icon = this._imageUrl(this._iconFile(ext, a.default_icon)) || this._imageUrl(this._iconFile(ext, ext.manifest.icons)) || null;
      this.cache.set(ext.id, c);
    }
    return c.icon;
  }

  list() {
    return this.api
      .getAllExtensions()
      .filter((e) => e.manifest && !e.manifest.theme)
      .map((ext) => ({
        id: ext.id,
        name: this.name(ext),
        version: ext.version,
        description: this._text(ext, ext.manifest.description).slice(0, 300),
        icon: this.icon(ext),
        options: !!this._optionsPage(ext),
        pinned: !this.ctl.settings.data.extUnpinned.includes(ext.id)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ------------------------------------------------------------ toolbar button

  _act(id) {
    let a = this.actions.get(id);
    if (!a) {
      const ext = this.api.getExtension(id);
      const def = (ext && (ext.manifest.action || ext.manifest.browser_action)) || {};
      a = { g: { title: this._text(ext, def.default_title) || '', badge: '', color: null, textColor: null, popup: def.default_popup || '', icon: null, enabled: true }, t: new Map() };
      this.actions.set(id, a);
    }
    return a;
  }

  _actGet(id, tabId, key) {
    const a = this._act(id);
    const per = tabId != null ? a.t.get(tabId) : null;
    return per && per[key] !== undefined ? per[key] : a.g[key];
  }

  _actSet(id, tabId, key, value) {
    const a = this._act(id);
    if (tabId != null) {
      if (!a.t.has(tabId)) a.t.set(tabId, {});
      a.t.get(tabId)[key] = value;
    } else {
      a.g[key] = value;
    }
    this._changed();
  }

  /** Toolbar buttons for a window's UI (state for its active tab). */
  uiState(w) {
    if (!this.ready || w.incognito) return null;
    const tab = w.activeTab();
    const tabId = tab ? this.tabId(tab) : null;
    const unpinned = this.ctl.settings.data.extUnpinned;
    const items = [];
    let count = 0;
    for (const ext of this.api.getAllExtensions()) {
      if (!ext.manifest || ext.manifest.theme) continue;
      count++;
      if (unpinned.includes(ext.id)) continue;
      const get = (k) => this._actGet(ext.id, tabId, k);
      items.push({
        id: ext.id,
        name: this.name(ext),
        title: get('title') || this.name(ext),
        icon: get('icon') || this.icon(ext),
        badge: String(get('badge') || '').slice(0, 4),
        color: cssColor(get('color')),
        textColor: cssColor(get('textColor')),
        enabled: get('enabled') !== false,
        open: !!(this.popup && this.popup.win === w && this.popup.id === ext.id)
      });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { items, count };
  }

  /** Toolbar button clicked: open its popup or tell the extension. */
  activate(w, id, rect) {
    const ext = this.api.getExtension(id);
    if (!ext || w.incognito) return;
    if (this.popup && this.popup.win === w && this.popup.id === id) return this.closePopup();
    // Clicking the button of an open popup first closes it (focus left it): don't reopen.
    const c = this._closed;
    if (c && c.id === id && c.win === w && Date.now() - c.at < 400) return;
    const tab = w.activeTab();
    const tabId = tab ? this.tabId(tab) : null;
    if (this._actGet(id, tabId, 'enabled') === false) return;
    const popup = this._actGet(id, tabId, 'popup');
    if (popup) return this.openPopup(w, id, popup, rect);
    this.closePopup();
    this._emit(id, 'action.onClicked', [tab ? this.tabInfo(tab, id) : null]);
  }

  openPopup(w, id, rel, rect) {
    this.closePopup();
    const url = /^chrome-extension:/.test(rel) ? rel : `chrome-extension://${id}/${String(rel).replace(/^\/+/, '')}`;
    if (extIdOf(url) !== id) return;
    const view = new WebContentsView({
      webPreferences: { session: this.ses, sandbox: true, contextIsolation: true, nodeIntegration: false, enablePreferredSizeMode: true, backgroundThrottling: false, webviewTag: false }
    });
    // White like Chrome: popups are designed for it (dark ones paint their own background).
    view.setBackgroundColor('#ffffffff');
    try {
      view.setBorderRadius(10);
    } catch {}
    const p = { win: w, id, view, rect: rect || { x: 0, y: 0, width: 0, height: 0 }, size: { width: 0, height: 0 } };
    this.popup = p;
    const wc = view.webContents;
    wc.on('preferred-size-changed', (_e, size) => {
      p.size = size;
      if (this.popup === p) this._placePopup();
    });
    wc.on('blur', () =>
      setTimeout(() => {
        if (this.popup === p && !wc.isDestroyed() && !wc.isFocused() && !wc.isDevToolsOpened()) this.closePopup();
      }, 80)
    );
    wc.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        e.preventDefault();
        this.closePopup();
      } else if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged) {
        wc.openDevTools({ mode: 'detach' });
      }
    });
    wc.setWindowOpenHandler(({ url: u }) => {
      this._openInTab(w, u, id, true);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e) => {
      if (extIdOf(e.url) === id) return;
      e.preventDefault();
      this._openInTab(w, e.url, id, true);
      this.closePopup();
    });
    wc.on('render-process-gone', () => this.popup === p && this.closePopup());
    // A hairline edge so a white popup stands apart from a white page (Chrome has a shadow).
    wc.on('dom-ready', () => {
      wc.insertCSS(':root::after{content:"";position:fixed;inset:0;border:1px solid rgba(128,128,128,.38);border-radius:10px;pointer-events:none;z-index:2147483647}', { cssOrigin: 'user' }).catch(() => {});
    });
    wc.on('context-menu', (_e, params) => this.ctl.menus.editMenu(w, params));
    view.setBounds({ x: p.rect.x, y: p.rect.y + p.rect.height + 6, width: 1, height: 1 });
    w.win.contentView.addChildView(view);
    wc.loadURL(url)
      .then(() => {
        if (this.popup === p) wc.focus();
      })
      .catch(() => this.popup === p && this.closePopup());
    w.scheduleState();
  }

  _placePopup() {
    const p = this.popup;
    if (!p || p.win.win.isDestroyed()) return;
    const [W, H] = p.win.win.getContentSize();
    const width = Math.max(25, Math.min(800, Math.ceil(p.size.width || 0)));
    const height = Math.max(25, Math.min(600, Math.ceil(p.size.height || 0)));
    const right = p.rect.x + p.rect.width;
    const x = Math.max(8, Math.min(W - width - 8, right - width));
    const y = Math.max(8, Math.min(p.rect.y + p.rect.height + 6, H - height - 8));
    p.view.setBounds({ x, y, width, height });
  }

  closePopup() {
    const p = this.popup;
    if (!p) return false;
    this.popup = null;
    this._closed = { id: p.id, win: p.win, at: Date.now() };
    try {
      if (!p.win.win.isDestroyed()) p.win.win.contentView.removeChildView(p.view);
    } catch {}
    if (!p.view.webContents.isDestroyed()) p.view.webContents.close();
    if (!p.win.win.isDestroyed()) {
      p.win.focusPage();
      p.win.scheduleState();
    }
    return true;
  }

  /** Keeps the popup above the page and the UI (window.js calls this after reordering). */
  raise(w) {
    if (this.popup && this.popup.win === w && !w.win.isDestroyed()) {
      w.win.contentView.addChildView(this.popup.view);
      this._placePopup();
    }
  }

  onWindowClosed(w) {
    if (this.popup && this.popup.win === w) this.closePopup();
    this._broadcast('windows.onRemoved', [w.win.id]);
  }

  // ------------------------------------------------------------ context menus

  _itemMatches(item, ctx, pageUrl, params) {
    if (item.visible === false) return false;
    const contexts = Array.isArray(item.contexts) && item.contexts.length ? item.contexts : ['page'];
    if (!contexts.some((c) => c === 'all' || ctx.has(c))) return false;
    if (!matchesAny(item.documentUrlPatterns, pageUrl)) return false;
    const target = params.linkURL || params.srcURL;
    if (item.targetUrlPatterns && target && !matchesAny(item.targetUrlPatterns, target)) return false;
    return true;
  }

  /** Extension entries for a page's right-click menu. */
  pageMenuItems(tab, params) {
    if (!this.ready || tab.win.incognito || !this.menus.size) return [];
    const ctx = new Set();
    const sel = params.selectionText && params.selectionText.trim();
    if (sel) ctx.add('selection');
    if (params.linkURL) ctx.add('link');
    if (params.isEditable) ctx.add('editable');
    if (['image', 'video', 'audio'].includes(params.mediaType)) ctx.add(params.mediaType);
    if (params.frameURL) ctx.add('frame');
    if (!ctx.size) ctx.add('page');
    const info = {
      editable: !!params.isEditable,
      pageUrl: tab.url,
      frameId: params.frameURL ? undefined : 0,
      ...(params.frameURL ? { frameUrl: params.frameURL } : {}),
      ...(params.linkURL ? { linkUrl: params.linkURL } : {}),
      ...(params.srcURL ? { srcUrl: params.srcURL } : {}),
      ...(sel ? { selectionText: params.selectionText } : {}),
      ...(params.mediaType && params.mediaType !== 'none' ? { mediaType: params.mediaType } : {})
    };
    return this._menuItems(ctx, tab, info, params);
  }

  /** Extension entries for its toolbar button's right-click menu. */
  actionMenuItems(w, id) {
    const tab = w.activeTab();
    return this._menuItems(new Set(['action', 'browser_action']), tab, { pageUrl: tab ? tab.url : '', editable: false }, {}, id);
  }

  _menuItems(ctx, tab, info, params, onlyId = null) {
    const out = [];
    const pageUrl = tab ? tab.url : '';
    for (const [id, items] of this.menus) {
      if (onlyId && id !== onlyId) continue;
      const ext = this.api.getExtension(id);
      if (!ext) continue;
      const build = (parentId) =>
        [...items.values()]
          .filter((it) => (it.parentId ?? null) === parentId && this._itemMatches(it, ctx, pageUrl, params))
          .map((it) => {
            if (it.type === 'separator') return { type: 'separator' };
            const sel = (info.selectionText || '').replace(/\s+/g, ' ').trim();
            const label = String(it.title || '').replace(/%s/g, sel.length > 32 ? sel.slice(0, 31) + '…' : sel);
            const kids = build(it.id);
            if (kids.length) return { label, enabled: it.enabled !== false, submenu: kids };
            return {
              label,
              type: it.type === 'checkbox' ? 'checkbox' : it.type === 'radio' ? 'radio' : 'normal',
              checked: !!it.checked,
              enabled: it.enabled !== false,
              click: () => this._menuClicked(id, it, tab, info)
            };
          });
      const top = build(null);
      if (!top.length) continue;
      if (onlyId || top.length === 1) out.push(...top);
      else out.push({ label: this.name(ext), icon: this._menuIcon(ext), submenu: top });
    }
    return out;
  }

  _menuIcon(ext) {
    const url = this.icon(ext);
    if (!url) return undefined;
    try {
      return nativeImage.createFromDataURL(url).resize({ width: 16, height: 16 });
    } catch {
      return undefined;
    }
  }

  _menuClicked(id, it, tab, info) {
    const wasChecked = !!it.checked;
    if (it.type === 'checkbox') it.checked = !wasChecked;
    if (it.type === 'radio') {
      for (const other of this.menus.get(id)?.values() || []) if (other.type === 'radio' && (other.parentId ?? null) === (it.parentId ?? null)) other.checked = false;
      it.checked = true;
    }
    const data = { ...info, menuItemId: it.id, ...(it.parentId != null ? { parentMenuItemId: it.parentId } : {}) };
    if (it.type === 'checkbox' || it.type === 'radio') {
      Object.assign(data, { wasChecked, checked: !!it.checked });
      this._menusChanged(id);
    }
    this._emit(id, 'contextMenus.onClicked', [data, tab ? this.tabInfo(tab, id) : undefined]);
  }

  // ------------------------------------------------------------ tabs & windows

  _windows() {
    return [...this.ctl.windows].filter((w) => !w.incognito && !w.win.isDestroyed());
  }

  _winById(id) {
    return this._windows().find((w) => w.win.id === id) || null;
  }

  _currentWindow(from) {
    const tab = from && from.wc ? this.ctl.tabByWcId(from.wc.id) : null;
    if (tab && !tab.win.incognito) return tab.win;
    if (from && from.wc && this.popup && this.popup.view.webContents === from.wc) return this.popup.win;
    const w = this.ctl.lastWindow();
    return w && !w.incognito ? w : this._windows()[0] || null;
  }

  _winFor(windowId, from) {
    if (windowId == null || windowId === -2) return this._currentWindow(from);
    return this._winById(windowId);
  }

  tabId(tab) {
    if (tab.alive) return tab.wc.id;
    if (!this.synthetic.has(tab.id)) this.synthetic.set(tab.id, SYNTHETIC_TAB_BASE + this.synthetic.size + 1);
    return this.synthetic.get(tab.id);
  }

  _tabsOf(w) {
    const seen = new Set();
    const out = [];
    for (const { tab } of w.sidebarTabOrder()) {
      if (tab && !seen.has(tab)) {
        seen.add(tab);
        out.push(tab);
      }
    }
    for (const t of w.tabs.values()) if (!seen.has(t)) out.push(t);
    return out;
  }

  _allTabs() {
    const out = [];
    for (const w of this._windows()) this._tabsOf(w).forEach((tab, index) => out.push({ tab, w, index }));
    return out;
  }

  _findTab(tabId) {
    return this._allTabs().find((x) => this.tabId(x.tab) === tabId) || null;
  }

  _mustTab(tabId, from) {
    if (tabId == null) {
      const w = this._currentWindow(from);
      const tab = w && w.activeTab();
      if (!tab) throw new Error('No active tab');
      return { tab, w, index: this._tabsOf(w).indexOf(tab) };
    }
    const x = this._findTab(tabId);
    if (!x) throw new Error(`No tab with id: ${tabId}.`);
    return x;
  }

  _canSeeUrls(id) {
    const ext = this.api.getExtension(id);
    if (!ext) return false;
    const m = ext.manifest;
    const perms = [...(m.permissions || []), ...(m.host_permissions || []), ...(m.optional_permissions || [])];
    return perms.some((p) => p === 'tabs' || p === 'activeTab' || p === '<all_urls>' || (typeof p === 'string' && p.includes('://')));
  }

  /** The extension's host permissions cover this URL (Chrome's rule for cookies). */
  _hostAllowed(id, url) {
    const m = this.api.getExtension(id)?.manifest;
    if (!m || typeof url !== 'string') return false;
    const hosts = [...(m.host_permissions || []), ...(m.optional_host_permissions || []), ...(m.permissions || [])].filter((p) => typeof p === 'string' && (p === '<all_urls>' || p.includes('://')));
    return hosts.length > 0 && matchesAny(hosts, url);
  }

  _has(id, perm) {
    const m = this.api.getExtension(id)?.manifest;
    return !!m && [...(m.permissions || []), ...(m.optional_permissions || [])].includes(perm);
  }

  tabInfo(tab, forExt, index = null) {
    const w = tab.win;
    const idx = index ?? this._tabsOf(w).indexOf(tab);
    const b = tab.view && tab.alive ? tab.view.getBounds() : { width: 0, height: 0 };
    const info = {
      id: this.tabId(tab),
      index: idx,
      windowId: w.win.id,
      openerTabId: undefined,
      active: w.activeTabId === tab.id,
      highlighted: w.activeTabId === tab.id,
      selected: w.activeTabId === tab.id,
      pinned: tab.kind !== 'normal',
      audible: !!tab.audible,
      discarded: !tab.alive,
      autoDiscardable: true,
      frozen: false,
      mutedInfo: { muted: !!tab.muted },
      status: tab.loading ? 'loading' : 'complete',
      incognito: false,
      width: b.width,
      height: b.height,
      groupId: -1,
      lastAccessed: tab.lastActive
    };
    if (!forExt || this._canSeeUrls(forExt)) {
      info.url = tab.blankStart ? 'chrome://newtab/' : tab.url;
      info.title = tab.title || tab.url;
      if (typeof tab.favicon === 'string' && tab.favicon.length < 200000) info.favIconUrl = tab.favicon;
    }
    return info;
  }

  winInfo(w, populate, forExt) {
    const b = w.win.getBounds();
    const info = {
      id: w.win.id,
      focused: w.win.isFocused(),
      top: b.y,
      left: b.x,
      width: b.width,
      height: b.height,
      incognito: false,
      type: 'normal',
      state: w.win.isFullScreen() ? 'fullscreen' : w.win.isMinimized() ? 'minimized' : w.win.isMaximized() ? 'maximized' : 'normal',
      alwaysOnTop: false
    };
    if (populate) info.tabs = this._tabsOf(w).map((t, i) => this.tabInfo(t, forExt, i));
    return info;
  }

  _resolveUrl(id, url) {
    if (typeof url !== 'string' || !url) return null;
    try {
      const u = new URL(url, `chrome-extension://${id}/`);
      if (/^https?:$/.test(u.protocol) || (u.protocol === 'chrome-extension:' && extIdOf(u.href) === id) || u.href === 'about:blank') return u.href;
      if (u.protocol === 'chrome:' && /^chrome:\/\/(newtab|new-tab-page)\/?$/.test(u.href)) return 'about:blank';
    } catch {}
    return null;
  }

  _openInTab(w, url, id, active = true) {
    const u = this._resolveUrl(id, url);
    if (!u) return null;
    const win = w && !w.win.isDestroyed() && !w.incognito ? w : this._currentWindow(null);
    if (!win) {
      const nw = this.ctl.newWindow({ urls: [u] });
      return nw.activeTab();
    }
    const tab = win.createTab(u === 'about:blank' ? { blankStart: true } : { url: u, background: !active });
    if (!active) tab.ensureView();
    return tab;
  }

  /** chrome-extension:// pages of installed extensions may be shown in tabs. */
  isExtensionUrl(url) {
    const id = extIdOf(url);
    return !!(id && this.api.getExtension(id));
  }

  _optionsPage(ext) {
    const m = ext.manifest;
    const page = (m.options_ui && m.options_ui.page) || m.options_page;
    return typeof page === 'string' && page ? `chrome-extension://${ext.id}/${page.replace(/^\/+/, '')}` : null;
  }

  openOptions(id, w = null) {
    const ext = this.api.getExtension(id);
    const url = ext && this._optionsPage(ext);
    if (!url) return false;
    for (const { tab, w: tw } of this._allTabs()) {
      if (tab.url === url) {
        tw.activateTab(tab.id);
        tw.win.focus();
        return true;
      }
    }
    return !!this._openInTab(w, url, id, true);
  }

  // ---- events from our tabs (window.js / tab.js call these)

  attachTab(tab, wc) {
    if (tab.win.incognito) return;
    const tabId = wc.id;
    const nav = (name, extra) => ({ tabId, frameId: 0, parentFrameId: -1, processId: -1, timeStamp: Date.now(), ...extra });
    wc.on('did-start-navigation', (e) => {
      if (e.isMainFrame && !e.isSameDocument) this._broadcast('webNavigation.onBeforeNavigate', [nav('before', { url: e.url })]);
    });
    wc.on('did-navigate', (_e, url) => this._broadcast('webNavigation.onCommitted', [nav('commit', { url, transitionType: 'link', transitionQualifiers: [] })]));
    wc.on('dom-ready', () => this._broadcast('webNavigation.onDOMContentLoaded', [nav('dom', { url: wc.getURL() })]));
    wc.on('did-finish-load', () => this._broadcast('webNavigation.onCompleted', [nav('done', { url: wc.getURL() })]));
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) this._broadcast('webNavigation.onHistoryStateUpdated', [nav('hist', { url, transitionType: 'link', transitionQualifiers: [] })]);
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3) this._broadcast('webNavigation.onErrorOccurred', [nav('err', { url, error: desc })]);
    });
    wc.once('destroyed', () => {
      this.snapshots.delete(tabId);
      for (const a of this.actions.values()) a.t.delete(tabId);
      this._broadcast('tabs.onRemoved', [tabId, { windowId: tab.win.win.isDestroyed() ? -1 : tab.win.win.id, isWindowClosing: tab.win.win.isDestroyed() }]);
    });
    setImmediate(() => {
      if (!wc.isDestroyed()) this._broadcast('tabs.onCreated', (id) => [this.tabInfo(tab, id)]);
    });
  }

  onTabChanged(tab) {
    if (tab.win.incognito || !this._listeners('tabs.onUpdated').length) return;
    const tabId = this.tabId(tab);
    const now = { status: tab.loading ? 'loading' : 'complete', url: tab.url, title: tab.title, favIconUrl: tab.favicon || undefined, audible: !!tab.audible, muted: !!tab.muted, discarded: !tab.alive, pinned: tab.kind !== 'normal' };
    const prev = this.snapshots.get(tabId);
    this.snapshots.set(tabId, now);
    if (!prev) return;
    const change = {};
    for (const k of Object.keys(now)) if (now[k] !== prev[k]) change[k === 'muted' ? 'mutedInfo' : k] = k === 'muted' ? { muted: now.muted } : now[k];
    if (!Object.keys(change).length) return;
    this._broadcast('tabs.onUpdated', (id) => {
      const c = { ...change };
      if (!this._canSeeUrls(id)) delete c.url, delete c.title, delete c.favIconUrl;
      return [tabId, c, this.tabInfo(tab, id)];
    });
  }

  onTabActivated(w, tab) {
    if (w.incognito || !tab) return;
    this._broadcast('tabs.onActivated', [{ tabId: this.tabId(tab), windowId: w.win.id }]);
  }

  onWindowFocused(w) {
    if (!w.incognito) this._broadcast('windows.onFocusChanged', [w.win.id]);
  }

  // ------------------------------------------------------------ the API calls

  async call(id, method, args, from) {
    if (typeof method !== 'string' || method.length > 120) throw new Error('Bad call');
    args = Array.isArray(args) ? args : [];
    if (DEBUG) console.log('[ext] call', Date.now(), id.slice(0, 6), method, from && from.worker ? '(worker)' : '');
    const fn = CALLS[method];
    if (fn) return await fn.call(this, id, args, from || {});
    // Unsupported APIs: list-like answers are empty lists (callers .map() them), the rest nothing.
    if (method.startsWith('stub.')) return /\.(query|get|getAll\w*|get\w*List|getTree|getChildren|getRecent\w*|search|getDevices|getVoices|getDynamicRules|getSessionRules|getEnabledRulesets|getMatchedRules|getContexts)$/.test(method) ? [] : undefined;
    if (method.startsWith('unsupported.')) throw new Error('This API is not supported by Techin Browser.');
    throw new Error(`Unknown method ${method}`);
  }

  _cookie(c) {
    return {
      name: c.name,
      value: c.value,
      domain: c.domain,
      hostOnly: !!c.hostOnly,
      path: c.path,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || 'unspecified',
      session: !!c.session,
      ...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
      storeId: '0'
    };
  }
}

const num = (v) => (Number.isInteger(v) ? v : null);

// Each receives (extId, args, from) with `this` = Extensions.
const CALLS = {
  // ---- tabs
  'tabs.query'(id, [q = {}], from) {
    q = q || {};
    const cur = this._currentWindow(from);
    const last = this.ctl.lastWindow();
    const urls = q.url == null ? null : (Array.isArray(q.url) ? q.url : [q.url]).map(matchPattern).filter(Boolean);
    const title = typeof q.title === 'string' ? globRe(q.title) : null;
    return this._allTabs()
      .filter(({ tab, w, index }) => {
        const active = w.activeTabId === tab.id;
        if (q.active != null && q.active !== active) return false;
        if (q.highlighted != null && q.highlighted !== active) return false;
        if (q.currentWindow != null && q.currentWindow !== (w === cur)) return false;
        if (q.lastFocusedWindow != null && q.lastFocusedWindow !== (w === last)) return false;
        if (q.windowId != null && (q.windowId === -2 ? w !== cur : w.win.id !== q.windowId)) return false;
        if (q.pinned != null && q.pinned !== (tab.kind !== 'normal')) return false;
        if (q.audible != null && q.audible !== !!tab.audible) return false;
        if (q.muted != null && q.muted !== !!tab.muted) return false;
        if (q.discarded != null && q.discarded !== !tab.alive) return false;
        if (q.status != null && q.status !== (tab.loading ? 'loading' : 'complete')) return false;
        if (q.index != null && q.index !== index) return false;
        if (q.windowType != null && q.windowType !== 'normal') return false;
        if (urls && !urls.some((re) => re.test(tab.url))) return false;
        if (title && !title.test(tab.title || '')) return false;
        return true;
      })
      .map(({ tab, index }) => this.tabInfo(tab, id, index));
  },
  'tabs.get'(id, [tabId]) {
    const x = this._mustTab(num(tabId) ?? -1);
    return this.tabInfo(x.tab, id, x.index);
  },
  'tabs.getCurrent'(id, _a, from) {
    const tab = from.wc ? this.ctl.tabByWcId(from.wc.id) : null;
    return tab && !tab.win.incognito ? this.tabInfo(tab, id) : undefined;
  },
  'tabs.create'(id, [p = {}], from) {
    p = p || {};
    const w = this._winFor(num(p.windowId), from);
    const url = p.url ? this._resolveUrl(id, p.url) : 'about:blank';
    if (!url) throw new Error('Invalid url');
    const tab = this._openInTab(w, url, id, p.active !== false);
    if (!tab) throw new Error('Could not create tab');
    return this.tabInfo(tab, id);
  },
  'tabs.update'(id, [tabId, p = {}], from) {
    p = p || {};
    const { tab, w } = this._mustTab(num(tabId), from);
    if (typeof p.url === 'string') {
      const url = this._resolveUrl(id, p.url);
      if (!url) throw new Error('Invalid url');
      tab.load(url);
    }
    if (p.active === true || p.highlighted === true) {
      w.activateTab(tab.id);
      if (p.active === true) w.win.focus();
    }
    if (typeof p.muted === 'boolean' && p.muted !== !!tab.muted) tab.toggleMute();
    return this.tabInfo(tab, id);
  },
  'tabs.remove'(id, [ids]) {
    for (const tabId of Array.isArray(ids) ? ids : [ids]) {
      const x = this._findTab(num(tabId));
      if (x) x.w.closeTab(x.tab.id);
    }
  },
  'tabs.reload'(id, [tabId, p], from) {
    this._mustTab(num(tabId), from).tab.reload(!!(p && p.bypassCache));
  },
  'tabs.duplicate'(id, [tabId]) {
    const { tab, w } = this._mustTab(num(tabId) ?? -1);
    w.duplicateTab(tab.id);
    const t = w.activeTab();
    return t ? this.tabInfo(t, id) : undefined;
  },
  'tabs.goBack'(id, [tabId], from) {
    this._mustTab(num(tabId), from).tab.goBack();
  },
  'tabs.goForward'(id, [tabId], from) {
    this._mustTab(num(tabId), from).tab.goForward();
  },
  'tabs.discard'(id, [tabId]) {
    const x = this._findTab(num(tabId));
    if (x) x.tab.sleep();
    return x ? this.tabInfo(x.tab, id) : undefined;
  },
  'tabs.highlight'(id, [info = {}], from) {
    const w = this._winFor(num(info && info.windowId), from);
    const first = Array.isArray(info && info.tabs) ? info.tabs[0] : info && info.tabs;
    const tab = w && Number.isInteger(first) ? this._tabsOf(w)[first] : null;
    if (tab) w.activateTab(tab.id);
    return w ? this.winInfo(w, true, id) : undefined;
  },
  'tabs.move'(id, [ids]) {
    const list = (Array.isArray(ids) ? ids : [ids]).map((t) => this._findTab(num(t))).filter(Boolean);
    const out = list.map((x) => this.tabInfo(x.tab, id, x.index));
    return Array.isArray(ids) ? out : out[0];
  },
  'tabs.group'() {
    return -1;
  },
  'tabs.ungroup'() {},
  async 'tabs.detectLanguage'(id, [tabId], from) {
    const { tab } = this._mustTab(num(tabId), from);
    if (!tab.alive) return 'und';
    const lang = await tab.wc.executeJavaScript('document.documentElement.lang || ""', false).catch(() => '');
    return (String(lang).split('-')[0] || 'und').toLowerCase().slice(0, 8);
  },
  async 'tabs.captureVisibleTab'(id, [windowId, opts], from) {
    const w = this._winFor(num(windowId), from);
    const tab = w && w.activeTab();
    if (!tab || !tab.alive) throw new Error('No visible tab');
    const img = await tab.wc.capturePage();
    if (opts && opts.format === 'png') return img.toDataURL();
    return 'data:image/jpeg;base64,' + img.toJPEG(Math.max(1, Math.min(100, (opts && opts.quality) || 92))).toString('base64');
  },

  // ---- windows
  'windows.get'(id, [winId, q], from) {
    const w = this._winFor(num(winId), from);
    if (!w) throw new Error(`No window with id: ${winId}.`);
    return this.winInfo(w, !!(q && q.populate), id);
  },
  'windows.getCurrent'(id, [q], from) {
    const w = this._currentWindow(from);
    if (!w) throw new Error('No current window');
    return this.winInfo(w, !!(q && q.populate), id);
  },
  'windows.getLastFocused'(id, [q]) {
    const w = this.ctl.lastWindow();
    if (!w || w.incognito) throw new Error('No window');
    return this.winInfo(w, !!(q && q.populate), id);
  },
  'windows.getAll'(id, [q]) {
    return this._windows().map((w) => this.winInfo(w, !!(q && q.populate), id));
  },
  'windows.create'(id, [p = {}]) {
    p = p || {};
    const urls = (Array.isArray(p.url) ? p.url : p.url ? [p.url] : []).map((u) => this._resolveUrl(id, u)).filter(Boolean);
    const w = this.ctl.newWindow({ urls });
    if (Number.isInteger(p.width) && Number.isInteger(p.height)) {
      try {
        w.win.setBounds({ width: Math.max(300, p.width), height: Math.max(200, p.height), ...(Number.isInteger(p.left) ? { x: p.left } : {}), ...(Number.isInteger(p.top) ? { y: p.top } : {}) });
      } catch {}
    }
    return this.winInfo(w, true, id);
  },
  'windows.update'(id, [winId, p = {}], from) {
    const w = this._winFor(num(winId), from);
    if (!w) throw new Error(`No window with id: ${winId}.`);
    p = p || {};
    if (p.state === 'minimized') w.win.minimize();
    else if (p.state === 'maximized') w.win.maximize();
    else if (p.state === 'normal' && (w.win.isMaximized() || w.win.isMinimized())) w.win.restore();
    if (p.focused === true || p.drawAttention) w.win.focus();
    return this.winInfo(w, false, id);
  },
  'windows.remove'(id, [winId]) {
    const w = this._winById(num(winId));
    if (w) w.win.close();
  },

  // ---- action
  'action.setIcon'(id, [d = {}]) {
    d = d || {};
    const ext = this.api.getExtension(id);
    const url = typeof d.imageData === 'string' && d.imageData.startsWith('data:image/') ? d.imageData : this._imageUrl(this._iconFile(ext, d.path));
    this._actSet(id, num(d.tabId), 'icon', url || null);
  },
  'action.setTitle'(id, [d = {}]) {
    this._actSet(id, num(d && d.tabId), 'title', String((d && d.title) || '').slice(0, 200));
  },
  'action.getTitle'(id, [d = {}]) {
    return this._actGet(id, num(d && d.tabId), 'title');
  },
  'action.setBadgeText'(id, [d = {}]) {
    this._actSet(id, num(d && d.tabId), 'badge', d && d.text != null ? String(d.text).slice(0, 8) : '');
  },
  'action.getBadgeText'(id, [d = {}]) {
    return this._actGet(id, num(d && d.tabId), 'badge') || '';
  },
  'action.setBadgeBackgroundColor'(id, [d = {}]) {
    this._actSet(id, num(d && d.tabId), 'color', d && d.color);
  },
  'action.getBadgeBackgroundColor'(id, [d = {}]) {
    return this._actGet(id, num(d && d.tabId), 'color') || [217, 48, 37, 255];
  },
  'action.setBadgeTextColor'(id, [d = {}]) {
    this._actSet(id, num(d && d.tabId), 'textColor', d && d.color);
  },
  'action.getBadgeTextColor'(id, [d = {}]) {
    return this._actGet(id, num(d && d.tabId), 'textColor') || [255, 255, 255, 255];
  },
  'action.setPopup'(id, [d = {}]) {
    this._actSet(id, num(d && d.tabId), 'popup', String((d && d.popup) || ''));
  },
  'action.getPopup'(id, [d = {}]) {
    const p = this._actGet(id, num(d && d.tabId), 'popup');
    return p ? (/^chrome-extension:/.test(p) ? p : `chrome-extension://${id}/${p.replace(/^\/+/, '')}`) : '';
  },
  'action.enable'(id, [tabId]) {
    this._actSet(id, num(tabId), 'enabled', true);
  },
  'action.disable'(id, [tabId]) {
    this._actSet(id, num(tabId), 'enabled', false);
  },
  'action.isEnabled'(id, [tabId]) {
    return this._actGet(id, num(tabId), 'enabled') !== false;
  },
  'action.openPopup'(id) {
    const w = this._currentWindow(null);
    if (w) w.sendEvent('ext-open', { id });
  },
  'action.getUserSettings'(id) {
    return { isOnToolbar: !this.ctl.settings.data.extUnpinned.includes(id) };
  },

  // ---- context menus
  'contextMenus.create'(id, [p = {}]) {
    if (!p || p.id == null) throw new Error('Missing id');
    if (!this.menus.has(id)) this.menus.set(id, new Map());
    const items = this.menus.get(id);
    if (items.has(p.id)) throw new Error(`Cannot create item with duplicate id ${p.id}`);
    if (items.size >= 1000) throw new Error('Too many menu items');
    items.set(p.id, { ...p, title: String(p.title || '').slice(0, 300) });
    this._menusChanged(id);
  },
  'contextMenus.update'(id, [menuId, p = {}]) {
    const it = this.menus.get(id)?.get(menuId);
    if (!it) throw new Error(`Cannot find menu item with id ${menuId}`);
    Object.assign(it, p || {}, p && p.title != null ? { title: String(p.title).slice(0, 300) } : {});
    this._menusChanged(id);
  },
  'contextMenus.remove'(id, [menuId]) {
    const items = this.menus.get(id);
    if (!items || !items.has(menuId)) throw new Error(`Cannot find menu item with id ${menuId}`);
    const drop = (mid) => {
      items.delete(mid);
      for (const it of [...items.values()]) if (it.parentId === mid) drop(it.id);
    };
    drop(menuId);
    this._menusChanged(id);
  },
  'contextMenus.removeAll'(id) {
    this.menus.delete(id);
    this._menusChanged(id);
  },

  // ---- notifications
  'notifications.create'(id, [nid, o = {}]) {
    o = o || {};
    const key = typeof nid === 'string' && nid ? nid : `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const ext = this.api.getExtension(id);
    const old = this.notes.get(`${id}\n${key}`);
    if (old) old.close();
    if (!Notification.isSupported()) return key;
    let icon;
    if (typeof o.iconUrl === 'string') {
      if (o.iconUrl.startsWith('data:image/')) icon = nativeImage.createFromDataURL(o.iconUrl);
      else {
        const f = this._iconFile(ext, o.iconUrl.replace(/^chrome-extension:\/\/[a-p]{32}\//, ''));
        if (f) icon = nativeImage.createFromPath(f);
      }
    }
    const body = [o.message, o.contextMessage, ...(Array.isArray(o.items) ? o.items.map((i) => `${i.title}: ${i.message}`) : [])].filter(Boolean).join('\n');
    const n = new Notification({ title: String(o.title || this.name(ext)).slice(0, 200), body: body.slice(0, 1000), silent: !!o.silent, ...(icon && !icon.isEmpty() ? { icon } : {}) });
    n.on('click', () => this._emit(id, 'notifications.onClicked', [key]));
    n.on('close', () => {
      this.notes.delete(`${id}\n${key}`);
      this._emit(id, 'notifications.onClosed', [key, true]);
    });
    this.notes.set(`${id}\n${key}`, n);
    n.show();
    return key;
  },
  'notifications.update'(id, [nid, o]) {
    if (!this.notes.has(`${id}\n${nid}`)) return false;
    CALLS['notifications.create'].call(this, id, [nid, o]);
    return true;
  },
  'notifications.clear'(id, [nid]) {
    const n = this.notes.get(`${id}\n${nid}`);
    if (!n) return false;
    n.close();
    this.notes.delete(`${id}\n${nid}`);
    return true;
  },
  'notifications.getAll'(id) {
    const out = {};
    for (const k of this.notes.keys()) if (k.startsWith(id + '\n')) out[k.slice(id.length + 1)] = true;
    return out;
  },
  'notifications.getPermissionLevel'() {
    return 'granted';
  },

  // ---- permissions
  'permissions.contains'(id, [p = {}]) {
    const m = this.api.getExtension(id)?.manifest || {};
    const have = new Set([...(m.permissions || []), ...(m.optional_permissions || [])]);
    const hosts = [...(m.host_permissions || []), ...(m.optional_host_permissions || []), ...(m.permissions || []).filter((x) => typeof x === 'string' && x.includes('://'))];
    const okPerm = ((p && p.permissions) || []).every((x) => have.has(x));
    const okHost = ((p && p.origins) || []).every((o) => hosts.includes('<all_urls>') || hosts.some((h) => h === o || matchesAny([h], String(o).replace(/\*/g, 'x'))));
    return okPerm && okHost;
  },
  'permissions.getAll'(id) {
    const m = this.api.getExtension(id)?.manifest || {};
    return { permissions: (m.permissions || []).filter((x) => !String(x).includes('://')), origins: [...(m.host_permissions || [])] };
  },
  'permissions.request'() {
    return true;
  },
  'permissions.remove'() {
    return true;
  },
  'permissions.noop'() {},

  // ---- runtime
  'runtime.openOptionsPage'(id, _a, from) {
    if (!this.openOptions(id, this._currentWindow(from))) throw new Error('Could not create an options page.');
  },
  'runtime.setUninstallURL'() {},

  // ---- commands
  'commands.getAll'(id) {
    const c = this.api.getExtension(id)?.manifest?.commands || {};
    return Object.entries(c).map(([name, v]) => ({ name, description: (v && v.description) || '', shortcut: '' }));
  },

  // ---- webNavigation
  'webNavigation.getFrame'(id, [d = {}]) {
    const x = this._findTab(num(d && d.tabId));
    if (!x || (d.frameId || 0) !== 0) return null;
    return { errorOccurred: false, url: x.tab.url, parentFrameId: -1, frameId: 0 };
  },
  'webNavigation.getAllFrames'(id, [d = {}]) {
    const x = this._findTab(num(d && d.tabId));
    return x ? [{ errorOccurred: false, url: x.tab.url, parentFrameId: -1, frameId: 0, processId: -1 }] : null;
  },

  // ---- offscreen document: a hidden page of the extension
  async 'offscreen.createDocument'(id, [p = {}]) {
    const old = this.offscreen.get(id);
    if (old && !old.isDestroyed()) return;
    const url = `chrome-extension://${id}/${String((p && p.url) || '').replace(/^\/+/, '')}`;
    if (extIdOf(url) !== id) throw new Error('Invalid url');
    const bw = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { session: this.ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    bw.webContents.setAudioMuted(false);
    this.offscreen.set(id, bw);
    bw.on('closed', () => this.offscreen.get(id) === bw && this.offscreen.delete(id));
    await bw.loadURL(url);
  },
  'offscreen.closeDocument'(id) {
    const bw = this.offscreen.get(id);
    this.offscreen.delete(id);
    if (bw && !bw.isDestroyed()) bw.destroy();
  },
  'offscreen.hasDocument'(id) {
    const bw = this.offscreen.get(id);
    return !!(bw && !bw.isDestroyed());
  },

  // ---- cookies: the "cookies" permission plus host permission for the site, like Chrome
  async 'cookies.get'(id, [d = {}]) {
    if (!this._has(id, 'cookies')) throw new Error('Missing "cookies" permission');
    if (!this._hostAllowed(id, d.url)) throw new Error(`No host permissions for cookies at url: "${d.url}".`);
    const list = await this.ses.cookies.get({ url: d.url, name: d.name });
    return list[0] ? this._cookie(list[0]) : null;
  },
  async 'cookies.getAll'(id, [d = {}]) {
    if (!this._has(id, 'cookies')) throw new Error('Missing "cookies" permission');
    const f = {};
    for (const k of ['url', 'name', 'domain', 'path', 'secure', 'session']) if (d && d[k] !== undefined) f[k] = d[k];
    const seen = (c) => this._hostAllowed(id, `http${c.secure ? 's' : ''}://${String(c.domain || '').replace(/^\./, '')}${c.path || '/'}`);
    return (await this.ses.cookies.get(f)).filter(seen).map((c) => this._cookie(c));
  },
  async 'cookies.set'(id, [d = {}]) {
    if (!this._has(id, 'cookies')) throw new Error('Missing "cookies" permission');
    if (!this._hostAllowed(id, d.url)) throw new Error(`No host permissions for cookies at url: "${d.url}".`);
    const c = { url: d.url };
    for (const k of ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'expirationDate', 'sameSite']) if (d[k] !== undefined) c[k] = d[k];
    await this.ses.cookies.set(c);
    const list = await this.ses.cookies.get({ url: d.url, name: d.name });
    return list[0] ? this._cookie(list[0]) : null;
  },
  async 'cookies.remove'(id, [d = {}]) {
    if (!this._has(id, 'cookies')) throw new Error('Missing "cookies" permission');
    if (!this._hostAllowed(id, d.url)) throw new Error(`No host permissions for cookies at url: "${d.url}".`);
    await this.ses.cookies.remove(d.url, d.name);
    return { url: d.url, name: d.name, storeId: '0' };
  },
  'cookies.getAllCookieStores'() {
    return [{ id: '0', tabIds: this._allTabs().map((x) => this.tabId(x.tab)) }];
  },

  // ---- downloads
  'downloads.download'(id, [d = {}]) {
    if (!this._has(id, 'downloads')) throw new Error('Missing "downloads" permission');
    const url = d && typeof d.url === 'string' ? d.url : '';
    if (!/^(https?|data|blob):/i.test(url)) throw new Error('Invalid URL');
    this.ses.downloadURL(url);
    return ++this.downloadSeq;
  },
  'downloads.search'() {
    return [];
  },
  'downloads.noop'() {},

  'identity.getProfileUserInfo'() {
    return { email: '', id: '' };
  },

  'extension.false'() {
    return false;
  },

  // ---- fonts: the ones installed on this computer (Windows registry list)
  async 'fontSettings.getFontList'() {
    if (!this._fonts) this._fonts = await systemFonts();
    return this._fonts.map((f) => ({ fontId: f, displayName: f }));
  },
  'fontSettings.getFont'() {
    return { fontId: '', levelOfControl: 'controllable_by_this_extension' };
  },
  'fontSettings.size16'() {
    return { pixelSize: 16, levelOfControl: 'controllable_by_this_extension' };
  },
  'fontSettings.size13'() {
    return { pixelSize: 13, levelOfControl: 'controllable_by_this_extension' };
  },
  'fontSettings.size0'() {
    return { pixelSize: 0, levelOfControl: 'controllable_by_this_extension' };
  },

  // ---- our popup
  'popup.close'(id, _a, from) {
    if (this.popup && from.wc && this.popup.view.webContents === from.wc) {
      this.closePopup();
      return true;
    }
    return false;
  }
};

module.exports = { Extensions, matchPattern, extIdOf, STORE_URL };
