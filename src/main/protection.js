'use strict';
// Ad/tracker blocking (Ghostery engine) and malware/phishing host lists.
// Everything is cached on disk so startup never waits for the network.
const fs = require('node:fs');
const path = require('node:path');
const { net, ipcMain } = require('electron');
const { ElectronBlocker, adsAndTrackingLists, fullLists, fromElectronDetails } = require('@ghostery/adblocker-electron');
const PRELOAD_PATH = require.resolve('@ghostery/adblocker-electron-preload');
const { hostOf } = require('./url');
const { parse: parseDomain } = require('tldts');
const { parseHostsList } = require('./policy');

const DAY = 86400000;
const ENGINE_MAX_AGE = 4 * DAY;
const THREAT_MAX_AGE = DAY / 2;
const THREAT_LISTS = {
  malware: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-hosts.txt',
  phishing: 'https://malware-filter.gitlab.io/malware-filter/phishing-filter-hosts.txt'
};

const fetchImpl = (url, init) => net.fetch(url, { ...init, bypassCustomProtocolHandlers: true });

function fileAge(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
}


class Protection {
  constructor({ dir, getSettings, onBlocked }) {
    this.dir = dir;
    this.getSettings = getSettings;
    this.onBlocked = onBlocked; // (webContentsId) => void
    this.blocker = null;
    this.blockerLevel = null;
    this.threats = { malware: new Set(), phishing: new Set() };
    this.threatUpdated = 0;
    this.sessions = new Set();
    this.status = { adblock: 'loading', threats: 'loading', rules: 0 };
    fs.mkdirSync(dir, { recursive: true });
    this.injected = new Map();
    this._registerCosmeticIpc();
  }

  async init() {
    this._loadThreatsFromDisk();
    await Promise.allSettled([this.loadBlocker(), this.updateThreats()]);
    // Keep lists fresh while the browser stays open.
    setInterval(() => {
      this.updateThreats().catch(() => {});
      this.loadBlocker().catch(() => {});
    }, 6 * 3600 * 1000).unref?.();
  }

  // ------------------------------------------------------------ ad blocking

  enginePath(level) {
    return path.join(this.dir, `adblock-${level}.bin`);
  }

  async loadBlocker() {
    const level = this.getSettings().adblockLevel;
    const file = this.enginePath(level);
    const lists = level === 'strict' ? fullLists : adsAndTrackingLists;
    let engine = null;
    if (this.blockerLevel !== level || !this.blocker) {
      try {
        engine = ElectronBlocker.deserialize(new Uint8Array(await fs.promises.readFile(file)));
      } catch {}
      if (engine) this._setEngine(engine, level);
    }
    if (!this.blocker || this.blockerLevel !== level || fileAge(file) > ENGINE_MAX_AGE) {
      try {
        const fresh = await ElectronBlocker.fromLists(fetchImpl, lists, { loadCosmeticFilters: true, enableMutationObserver: false });
        const tmp = file + '.tmp';
        await fs.promises.writeFile(tmp, fresh.serialize());
        await fs.promises.rename(tmp, file);
        if (this.getSettings().adblockLevel === level) this._setEngine(fresh, level);
      } catch (err) {
        if (!this.blocker) this.status.adblock = 'error';
        console.warn('[adblock] list update failed:', err.message);
      }
    }
  }

  _setEngine(engine, level) {
    this.blocker = engine;
    this.blockerLevel = level;
    this.status.adblock = 'ready';
    try {
      this.status.rules = engine.getFilters().networkFilters.length + engine.getFilters().cosmeticFilters.length;
    } catch {
      this.status.rules = 0;
    }
  }

  isAllowlisted(topUrl) {
    const host = hostOf(topUrl);
    if (!host) return false;
    const list = this.getSettings().adblockAllowlist;
    return list.some((h) => host === h || host.endsWith('.' + h));
  }

  /** Returns a webRequest callback response for a subresource, or null. */
  matchRequest(details) {
    if (!this.blocker) return null;
    const request = fromElectronDetails(details);
    if (request.type === 'other') request.guessTypeOfRequest();
    const { redirect, match } = this.blocker.match(request);
    if (redirect) return { redirectURL: redirect.dataUrl };
    if (match) return { cancel: true };
    return null;
  }

  onHeadersReceived(details, callback) {
    if (!this.blocker) return callback({});
    return this.blocker.onHeadersReceived(details, callback);
  }

  /** Cosmetic filtering runs through a sandbox-safe preload in every frame. */
  attachSession(ses) {
    if (this.sessions.has(ses)) return;
    this.sessions.add(ses);
    ses.registerPreloadScript({ type: 'frame', filePath: PRELOAD_PATH });
  }

  _registerCosmeticIpc() {
    // Our own version of Ghostery's handler. The library runs scriptlets with
    // webContents.executeJavaScript, i.e. always in the MAIN frame — once more for
    // every iframe on the page. On YouTube that stacked the same scriptlets several
    // times ("JSONPath already declared", "Maximum call stack size exceeded") and
    // Shorts stayed gray. Here each frame gets its own filters, exactly once.
    ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, url, msg) => {
      const s = this.getSettings();
      const frame = event.senderFrame;
      if (!s.adblock || !this.blocker || typeof url !== 'string' || !frame || msg !== undefined) return undefined;
      const wc = event.sender;
      if (!wc || wc.isDestroyed()) return undefined;
      if (this.isAllowlisted(wc.getURL())) return undefined;
      const key = `${frame.processId}:${frame.routingId}:${url}`;
      if (this.injected.get(wc.id) === undefined) {
        this.injected.set(wc.id, new Set());
        wc.once('destroyed', () => this.injected.delete(wc.id));
        // A frame that loads a new document (or reloads) must get its filters again.
        wc.on('did-frame-navigate', (_e, _url, _code, _text, _isMain, pid, rid) => {
          const set = this.injected.get(wc.id);
          if (!set) return;
          for (const k of set) if (k.startsWith(`${pid}:${rid}:`)) set.delete(k);
        });
      }
      const done = this.injected.get(wc.id);
      if (done.has(key)) return undefined;
      done.add(key);
      if (done.size > 500) done.clear();
      const info = parseDomain(url);
      let result;
      try {
        result = this.blocker.getCosmeticsFilters({
          url,
          hostname: info.hostname || '',
          domain: info.domain || '',
          getBaseRules: true,
          getInjectionRules: true,
          getExtendedRules: false,
          getRulesFromHostname: true,
          getRulesFromDOM: false,
          callerContext: { frameId: frame.routingId, processId: frame.processId }
        });
      } catch {
        return undefined;
      }
      if (!result || result.active === false) return undefined;
      const isMain = frame === wc.mainFrame;
      if (result.styles && result.styles.length) {
        if (isMain) wc.insertCSS(result.styles, { cssOrigin: 'user' }).catch(() => {});
        else {
          const css = JSON.stringify(result.styles);
          frame.executeJavaScript(`(() => { const s = document.createElement('style'); s.textContent = ${css}; (document.head || document.documentElement).appendChild(s); })()`).catch(() => {});
        }
      }
      // Each scriptlet in its own scope: they all re-declare the same helpers.
      for (const script of result.scripts || []) frame.executeJavaScript('(function () {\n' + script + '\n})();', true).catch(() => {});
      return undefined;
    });
    // Watching every DOM change sends a stream of IPC to the main process on busy
    // sites (YouTube, Instagram) and makes scrolling stutter - keep it off.
    ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', () => false);
  }

  // ------------------------------------------------------------ malware / phishing

  _threatFile(kind) {
    return path.join(this.dir, `threat-${kind}.txt`);
  }

  _loadThreatsFromDisk() {
    for (const kind of Object.keys(THREAT_LISTS)) {
      try {
        const file = this._threatFile(kind);
        this.threats[kind] = parseHostsList(fs.readFileSync(file, 'utf8'));
        this.threatUpdated = Math.max(this.threatUpdated, fs.statSync(file).mtimeMs);
      } catch {}
    }
    if (this.threats.malware.size || this.threats.phishing.size) this.status.threats = 'ready';
  }

  async updateThreats() {
    await Promise.allSettled(
      Object.entries(THREAT_LISTS).map(async ([kind, url]) => {
        const file = this._threatFile(kind);
        if (fileAge(file) < THREAT_MAX_AGE && this.threats[kind].size) return;
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const set = parseHostsList(text);
        if (set.size < 50) throw new Error('list looks empty');
        await fs.promises.writeFile(file + '.tmp', text);
        await fs.promises.rename(file + '.tmp', file);
        this.threats[kind] = set;
        this.threatUpdated = Date.now();
      })
    );
    this.status.threats = this.threats.malware.size || this.threats.phishing.size ? 'ready' : 'error';
  }

  /** 'malware' | 'phishing' | null */
  checkHost(host) {
    if (!host) return null;
    host = host.toLowerCase().replace(/\.$/, '');
    if (this.threats.malware.has(host)) return 'malware';
    if (this.threats.phishing.has(host)) return 'phishing';
    return null;
  }

  counts() {
    return { malware: this.threats.malware.size, phishing: this.threats.phishing.size, updated: this.threatUpdated };
  }
}

module.exports = { Protection };
