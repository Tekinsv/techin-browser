'use strict';
// One browser tab. The Chromium page (WebContentsView) is created lazily and
// destroyed while the tab sleeps; title/url/history survive in this object.
const { WebContentsView, dialog, clipboard } = require('electron');
const { newId } = require('./library');
const { isNavigable, isOpenableFromPage, hostOf, safeURL } = require('./url');
const { classifyLoadError } = require('./policy');

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const MAX_NAV_ENTRIES = 50;
const MAX_PAGE_STATE = 100 * 1024;
// Pages we destroy on purpose (sleep / close) - their 'destroyed' event is not a page-initiated close.
const expectedDestroy = new WeakSet();

function tabWebPreferences(ses, settings) {
  return {
    session: ses,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    plugins: true, // Chromium's built-in PDF viewer
    safeDialogs: true,
    navigateOnDragDrop: false,
    spellcheck: settings.spellcheck,
    backgroundThrottling: true,
    enableWebSQL: false,
    // Read by src/preload/page.js (smooth wheel, passkey pop-ups).
    additionalArguments: [
      ...(settings.smoothScroll === 'fluid' ? ['--techin-smooth-wheel'] : []),
      ...(settings.passkeys ? [] : ['--techin-no-passkeys']),
      // Development experiments only (never set in the installed app).
      ...(process.defaultApp && process.env.TECHIN_YT_MODE ? ['--techin-yt-mode=' + process.env.TECHIN_YT_MODE] : [])
    ]
  };
}

function isInternalScheme(url) {
  return /^(chrome|chrome-untrusted|chrome-extension|devtools|chrome-search|chrome-error):/i.test(String(url));
}

function cleanNavState(state) {
  if (!state || !Array.isArray(state.entries) || !state.entries.length) return null;
  let entries = state.entries
    .filter((e) => e && typeof e.url === 'string' && isNavigable(e.url))
    .map((e) => {
      const out = { url: e.url, title: typeof e.title === 'string' ? e.title.slice(0, 300) : '' };
      if (typeof e.pageState === 'string' && e.pageState.length < MAX_PAGE_STATE) out.pageState = e.pageState;
      return out;
    });
  if (!entries.length) return null;
  let index = Number.isInteger(state.index) ? state.index : entries.length - 1;
  if (entries.length > MAX_NAV_ENTRIES) {
    const cut = entries.length - MAX_NAV_ENTRIES;
    entries = entries.slice(cut);
    index -= cut;
  }
  index = Math.max(0, Math.min(entries.length - 1, index));
  return { entries, index };
}

class Tab {
  constructor(win, opts = {}) {
    this.win = win;
    this.ctl = win.ctl;
    this.id = opts.id || newId('t');
    this.kind = opts.kind || 'normal'; // normal | pinned | favorite
    this.refId = opts.refId || null;
    this.spaceId = opts.spaceId || null;
    this.url = typeof opts.url === 'string' ? opts.url : 'about:blank';
    this.title = opts.title || '';
    this.favicon = opts.favicon || null;
    this.navState = cleanNavState(opts.navState);
    this.lastActive = opts.lastActive || Date.now();
    this.createdAt = opts.createdAt || Date.now();
    this.openerId = opts.openerId || null;
    this.view = null;
    this.wc = null;
    this.loading = false;
    this.audible = false;
    this.muted = false;
    this.error = null;
    this.crashed = false;
    this.unresponsive = false;
    this.blocked = 0;
    this.canGoBack = !!this.navState && this.navState.index > 0;
    this.canGoForward = !!this.navState && this.navState.index < this.navState.entries.length - 1;
    this.zoom = 1;
    this.hoverUrl = '';
    this.findResult = null;
    this.certInfo = null;
    this.pendingBlock = null;
    this.upgradedHost = null;
    this._closing = false;
    if (opts.adoptWebContents) this._adopt(opts.adoptWebContents);
  }

  get alive() {
    return !!this.wc && !this.wc.isDestroyed();
  }

  get sleeping() {
    return !this.alive;
  }

  isActive() {
    return this.win.activeTabId === this.id;
  }

  // ------------------------------------------------------------ lifecycle

  ensureView() {
    if (this.alive) return this.view;
    this.crashed = false;
    const view = new WebContentsView({ webPreferences: tabWebPreferences(this.win.session, this.ctl.settings.data) });
    this._attach(view);
    const nav = this.navState;
    this.navState = null;
    if (nav) {
      this.wc.navigationHistory.restore({ entries: nav.entries, index: nav.index }).catch(() => this.load(this.url));
    } else if (this.url && this.url !== 'about:blank') {
      this.load(this.url);
    }
    return view;
  }

  _adopt(webContents) {
    const view = new WebContentsView({ webContents });
    this._attach(view);
  }

  _attach(view) {
    this.view = view;
    this.wc = view.webContents;
    view.setBackgroundColor('#ffffffff');
    this.win.applyViewStyle(view);
    this.ctl.registerTab(this.wc.id, this);
    this.wc.setAudioMuted(this.muted);
    this._wire(this.wc);
  }

  load(url) {
    if (!isNavigable(url)) return;
    this.url = url;
    this.error = null;
    if (!this.alive) {
      if (this.isActive()) this.ensureView();
      return;
    }
    this.wc.loadURL(url).catch(() => {});
  }

  /** Destroys the page but keeps the tab (and its back/forward list). */
  sleep() {
    if (!this.alive || this.isActive() || this.audible) return false;
    this.navState = this.currentNavState();
    this._destroyView();
    this.changed();
    return true;
  }

  currentNavState() {
    if (!this.alive) return this.navState;
    try {
      const h = this.wc.navigationHistory;
      return cleanNavState({ entries: h.getAllEntries(), index: h.getActiveIndex() });
    } catch {
      return null;
    }
  }

  _destroyView() {
    const wc = this.wc;
    this.win.detachTabView(this);
    this.view = null;
    this.wc = null;
    this.loading = false;
    this.audible = false;
    if (wc && !wc.isDestroyed()) {
      this.ctl.unregisterTab(wc.id);
      expectedDestroy.add(wc);
      wc.close();
    }
  }

  /** Asks the page (beforeunload) and closes the tab when it agrees. */
  close({ force = false } = {}) {
    if (!this.alive || force) {
      if (this.alive) this._destroyView();
      this.win.removeTab(this.id);
      return;
    }
    if (this._closing) return;
    this._closing = true;
    this.wc.close({ waitForBeforeUnload: true });
    // A hung renderer never answers beforeunload; don't keep a zombie tab.
    this._closeTimer = setTimeout(() => {
      if (this._closing && !this._unloadDialog) this.close({ force: true });
    }, 4000);
  }

  destroy() {
    clearTimeout(this._closeTimer);
    if (this.alive) this._destroyView();
  }

  reloadCrashed() {
    if (this.alive) {
      this.navState = this.currentNavState();
      this._destroyView();
    }
    this.crashed = false;
    this.error = null;
    this.ensureView();
    this.win.syncViews();
  }

  changed() {
    this.win.tabChanged(this);
  }

  // ------------------------------------------------------------ navigation

  goBack() {
    if (this.alive && this.wc.navigationHistory.canGoBack()) this.wc.navigationHistory.goBack();
    else if (!this.alive && this.navState && this.navState.index > 0) {
      this.navState.index--;
      this.url = this.navState.entries[this.navState.index].url;
      this.win.activateTab(this.id);
    }
  }

  goForward() {
    if (this.alive && this.wc.navigationHistory.canGoForward()) this.wc.navigationHistory.goForward();
  }

  reload(hard = false) {
    this.error = null;
    this.unresponsive = false;
    if (this.crashed || !this.alive) return this.reloadCrashed();
    if (hard) this.wc.reloadIgnoringCache();
    else this.wc.reload();
    this.win.syncViews();
  }

  stop() {
    if (this.alive) this.wc.stop();
  }

  setZoom(factor) {
    this.zoom = factor;
    if (this.alive) this.wc.setZoomFactor(factor);
    const host = hostOf(this.url);
    if (host) this.ctl.setZoomFor(host, factor, this.win.incognito);
    this.changed();
  }

  zoomStep(dir) {
    const cur = this.zoom;
    let idx = ZOOM_STEPS.findIndex((z) => z >= cur - 0.001);
    if (idx < 0) idx = ZOOM_STEPS.length - 1;
    if (dir > 0) idx = ZOOM_STEPS[idx] > cur + 0.001 ? idx : idx + 1;
    else idx = ZOOM_STEPS[idx] < cur - 0.001 ? idx : idx - 1;
    this.setZoom(ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx))]);
  }

  _syncNav() {
    if (!this.alive) return;
    try {
      this.canGoBack = this.wc.navigationHistory.canGoBack();
      this.canGoForward = this.wc.navigationHistory.canGoForward();
    } catch {}
  }

  onRequestBlocked() {
    this.blocked++;
    if (this.isActive()) this.win.scheduleState();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.alive) this.wc.setAudioMuted(this.muted);
    this.changed();
  }

  // ------------------------------------------------------------ events

  _wire(wc) {
    wc.on('did-start-loading', () => {
      this.loading = true;
      this.changed();
    });
    wc.on('did-stop-loading', () => {
      this.loading = false;
      this._syncNav();
      this.changed();
    });
    wc.on('did-start-navigation', (e) => {
      if (e.isMainFrame && !e.isSameDocument) {
        if (this.error) {
          this.error = null;
          this.win.syncViews();
        }
        this.certInfo = null;
      }
    });
    wc.on('did-navigate', (_e, url) => {
      this.url = url;
      this.error = null;
      this.blocked = 0;
      this.pendingBlock = null;
      this.findResult = null;
      if (this.upgradedHost && hostOf(url) === this.upgradedHost) this.upgradedHost = null;
      this._syncNav();
      this._applyZoom();
      this.ctl.recordVisit(this, url, this.title);
      this.win.onTabNavigated(this);
      this.ctl.passwords.onSuccessHint(this);
      this.changed();
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.url = url;
      this._syncNav();
      this.ctl.passwords.onSuccessHint(this);
      this.ctl.recordVisit(this, url, this.title);
      this.changed();
    });
    wc.on('page-title-updated', (_e, title) => {
      this.title = title;
      this.ctl.recordTitle(this, this.url, title);
      this.win.onTabMeta(this);
      this.changed();
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      const url = Array.isArray(favicons) ? favicons[0] : null;
      if (!url) return;
      const forUrl = this.url;
      this.ctl.favicons.get(url).then((data) => {
        if (!data || this.url !== forUrl) return;
        this.favicon = data;
        this.win.onTabMeta(this);
        this.changed();
      });
    });
    wc.on('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = aborted (user navigated away)
      let kind = classifyLoadError(code);
      const host = hostOf(validatedURL);
      if (kind === 'blocked' && this.pendingBlock) kind = this.pendingBlock.kind;
      else if (this.upgradedHost && host === this.upgradedHost && kind !== 'dns' && kind !== 'offline') kind = 'https-only';
      this.error = {
        kind,
        code,
        desc,
        url: validatedURL,
        host,
        cert: kind === 'cert' && this.certInfo ? { ...this.certInfo } : null
      };
      this.url = validatedURL || this.url;
      this.loading = false;
      this.win.syncViews();
      this.changed();
    });
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      this.crashed = details.reason;
      this.loading = false;
      this.audible = false;
      this.win.syncViews();
      this.changed();
    });
    wc.on('unresponsive', () => {
      this.unresponsive = true;
      if (this.isActive()) this.win.showInfobar({ type: 'unresponsive', tabId: this.id });
    });
    wc.on('responsive', () => {
      this.unresponsive = false;
      this.win.dismissInfobar((b) => b.type === 'unresponsive' && b.tabId === this.id);
    });
    wc.on('audio-state-changed', (e) => {
      this.audible = !!e.audible;
      this.changed();
    });
    wc.on('found-in-page', (_e, result) => {
      this.findResult = { active: result.activeMatchOrdinal, matches: result.matches };
      if (this.isActive()) this.win.scheduleState();
    });
    wc.on('update-target-url', (_e, url) => {
      this.hoverUrl = url || '';
      if (this.isActive()) this.win.scheduleState();
    });
    wc.on('context-menu', (_e, params) => this.ctl.menus.pageMenu(this, params));
    wc.on('focus', () => this.win.onTabFocused(this));
    wc.on('before-input-event', (e, input) => {
      if (this.win.handleKey(input, this)) e.preventDefault();
    });
    wc.on('enter-html-full-screen', () => this.win.setHtmlFullscreen(this, true));
    wc.on('leave-html-full-screen', () => this.win.setHtmlFullscreen(this, false));
    wc.on('zoom-changed', (_e, dir) => this.zoomStep(dir === 'in' ? 1 : -1));
    wc.on('will-prevent-unload', (e) => {
      this._unloadDialog = true;
      const leave = dialog.showMessageBoxSync(this.win.win, {
        type: 'question',
        buttons: [this.ctl.t('Ayrıl'), this.ctl.t('Kal')],
        defaultId: 1,
        cancelId: 1,
        title: 'Techin Browser',
        message: this.ctl.t('Bu sayfadan ayrılmak istiyor musunuz?'),
        detail: this.ctl.t('Yaptığınız değişiklikler kaydedilmemiş olabilir.')
      });
      this._unloadDialog = false;
      if (leave === 0) e.preventDefault();
      else {
        this._closing = false;
        clearTimeout(this._closeTimer);
      }
    });
    wc.on('select-bluetooth-device', (e, _devices, callback) => {
      e.preventDefault();
      callback('');
    });
    // Chromium already blocks web pages from opening file:, chrome: and top-level data: URLs.
    // Other custom schemes (mailto:, zoommtg:, steam:) must pass through so the
    // 'openExternal' permission prompt can ask the user.
    wc.on('will-navigate', (e) => {
      if (isInternalScheme(e.url)) e.preventDefault();
    });
    wc.on('will-redirect', (e) => {
      if (e.isMainFrame && isInternalScheme(e.url)) e.preventDefault();
    });
    wc.on('destroyed', () => {
      this.ctl.unregisterTab(wc.id);
      if (expectedDestroy.has(wc)) return;
      if (this.wc === wc) {
        // Closed by beforeunload agreement or by the page itself (window.close()).
        this.view = null;
        this.wc = null;
        clearTimeout(this._closeTimer);
        this.win.detachTabView(this);
        this.win.removeTab(this.id);
      }
    });

    wc.setWindowOpenHandler((details) => {
      const { url, disposition } = details;
      if (!isOpenableFromPage(url)) return { action: 'deny' };
      const asPopup = disposition === 'new-window';
      const background = disposition === 'background-tab';
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences: tabWebPreferences(this.win.session, this.ctl.settings.data) },
        createWindow: (options) => {
          if (asPopup) return this.ctl.openPopup(this.win, options.webContents, details).webContents;
          const tab = this.win.addTabFromOpener(this, options.webContents, { url, background });
          return tab.wc;
        }
      };
    });
  }

  _applyZoom() {
    const host = hostOf(this.url);
    const z = host ? this.ctl.getZoomFor(host, this.win.incognito) : 1;
    this.zoom = z;
    if (this.alive && Math.abs(this.wc.getZoomFactor() - z) > 0.001) this.wc.setZoomFactor(z);
  }

  copyUrl() {
    if (safeURL(this.url)) clipboard.writeText(this.url);
  }

  serialize() {
    return {
      id: this.id,
      kind: this.kind,
      refId: this.refId,
      spaceId: this.spaceId,
      url: this.url,
      title: this.title,
      favicon: this.favicon,
      navState: this.currentNavState(),
      lastActive: this.lastActive,
      createdAt: this.createdAt
    };
  }
}

module.exports = { Tab, tabWebPreferences, cleanNavState, ZOOM_STEPS };
