'use strict';
// Techin Browser — main process entry and the central controller ("ctl")
// that every window, tab and module talks to.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const electron = require('electron');
const { app, session, nativeTheme, desktopCapturer, dialog, shell, protocol, crashReporter } = electron;

// ------------------------------------------------------------ profile location
// Must run before anything reads userData. A location.json in the default
// profile folder can move the whole profile to another drive.
const DEFAULT_USER_DATA = app.getPath('userData');
if (process.argv.includes('--selftest') && !process.env.TECHIN_USER_DATA) {
  // Self test never touches the real profile; only the list caches survive between runs.
  const dir = path.join(require('node:os').tmpdir(), 'techin-selftest-profile');
  for (const f of ['settings.json', 'session.json', 'sites.json', 'library.json', 'history.json', 'downloads.json']) fs.rmSync(path.join(dir, f), { force: true });
  process.env.TECHIN_USER_DATA = dir;
}
const PROFILE_SKIP = /[\\/](Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|ShaderCache|Crashpad|blob_storage)$/i;

function setupProfileDir() {
  if (process.env.TECHIN_USER_DATA) {
    app.setPath('userData', path.resolve(process.env.TECHIN_USER_DATA));
    return;
  }
  const locFile = path.join(DEFAULT_USER_DATA, 'location.json');
  let loc;
  try {
    loc = JSON.parse(fs.readFileSync(locFile, 'utf8'));
  } catch {
    return;
  }
  if (!loc || typeof loc.profileDir !== 'string' || !path.isAbsolute(loc.profileDir)) return;
  try {
    fs.mkdirSync(loc.profileDir, { recursive: true });
    if (typeof loc.migrateFrom === 'string' && fs.existsSync(loc.migrateFrom) && !fs.existsSync(path.join(loc.profileDir, 'settings.json'))) {
      fs.cpSync(loc.migrateFrom, loc.profileDir, {
        recursive: true,
        filter: (src) => !PROFILE_SKIP.test(src) && path.basename(src) !== 'location.json' && !/^Singleton/.test(path.basename(src))
      });
    }
    if (loc.migrateFrom) {
      delete loc.migrateFrom;
      fs.writeFileSync(locFile, JSON.stringify(loc));
    }
    app.setPath('userData', loc.profileDir);
  } catch (err) {
    console.error('[profile] could not use custom location:', err.message);
  }
}
setupProfileDir();

const { JsonStore } = require('./store');
const { defaults: settingsDefaults, sanitizeSettings, sanitizeChange, RESTART_KEYS } = require('./settings');
const { Library, sanitizeLibrary } = require('./library');
const { History, sanitizeHistory } = require('./history');
const { Downloads, sanitizeDownloads } = require('./downloads');
const { Protection } = require('./protection');
const { Favicons } = require('./favicons');
const { Menus } = require('./menus');
const { hardenSession, installAppSecurity } = require('./security');
const { installIpc } = require('./ipc');
const { openPopup } = require('./popup');
const { TechinWindow } = require('./window');
const { Updater } = require('./updater');
const { Passwords, sanitizePasswords } = require('./passwords');
const sessionCookies = require('./sessioncookies');

const sessionCookieFile = () => path.join(USER_DATA, 'session-cookies.bin'); // USER_DATA is set further down
const { ASKABLE } = require('./policy');
const { ZOOM_STEPS } = require('./tab');
const { SEARCH_ENGINES, buildSearchUrl, originOf, normalizeInput, safeURL } = require('./url');
const i18n = require('../shared/i18n');

const USER_DATA = app.getPath('userData');

// Crash dumps stay on this computer (userData\Crashpad); nothing is uploaded.
try {
  crashReporter.start({ uploadToServer: false });
} catch {}
const LOG_FILE = path.join(USER_DATA, 'logs', 'main.log');
function logLine(...parts) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${parts.map(String).join(' ')}\n`);
  } catch {}
}
process.on('uncaughtException', (err) => logLine('uncaughtException', err && err.stack ? err.stack : err));
process.on('unhandledRejection', (err) => logLine('unhandledRejection', err && err.stack ? err.stack : err));
app.on('child-process-gone', (_e, d) => logLine('child-process-gone', d.type, d.reason, d.exitCode, d.name || ''));
app.on('render-process-gone', (_e, wc, d) => logLine('render-process-gone', d.reason, d.exitCode, wc && !wc.isDestroyed() ? wc.getURL().slice(0, 200) : ''));
const SELFTEST = process.argv.includes('--selftest');

// ------------------------------------------------------------ early settings & switches

const settingsStore = new JsonStore(path.join(USER_DATA, 'settings.json'), { defaults: settingsDefaults, sanitize: sanitizeSettings });

function applySwitches(s) {
  const cl = app.commandLine;
  // Windows 11 style thin overlay scrollbars, like Chrome/Edge.
  const enable = ['ParallelDownloading', 'FluentScrollbar', 'FluentOverlayScrollbar'];
  const disable = [];
  // 'fluid' = Firefox-like wheel animation done by src/preload/page.js; Chromium's own
  // smooth scrolling stays on for keyboard and scrollbar.
  if (s.smoothScroll === 'fluid' || s.smoothScroll === 'standard') {
    cl.appendSwitch('enable-smooth-scrolling');
  } else {
    cl.appendSwitch('disable-smooth-scrolling');
  }
  if (s.gpuRaster) {
    cl.appendSwitch('enable-gpu-rasterization');
    cl.appendSwitch('enable-zero-copy');
  }
  if (s.memorySaver) disable.push('SpareRendererForSitePerProcess');
  cl.appendSwitch('disk-cache-size', String(512 * 1024 * 1024));
  cl.appendSwitch('enable-features', enable.join(','));
  if (disable.length) cl.appendSwitch('disable-features', disable.join(','));
}
applySwitches(settingsStore.data);

const CHROME_MAJOR = String(process.versions.chrome || '140').split('.')[0];
// A plain Chrome user agent: sites (and Google sign-in) treat us like Chrome.
const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
app.userAgentFallback = USER_AGENT;

// The browser UI is served from a private scheme that exists only in the UI's
// own session — web pages in tabs can't load or navigate to it.
const UI_SCHEME = 'techin-ui';
const UI_ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
protocol.registerSchemesAsPrivileged([{ scheme: UI_SCHEME, privileges: { standard: true, secure: true } }]);
app.setAppUserModelId('com.techin.browser');

if (!SELFTEST && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

function sanitizeSites(obj) {
  const out = { permissions: {}, zoom: {} };
  const perms = obj && typeof obj.permissions === 'object' ? obj.permissions : {};
  for (const [origin, p] of Object.entries(perms)) {
    if (originOf(origin + '/') !== origin || !p || typeof p !== 'object') continue;
    const clean = {};
    for (const [name, v] of Object.entries(p)) if (ASKABLE.has(name) && (v === 'allow' || v === 'deny')) clean[name] = v;
    if (Object.keys(clean).length) out.permissions[origin] = clean;
  }
  const zoom = obj && typeof obj.zoom === 'object' ? obj.zoom : {};
  for (const [host, z] of Object.entries(zoom)) {
    if (/^[a-z0-9.-]{1,253}$/i.test(host) && ZOOM_STEPS.includes(z) && z !== 1) out.zoom[host] = z;
  }
  return out;
}

function timeout(ms) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
}

function argUrls(argv) {
  const out = [];
  for (const a of argv) {
    if (!a || a.startsWith('-') || a === '.') continue;
    if (/^https?:\/\//i.test(a)) {
      const u = safeURL(a);
      if (u) out.push(u.href);
      continue;
    }
    try {
      if (path.isAbsolute(a) && fs.statSync(a).isFile()) out.push(pathToFileURL(a).href);
    } catch {}
  }
  return out.slice(0, 20);
}

// ------------------------------------------------------------ controller

class Controller {
  constructor() {
    this.userData = USER_DATA;
    this.settings = settingsStore;
    const store = (name, opts) => new JsonStore(path.join(USER_DATA, name), opts);
    this.sites = store('sites.json', { defaults: () => ({}), sanitize: sanitizeSites });
    this.library = new Library(store('library.json', { defaults: () => ({}), sanitize: sanitizeLibrary }));
    this.history = new History(store('history.json', { defaults: () => ({ items: [] }), sanitize: sanitizeHistory, debounceMs: 3000 }));
    this.sessionStore = store('session.json', {
      defaults: () => ({ windows: [] }),
      sanitize: (o) => ({ windows: Array.isArray(o?.windows) ? o.windows.filter((w) => w && typeof w === 'object').slice(0, 20) : [] }),
      debounceMs: 1500
    });
    this.downloadsStore = store('downloads.json', { defaults: () => ({ items: [] }), sanitize: sanitizeDownloads });
    this.passwords = new Passwords(this, store('passwords.json', { defaults: () => ({ items: [], never: [] }), sanitize: sanitizePasswords, debounceMs: 300 }));
    this.windows = new Set();
    this.lastFocused = null;
    this.tabsByWc = new Map();
    this.popups = new Map();
    this.bypass = { threat: new Set(), http: new Set(), cert: new Map() };
    this.upgrades = new Map();
    this.certs = new Map();
    this.incognitoPerms = new Map();
    this.incognitoZoom = new Map();
    this.incognitoSessions = 0;
    this.sessionFrozen = false;
    this.quitting = false;
    this.lang = 'tr';
    this.userAgent = USER_AGENT;
    this.acceptLanguages = 'tr-TR,tr,en-US,en';
    this.iconPath = path.join(__dirname, '..', 'ui', 'assets', 'icon.png');
    this.meta = {
      version: app.getVersion(),
      chrome: process.versions.chrome,
      electron: process.versions.electron,
      v8: process.versions.v8,
      widevine: null,
      restartNeeded: false,
      userData: USER_DATA
    };
  }

  t(key, ...args) {
    return i18n.translate(this.lang, key, ...args);
  }

  resolveLang() {
    const pref = this.settings.data.language;
    if (pref === 'tr' || pref === 'en') return pref;
    const sys = (app.getPreferredSystemLanguages?.()[0] || app.getLocale() || 'tr').toLowerCase();
    return sys.startsWith('tr') ? 'tr' : 'en';
  }

  async start() {
    this.lang = this.resolveLang();
    const langs = (app.getPreferredSystemLanguages?.() || []).filter((l) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(l));
    const list = [];
    for (const l of [...langs, 'tr-TR', 'en-US']) {
      if (!list.includes(l)) list.push(l);
      const base = l.split('-')[0];
      if (!list.includes(base)) list.push(base);
    }
    this.acceptLanguages = list.slice(0, 6).join(',');
    nativeTheme.themeSource = this.settings.data.theme;

    this.favicons = new Favicons();
    this.menus = new Menus(this);
    this.protection = new Protection({ dir: path.join(USER_DATA, 'protection'), getSettings: () => this.settings.data });
    this.downloads = new Downloads(this, this.downloadsStore);

    this.hardenUiSession();
    installAppSecurity(this);
    installIpc(this);
    this.passwords.install();
    hardenSession(session.defaultSession, this);

    this.library.on('changed', () => this.onLibraryChanged());
    nativeTheme.on('updated', () => {
      for (const w of this.windows) if (!w.win.isDestroyed()) w.win.setBackgroundColor(this.windowBackground(w.incognito));
      this.broadcastState();
    });

    this.updater = new Updater(this);
    this.updater.init();

    await this.initWidevine();
    this.protection.init().then(() => this.broadcastState()).catch(() => {});

    app.on('second-instance', (_e, argv) => this.onSecondInstance(argv));
    app.on('before-quit', (e) => this.onBeforeQuit(e));
    app.on('window-all-closed', () => {
      if (!SELFTEST) app.quit();
    });

    setInterval(() => this.sleepIdleTabs(), 60 * 1000).unref?.();
    setInterval(() => this.autoArchive(), 5 * 60 * 1000).unref?.();

    if (SELFTEST) {
      // Development builds may point to an alternative test script; packaged builds never do.
      const mod = !app.isPackaged && process.env.TECHIN_SELFTEST_MODULE ? path.resolve(process.env.TECHIN_SELFTEST_MODULE) : './selftest';
      return require(mod).run(this);
    }
    if (this.keepsSessionCookies()) await sessionCookies.restoreSessionCookies(session.defaultSession, sessionCookieFile()).catch(() => 0);
    else sessionCookies.forget(sessionCookieFile());
    this.openInitialWindows(argUrls(process.argv.slice(app.isPackaged ? 1 : 2)));
  }

  /** Like Chrome: with "continue where you left off" session cookies survive a restart. */
  keepsSessionCookies() {
    const s = this.settings.data;
    return s.startup === 'restore' && !s.clearOnExit && !SELFTEST;
  }

  hardenUiSession() {
    const ses = session.fromPartition('techin-ui');
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.protocol.handle(UI_SCHEME, async (req) => {
      const u = new URL(req.url);
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const file = path.normalize(path.join(UI_ROOT, rel));
      const allowed = [path.join(UI_ROOT, 'ui') + path.sep, path.join(UI_ROOT, 'shared') + path.sep];
      if (u.host !== 'app' || !allowed.some((dir) => file.startsWith(dir))) return new Response('Not found', { status: 404 });
      try {
        const body = await fs.promises.readFile(file);
        return new Response(body, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'x-content-type-options': 'nosniff' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
    // The UI is local only: it can never reach the network.
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => cb({ cancel: !/^(techin-ui|data|devtools|blob):/i.test(d.url) }));
    ses.on('will-download', (e) => e.preventDefault());
  }

  async initWidevine() {
    const components = electron.components;
    if (!components || typeof components.whenReady !== 'function') {
      this.meta.widevine = { available: false };
      return;
    }
    try {
      await Promise.race([components.whenReady(), timeout(12000)]);
    } catch (err) {
      console.warn('[widevine] not ready:', err.message);
    }
    try {
      const status = components.status();
      const wv = (status && status[components.WIDEVINE_CDM_ID]) || Object.values(status || {}).find((c) => /widevine/i.test(c.title || c.name || '')) || null;
      this.meta.widevine = { available: true, version: wv?.version || null, status: wv?.status || null };
    } catch {
      this.meta.widevine = { available: true, version: null, status: 'unknown' };
    }
  }

  openInitialWindows(urls) {
    const saved = this.settings.data.startup === 'restore' ? this.sessionStore.data.windows : [];
    if (saved.length) {
      saved.forEach((r, i) => this.newWindow({ restore: r, urls: i === saved.length - 1 ? urls : [] }));
    } else {
      this.newWindow({ urls });
    }
  }

  // ------------------------------------------------------------ windows

  newWindow({ incognito = false, urls = [], restore = null } = {}) {
    if (!incognito) this.sessionFrozen = false;
    const w = new TechinWindow(this, { incognito, restore, urls });
    this.windows.add(w);
    this.lastFocused = w;
    return w;
  }

  lastWindow() {
    if (this.lastFocused && !this.lastFocused.win.isDestroyed()) return this.lastFocused;
    for (const w of this.windows) if (!w.win.isDestroyed()) return w;
    return null;
  }

  windowForUi(sender) {
    for (const w of this.windows) if (w.uiView.webContents === sender) return w;
    return null;
  }

  createIncognitoSession() {
    const ses = session.fromPartition(`techin-incognito-${++this.incognitoSessions}`, { cache: true });
    hardenSession(ses, this, { incognito: true });
    return ses;
  }

  onWindowClosing(w) {
    if (this.quitting || w.incognito) return;
    const others = [...this.windows].filter((x) => x !== w && !x.incognito);
    if (!others.length) {
      this.saveSessionNow();
      this.sessionFrozen = true;
    }
  }

  onWindowClosed(w) {
    this.windows.delete(w);
    if (this.lastFocused === w) this.lastFocused = [...this.windows].pop() || null;
    if (w.incognito) {
      w.session.clearStorageData().catch(() => {});
      w.session.clearCache().catch(() => {});
      w.session.clearAuthCache().catch(() => {});
    } else {
      this.saveSessionSoon();
    }
  }

  onSecondInstance(argv) {
    const urls = argUrls(argv.slice(1));
    const w = this.lastWindow();
    if (!w) return this.newWindow({ urls });
    for (const u of urls) w.openUrl(u, { newTab: true });
    if (w.win.isMinimized()) w.win.restore();
    w.win.focus();
  }

  onBeforeQuit(e) {
    if (this.quitting) return;
    this.quitting = true;
    this.saveSessionNow();
    this.sessionFrozen = true;
    this.flushStores();
    if (this.keepsSessionCookies()) {
      // Cookies can only be read asynchronously: hold the quit until they're written (max 1.5 s).
      e.preventDefault();
      const done = () => setImmediate(() => app.quit());
      Promise.race([sessionCookies.saveSessionCookies(session.defaultSession, sessionCookieFile()), new Promise((r) => setTimeout(r, 1500))])
        .catch(() => {})
        .finally(done);
      return;
    }
    sessionCookies.forget(sessionCookieFile());
    if (this.settings.data.clearOnExit && !this.updating) {
      e.preventDefault();
      this.clearBrowsingData(['history', 'cookies', 'cache'], 'all')
        .catch(() => {})
        .finally(() => {
          this.sessionStore.data = { windows: [] };
          this.sessionStore.saveNow();
          app.exit(0);
        });
    }
  }

  flushStores() {
    for (const s of [this.settings, this.sites, this.library.store, this.history.store, this.downloadsStore, this.passwords.store]) s.saveNow();
  }

  quit() {
    app.quit();
  }

  /** Called right before the updater quits to run the installer. */
  prepareForUpdate() {
    this.updating = true;
    this.saveSessionNow();
    this.sessionFrozen = true;
    this.flushStores();
  }

  relaunch() {
    app.relaunch();
    app.quit();
  }

  // ------------------------------------------------------------ session restore

  saveSessionSoon() {
    if (this.sessionFrozen || SELFTEST) return;
    clearTimeout(this._sessTimer);
    this._sessTimer = setTimeout(() => this.saveSessionNow(false), 3000);
  }

  saveSessionNow(sync = true) {
    clearTimeout(this._sessTimer);
    if (this.sessionFrozen || SELFTEST) return;
    const wins = [...this.windows].filter((w) => !w.incognito && !w.win.isDestroyed());
    this.sessionStore.data = { windows: wins.map((w) => w.serialize()) };
    if (sync) this.sessionStore.saveNow();
    else this.sessionStore.writeAsync();
  }

  // ------------------------------------------------------------ tabs registry

  registerTab(wcId, tab) {
    this.tabsByWc.set(wcId, tab);
  }

  unregisterTab(wcId) {
    this.tabsByWc.delete(wcId);
    this.upgrades.delete(wcId);
  }

  tabByWcId(wcId) {
    return wcId ? this.tabsByWc.get(wcId) || null : null;
  }

  registerPopup(wcId, popup) {
    this.popups.set(wcId, popup);
  }

  unregisterPopup(wcId) {
    this.popups.delete(wcId);
  }

  openPopup(win, webContents, details) {
    return openPopup(this, win, webContents, details);
  }

  noteBlockedMain(wcId, info) {
    const tab = this.tabByWcId(wcId);
    if (tab) tab.pendingBlock = info;
  }

  /** Returns false when a site keeps bouncing us back to http (then we let it). */
  noteUpgrade(wcId, host) {
    const now = Date.now();
    let rec = this.upgrades.get(wcId);
    if (rec && rec.host === host && now - rec.t < 5000) rec.n++;
    else rec = { host, n: 1, t: now };
    this.upgrades.set(wcId, rec);
    if (rec.n > 3) {
      this.bypass.http.add(host);
      return false;
    }
    const tab = this.tabByWcId(wcId);
    if (tab) tab.upgradedHost = host;
    return true;
  }

  noteCertError(wcId, info) {
    const tab = this.tabByWcId(wcId);
    if (tab) tab.certInfo = info;
  }

  noteCert(req) {
    try {
      const c = req.certificate;
      this.certs.set(req.hostname, {
        issuer: c.issuerName,
        subject: c.subjectName,
        validStart: c.validStart,
        validExpiry: c.validExpiry,
        fingerprint: c.fingerprint,
        result: req.verificationResult
      });
      if (this.certs.size > 500) this.certs.delete(this.certs.keys().next().value);
    } catch {}
  }

  recordVisit(tab, url, title) {
    if (!tab.win.incognito) this.history.add(url, title);
  }

  recordTitle(tab, url, title) {
    if (!tab.win.incognito) this.history.setTitle(url, title);
  }

  // ------------------------------------------------------------ prompts

  _ownerOf(wc) {
    const tab = this.tabByWcId(wc.id);
    if (tab) return { tab, win: tab.win };
    const popup = this.popups.get(wc.id);
    if (popup) return { popup, win: popup.win };
    return null;
  }

  async _nativeAsk(bw, message, detail, yes, no) {
    const r = await dialog.showMessageBox(bw, { type: 'question', buttons: [yes, no], defaultId: 1, cancelId: 1, title: 'Techin Browser', message, detail });
    return r.response === 0;
  }

  permissionLabel(p) {
    const map = {
      camera: 'kameranızı',
      microphone: 'mikrofonunuzu',
      geolocation: 'konumunuzu',
      notifications: 'bildirim göndermeyi',
      midiSysex: 'MIDI cihazlarınızı',
      'clipboard-read': 'panonuzu okumayı',
      'idle-detection': 'bilgisayarı kullanıp kullanmadığınızı',
      'window-management': 'ekranlarınızı ve pencereleri'
    };
    return this.t(map[p] || p);
  }

  promptPermission(wc, origin, perms, incognito, callback) {
    const owner = this._ownerOf(wc);
    const remember = (choice) => {
      if (choice === 'allow' || choice === 'deny') for (const p of perms) this.setSitePermission(origin, p, choice, incognito);
    };
    if (!owner) return callback(false);
    if (owner.popup) {
      const what = perms.map((p) => this.permissionLabel(p)).join(', ');
      return this._nativeAsk(owner.popup.bw, this.t('{0} şunu istiyor: {1}', origin, what), '', this.t('İzin ver'), this.t('Engelle')).then((ok) => {
        remember(ok ? 'allow' : 'deny');
        callback(ok);
      });
    }
    owner.win.showInfobar({
      type: 'permission',
      tabId: owner.tab.id,
      origin,
      host: new URL(origin).hostname,
      perms,
      resolve: (choice) => {
        remember(choice);
        if (choice === 'allow' && perms.some((p) => p === 'camera' || p === 'microphone')) owner.tab.mediaGranted = true;
        callback(choice === 'allow');
      }
    });
  }

  promptExternal(wc, url, callback) {
    const u = safeURL(url);
    const blocked = /^(javascript|data|file|vbscript|about|blob|ms-msdt|search-ms|search|ms-officecmd|ms-appinstaller|ms-cxh|ms-cxh-full|shell|ms-settings|ms-word|ms-excel|ms-powerpoint|jar|res|mk|its|ms-its|hcp|ie\.http|microsoft-edge|microsoft-edge-holographic|devtools|chrome|chrome-extension)$/i;
    if (!u || blocked.test(u.protocol.slice(0, -1))) return callback(false);
    const owner = this._ownerOf(wc);
    if (!owner) return callback(false);
    const scheme = u.protocol.slice(0, -1);
    if (owner.popup) {
      return this._nativeAsk(owner.popup.bw, this.t('Harici uygulama açılsın mı?'), url.slice(0, 300), this.t('Aç'), this.t('Vazgeç')).then(callback);
    }
    owner.win.showInfobar({
      type: 'external',
      tabId: owner.tab.id,
      origin: originOf(owner.tab.url),
      url: url.slice(0, 300),
      host: scheme,
      resolve: (choice) => callback(choice === 'allow')
    });
  }

  async promptScreenShare(wc, request, callback) {
    const owner = this._ownerOf(wc);
    if (!owner || owner.popup) return callback({});
    let sources;
    try {
      sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false });
    } catch {
      return callback({});
    }
    const data = {
      origin: originOf(owner.tab.url),
      audio: !!request.audioRequested,
      sources: sources.map((s) => ({
        id: s.id,
        name: s.name,
        screen: s.id.startsWith('screen:'),
        thumb: s.thumbnail.isEmpty() ? null : 'data:image/jpeg;base64,' + s.thumbnail.toJPEG(70).toString('base64')
      }))
    };
    if (!owner.win.tabs.has(owner.tab.id)) return callback({});
    owner.win.activateTab(owner.tab.id);
    owner.win.openModal({
      type: 'picker',
      data,
      onClose: (res) => {
        const src = res && sources.find((s) => s.id === res.id);
        if (!src) return callback({});
        const out = { video: src };
        if (res.audio && request.audioRequested && src.id.startsWith('screen:')) out.audio = 'loopback';
        callback(out);
      }
    });
  }

  promptLogin(wc, details, authInfo, callback) {
    const owner = this._ownerOf(wc);
    if (!owner || owner.popup) return callback();
    owner.win.openModal({
      type: 'auth',
      data: { host: String(authInfo.host || '').slice(0, 200), realm: String(authInfo.realm || '').slice(0, 200), proxy: !!authInfo.isProxy, secure: /^https:/.test(details.url || '') },
      onClose: (res) => (res ? callback(res.user, res.pass) : callback())
    });
  }

  // ------------------------------------------------------------ site settings

  getSitePermission(origin, name, incognito) {
    const stored = this.sites.data.permissions[origin]?.[name];
    if (incognito) {
      const v = this.incognitoPerms.get(origin + '|' + name);
      if (v) return v;
      return stored === 'deny' ? 'deny' : undefined; // blocks carry over, grants don't
    }
    return stored;
  }

  setSitePermission(origin, name, value, incognito) {
    if (!ASKABLE.has(name)) return;
    if (incognito) {
      if (value === 'ask') this.incognitoPerms.delete(origin + '|' + name);
      else this.incognitoPerms.set(origin + '|' + name, value);
      return;
    }
    const p = this.sites.data.permissions;
    if (value === 'ask') {
      if (p[origin]) {
        delete p[origin][name];
        if (!Object.keys(p[origin]).length) delete p[origin];
      }
    } else {
      p[origin] = p[origin] || {};
      p[origin][name] = value;
    }
    this.sites.save();
  }

  listSitePermissions() {
    return Object.entries(this.sites.data.permissions).map(([origin, perms]) => ({ origin, perms }));
  }

  clearSitePermissions(origin) {
    delete this.sites.data.permissions[origin];
    this.sites.save();
  }

  getZoomFor(host, incognito) {
    if (incognito && this.incognitoZoom.has(host)) return this.incognitoZoom.get(host);
    return this.sites.data.zoom[host] || 1;
  }

  setZoomFor(host, factor, incognito) {
    if (incognito) return this.incognitoZoom.set(host, factor);
    if (factor === 1) delete this.sites.data.zoom[host];
    else this.sites.data.zoom[host] = factor;
    this.sites.save();
  }

  setAdblockForHost(host, enabled) {
    host = host.toLowerCase().replace(/^www\./, '');
    const list = this.settings.data.adblockAllowlist.filter((h) => h !== host);
    if (!enabled) list.push(host);
    this.setSetting('adblockAllowlist', list);
    for (const w of this.windows) {
      const tab = w.activeTab();
      if (tab && tab.alive && tab.url.includes(host)) tab.reload();
    }
  }

  async siteInfo(w) {
    const tab = w.activeTab();
    if (!tab) return;
    const origin = originOf(tab.url);
    const host = origin ? new URL(origin).hostname : '';
    let cookies = 0;
    try {
      if (origin) cookies = (await w.session.cookies.get({ url: origin })).length;
    } catch {}
    const perms = {};
    for (const p of ASKABLE) {
      const v = origin ? this.getSitePermission(origin, p, w.incognito) : undefined;
      if (v) perms[p] = v;
    }
    w.openModal({
      type: 'siteinfo',
      data: {
        origin,
        host,
        url: tab.url,
        security: tab.error && tab.error.kind === 'cert' ? 'cert-error' : require('./url').securityState(tab.url),
        cert: host ? this.certs.get(host) || null : null,
        certBypassed: this.bypass.cert.has(host),
        perms,
        cookies,
        blocked: tab.blocked,
        adblock: this.settings.data.adblock,
        adblockOff: this.protection.isAllowlisted(tab.url),
        zoom: tab.zoom
      }
    });
  }

  async clearSiteData(w, origin) {
    try {
      await w.session.clearStorageData({ origin });
      const host = new URL(origin).hostname;
      const cookies = await w.session.cookies.get({ domain: host.replace(/^www\./, '') });
      await Promise.all(
        cookies.map((c) => w.session.cookies.remove(`${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path}`, c.name).catch(() => {}))
      );
    } catch {}
    this.toast(this.t('Site verileri temizlendi'), 'trash');
    const tab = w.activeTab();
    if (tab && tab.alive && originOf(tab.url) === origin) tab.reload();
    w.closeModal();
  }

  async clearBrowsingData(what, range) {
    const since = range === 'all' ? 0 : Date.now() - { hour: 3600e3, day: 86400e3, week: 7 * 86400e3 }[range];
    const sessions = new Set([session.defaultSession, ...[...this.windows].map((w) => w.session)]);
    if (what.includes('history')) {
      this.history.clear(since);
      for (const w of this.windows) w.closedTabs = [];
    }
    for (const ses of sessions) {
      if (what.includes('cookies')) {
        await ses.clearStorageData().catch(() => {});
        await ses.clearAuthCache().catch(() => {});
      }
      if (what.includes('cache')) {
        await ses.clearCache().catch(() => {});
        await ses.clearCodeCaches({}).catch(() => {});
      }
    }
    if (what.includes('cookies')) this.bypass.cert.clear();
    if (what.includes('downloads')) this.downloads.clearFinished();
    if (what.includes('permissions')) {
      this.sites.data.permissions = {};
      this.sites.save();
    }
    this.toast(this.t('Tarama verileri temizlendi'), 'trash');
    this.broadcastState();
    return true;
  }

  // ------------------------------------------------------------ settings

  setSetting(key, value) {
    const v = sanitizeChange(key, value);
    if (v === undefined) return false;
    const old = this.settings.data[key];
    if (JSON.stringify(old) === JSON.stringify(v)) return true;
    this.settings.data[key] = v;
    this.settings.save();
    switch (key) {
      case 'theme':
        nativeTheme.themeSource = v;
        break;
      case 'language':
        this.lang = this.resolveLang();
        break;
      case 'material':
        for (const w of this.windows) {
          if (w.incognito || w.win.isDestroyed()) continue;
          try {
            w.win.setBackgroundMaterial(v === 'mica' ? 'mica' : 'none');
          } catch {}
          w.win.setBackgroundColor(this.windowBackground(false));
        }
        break;
      case 'adblockLevel':
        this.protection.loadBlocker().then(() => this.broadcastState());
        break;
      case 'malwareProtection':
        if (v) this.protection.updateThreats().then(() => this.broadcastState());
        break;
      case 'spellcheck':
        session.defaultSession.setSpellCheckerEnabled(v);
        for (const w of this.windows) w.session.setSpellCheckerEnabled(v);
        break;
      default:
    }
    if (RESTART_KEYS.has(key)) this.meta.restartNeeded = true;
    for (const w of this.windows) w.layout();
    return true;
  }

  resetSettings() {
    const keep = { onboarded: true, downloadDir: this.settings.data.downloadDir };
    this.settings.data = { ...settingsDefaults(), ...keep };
    this.settings.save();
    nativeTheme.themeSource = 'system';
    this.lang = this.resolveLang();
    this.meta.restartNeeded = true;
    for (const w of this.windows) w.layout();
  }

  searchTemplate() {
    const s = this.settings.data;
    if (s.searchEngine === 'custom' && s.customSearchUrl) return s.customSearchUrl;
    return (SEARCH_ENGINES[s.searchEngine] || SEARCH_ENGINES.google).url;
  }

  engineName() {
    const s = this.settings.data;
    if (s.searchEngine === 'custom') {
      try {
        return new URL(s.customSearchUrl).hostname.replace(/^www\./, '');
      } catch {
        return 'Web';
      }
    }
    return (SEARCH_ENGINES[s.searchEngine] || SEARCH_ENGINES.google).name;
  }

  searchUrl(text) {
    return buildSearchUrl(text, this.searchTemplate());
  }

  themeMode() {
    const t = this.settings.data.theme;
    if (t === 'light' || t === 'dark') return t;
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }

  windowBackground(incognito) {
    if (incognito) return '#17121f';
    if (this.settings.data.material === 'mica') return '#00000000';
    return this.themeMode() === 'dark' ? '#0f1520' : '#e6ecf5';
  }

  // ------------------------------------------------------------ broadcast helpers

  broadcastState() {
    for (const w of this.windows) w.scheduleState();
  }

  onLibraryChanged() {
    for (const w of this.windows) w.reconcileLibrary();
  }

  toast(text, icon = 'info') {
    const w = this.lastWindow();
    if (w) w.sendEvent('toast', { text: String(text).slice(0, 200), icon });
  }

  onDownloadStarted() {
    const w = this.lastWindow();
    if (w) w.sendEvent('download-started', {});
  }

  // ------------------------------------------------------------ memory

  sleepIdleTabs() {
    const minutes = this.settings.data.tabSleepMinutes;
    if (!minutes) return;
    const limit = Date.now() - minutes * 60000;
    for (const w of this.windows) {
      for (const tab of w.tabs.values()) {
        if (!tab.alive || tab.isActive() || tab.audible || tab.kind === 'favorite' || tab.mediaGranted) continue;
        if (tab.lastActive > limit || tab.wc.isDevToolsOpened()) continue;
        if (w.infobars.some((b) => b.tabId === tab.id)) continue;
        tab.sleep();
      }
    }
  }

  autoArchive() {
    const hours = this.settings.data.autoArchiveHours;
    if (!hours) return;
    const limit = Date.now() - hours * 3600e3;
    for (const w of this.windows) {
      for (const tab of [...w.tabs.values()]) {
        if (tab.kind !== 'normal' || tab.isActive() || tab.audible || tab.lastActive > limit) continue;
        tab.close({ force: true });
      }
    }
  }

  memoryStats(w) {
    const metrics = app.getAppMetrics();
    const byPid = new Map(metrics.map((m) => [m.pid, m]));
    const mb = (m) => (m ? Math.round((m.memory.privateBytes || m.memory.workingSetSize || 0) / 1024) : 0);
    let total = 0;
    for (const m of metrics) total += mb(m);
    const pidCount = new Map();
    const tabs = [];
    for (const win of this.windows) {
      for (const tab of win.tabs.values()) {
        let pid = 0;
        if (tab.alive) {
          try {
            pid = tab.wc.getOSProcessId();
          } catch {}
        }
        if (pid) pidCount.set(pid, (pidCount.get(pid) || 0) + 1);
        tabs.push({ tab, pid, win });
      }
    }
    const uiPids = new Set([...this.windows].map((x) => x.uiView.webContents.getOSProcessId()));
    let ui = 0;
    for (const pid of uiPids) ui += mb(byPid.get(pid));
    const pick = (type) => metrics.filter((m) => m.type === type).reduce((a, m) => a + mb(m), 0);
    return {
      total,
      browser: pick('Browser'),
      gpu: pick('GPU'),
      ui,
      tabs: tabs
        .map(({ tab, pid, win }) => ({
          id: tab.id,
          own: win === w,
          title: tab.title || tab.url,
          favicon: tab.favicon,
          sleeping: tab.sleeping,
          active: tab.isActive(),
          mb: pid ? mb(byPid.get(pid)) : 0,
          shared: pid ? pidCount.get(pid) > 1 : false
        }))
        .sort((a, b) => b.mb - a.mb),
      processes: metrics.length
    };
  }

  // ------------------------------------------------------------ OS integration

  async makeDefaultBrowser(w) {
    if (!app.isPackaged || process.platform !== 'win32') {
      await dialog.showMessageBox(w.win, {
        type: 'info',
        title: 'Techin Browser',
        message: this.t('Bu özellik yalnızca kurulu sürümde çalışır.'),
        detail: this.t('Kurulum dosyasıyla yükledikten sonra tekrar deneyin.')
      });
      return;
    }
    const exe = process.execPath;
    const base = 'HKCU\\Software\\Clients\\StartMenuInternet\\TechinBrowser';
    const cls = 'HKCU\\Software\\Classes\\TechinHTML';
    const entries = [
      [base, '', 'Techin Browser'],
      [`${base}\\Capabilities`, 'ApplicationName', 'Techin Browser'],
      [`${base}\\Capabilities`, 'ApplicationDescription', 'Techin Browser'],
      [`${base}\\Capabilities`, 'ApplicationIcon', `${exe},0`],
      [`${base}\\Capabilities\\URLAssociations`, 'http', 'TechinHTML'],
      [`${base}\\Capabilities\\URLAssociations`, 'https', 'TechinHTML'],
      ...['.htm', '.html', '.xhtml', '.svg', '.pdf', '.webp'].map((ext) => [`${base}\\Capabilities\\FileAssociations`, ext, 'TechinHTML']),
      [`${base}\\DefaultIcon`, '', `${exe},0`],
      [`${base}\\shell\\open\\command`, '', `"${exe}"`],
      ['HKCU\\Software\\RegisteredApplications', 'TechinBrowser', 'Software\\Clients\\StartMenuInternet\\TechinBrowser\\Capabilities'],
      [cls, '', 'Techin Browser HTML Document'],
      [cls, 'URL Protocol', ''],
      [`${cls}\\DefaultIcon`, '', `${exe},0`],
      [`${cls}\\shell\\open\\command`, '', `"${exe}" "%1"`]
    ];
    const run = (args) => new Promise((res) => execFile('reg.exe', args, { windowsHide: true }, (err) => res(!err)));
    for (const [key, name, data] of entries) {
      const args = ['add', key, ...(name ? ['/v', name] : ['/ve']), '/d', data, '/f'];
      if (!(await run(args))) {
        this.toast(this.t('Kayıt defterine yazılamadı'), 'warn');
        return;
      }
    }
    shell.openExternal('ms-settings:defaultapps?registeredAppUser=TechinBrowser');
    this.toast(this.t('Windows ayarlarında Techin Browser\'ı seçin'), 'info');
  }

  async chooseProfileDir(w) {
    const r = await dialog.showOpenDialog(w.win, { properties: ['openDirectory', 'createDirectory'], title: this.t('Profil klasörünü seçin') });
    if (r.canceled || !r.filePaths[0]) return;
    const target = path.join(r.filePaths[0], 'Techin Browser Profil');
    if (path.resolve(target) === path.resolve(USER_DATA)) return;
    const ok = await this._nativeAsk(
      w.win,
      this.t('Profil taşınsın mı?'),
      this.t('Sekmeleriniz, geçmişiniz ve ayarlarınız "{0}" klasörüne kopyalanacak ve tarayıcı yeniden başlayacak.', target),
      this.t('Taşı ve yeniden başlat'),
      this.t('Vazgeç')
    );
    if (!ok) return;
    fs.mkdirSync(DEFAULT_USER_DATA, { recursive: true });
    fs.writeFileSync(path.join(DEFAULT_USER_DATA, 'location.json'), JSON.stringify({ profileDir: target, migrateFrom: USER_DATA }));
    this.relaunch();
  }
}

// ------------------------------------------------------------ boot

const ctl = new Controller();
module.exports = { ctl, normalizeInput };

app.whenReady().then(() => ctl.start()).catch((err) => {
  console.error('[startup]', err);
  dialog.showErrorBox('Techin Browser', String(err && err.stack ? err.stack : err));
  app.exit(1);
});

app.on('will-quit', () => ctl.flushStores());
