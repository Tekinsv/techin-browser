'use strict';
// One browser window: a sidebar/UI layer (uiView) plus the active tab's page.
// The UI is normally *below* the page; while a modal (command bar, dialogs) is
// open the UI is raised above it so the live page stays visible, dimmed.
const path = require('node:path');
const { app, BaseWindow, WebContentsView, session, screen } = require('electron');
const { Tab } = require('./tab');
const { newId } = require('./library');
const { normalizeInput, isNavigable, displayHost, securityState, hostOf, originOf, safeURL } = require('./url');

const UI_URL = 'techin-ui://app/ui/index.html';
const UI_PRELOAD = path.join(__dirname, '..', 'preload', 'ui.js');
const COMPACT_WIDTH = 52;
const TOPBAR_HEIGHT = 40;
const SPLIT_GAP = 6;
const FIND_HEIGHT = 48;
const INFOBAR_HEIGHT = 52;
const MAX_CLOSED = 30;

function validBounds(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  const visible = screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return b.x < w.x + w.width - 80 && b.x + b.width > w.x + 80 && b.y >= w.y - 20 && b.y < w.y + w.height - 60;
  });
  return visible ? { x: b.x, y: b.y, width: Math.max(560, b.width), height: Math.max(400, b.height) } : null;
}

class TechinWindow {
  constructor(ctl, { incognito = false, restore = null, urls = [] } = {}) {
    this.ctl = ctl;
    this.id = newId('w');
    this.incognito = incognito;
    this.session = incognito ? ctl.createIncognitoSession() : session.defaultSession;
    this.tabs = new Map();
    this.order = []; // "today" tabs of every space, top to bottom
    this.activeSpaceId = ctl.library.spaces[0].id;
    this.activeBySpace = {};
    this.activeTabId = null;
    this.panel = null;
    this.modal = null;
    this.find = { open: false, text: '' };
    this.infobars = [];
    this.htmlFullscreen = null;
    this.focusMode = false;
    this.closedTabs = [];
    this.shownViews = [];
    this.split = null;
    this.uiOnTop = false;
    this.uiReady = false;
    this._stateTimer = null;

    const s = ctl.settings.data;
    const area = screen.getPrimaryDisplay().workArea;
    const bounds = validBounds(restore?.bounds) || {
      width: Math.min(1440, Math.round(area.width * 0.86)),
      height: Math.min(920, Math.round(area.height * 0.88))
    };
    this.win = new BaseWindow({
      ...bounds,
      minWidth: 560,
      minHeight: 400,
      show: false,
      title: incognito ? 'Techin Browser (Gizli)' : 'Techin Browser',
      titleBarStyle: 'hidden',
      backgroundColor: ctl.windowBackground(incognito),
      icon: ctl.iconPath,
      ...(s.material === 'mica' && !incognito ? { backgroundMaterial: 'mica' } : {})
    });
    if (restore?.maximized) this.win.maximize();

    this.uiView = new WebContentsView({
      webPreferences: {
        preload: UI_PRELOAD,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'techin-ui',
        spellcheck: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        backgroundThrottling: false,
        devTools: !app.isPackaged || !!process.env.TECHIN_DEBUG
      }
    });
    this.uiView.setBackgroundColor('#00000000');
    this.win.contentView.addChildView(this.uiView);
    this._wireUi();
    this._wireWindow();

    if (restore) this._restore(restore);
    for (const u of urls) this.openUrl(u, { newTab: true });
    this.layout();
    this.uiView.webContents.loadURL(UI_URL + (incognito ? '?incognito=1' : ''));
    this._showFallback = setTimeout(() => this.show(), 2500);
  }

  // ------------------------------------------------------------ setup

  _wireUi() {
    const wc = this.uiView.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('will-redirect', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('before-input-event', (e, input) => {
      if (this.handleKey(input, null)) e.preventDefault();
    });
    wc.on('context-menu', (_e, params) => {
      if (params.isEditable) this.ctl.menus.editMenu(this, params);
    });
    wc.on('render-process-gone', (_e, d) => {
      console.error('[ui] renderer gone:', d.reason);
      if (!this.win.isDestroyed()) setTimeout(() => wc.reload(), 300);
    });
    wc.on('did-finish-load', () => this.scheduleState());
  }

  _wireWindow() {
    const w = this.win;
    w.on('resize', () => this.layout());
    for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) {
      w.on(ev, () => {
        if (ev === 'leave-full-screen') {
          this.focusMode = false;
          this.htmlFullscreen = null;
        }
        this.layout();
        this.scheduleState();
      });
    }
    w.on('focus', () => {
      this.ctl.lastFocused = this;
      this.scheduleState();
    });
    w.on('blur', () => this.scheduleState());
    w.on('app-command', (_e, cmd) => {
      const tab = this.activeTab();
      if (!tab) return;
      if (cmd === 'browser-backward') tab.goBack();
      else if (cmd === 'browser-forward') tab.goForward();
    });
    w.on('close', () => this.ctl.onWindowClosing(this));
    w.on('closed', () => {
      clearTimeout(this._stateTimer);
      clearTimeout(this._showFallback);
      for (const tab of this.tabs.values()) tab.destroy();
      this.tabs.clear();
      for (const b of this.infobars) b.resolve?.('dismiss');
      this.infobars = [];
      if (this.modal) this.modal.onClose?.(null);
      if (!this.uiView.webContents.isDestroyed()) this.uiView.webContents.close();
      this.ctl.onWindowClosed(this);
    });
  }

  _restore(r) {
    const lib = this.ctl.library;
    if (typeof r.activeSpaceId === 'string' && lib.space(r.activeSpaceId)) this.activeSpaceId = r.activeSpaceId;
    for (const t of Array.isArray(r.tabs) ? r.tabs.slice(0, 500) : []) {
      if (!t || typeof t.url !== 'string' || !isNavigable(t.url)) continue;
      let kind = t.kind;
      let refId = t.refId;
      let spaceId = typeof t.spaceId === 'string' && lib.space(t.spaceId) ? t.spaceId : this.activeSpaceId;
      if (kind === 'pinned' || kind === 'favorite') {
        const found = refId ? lib.find(refId) : null;
        if (!found) {
          kind = 'normal';
          refId = null;
        } else {
          kind = found.kind;
          if (found.spaceId) spaceId = found.spaceId;
        }
      } else kind = 'normal';
      const tab = new Tab(this, { ...t, kind, refId, spaceId });
      this.tabs.set(tab.id, tab);
      if (kind === 'normal') this.order.push(tab.id);
    }
    if (r.activeBySpace && typeof r.activeBySpace === 'object') {
      for (const [sp, id] of Object.entries(r.activeBySpace)) if (this.tabs.has(id)) this.activeBySpace[sp] = id;
    }
    const active = this.tabs.get(r.activeTabId);
    if (active) this.activateTab(active.id, { focus: false });
  }

  show() {
    clearTimeout(this._showFallback);
    if (this.win.isDestroyed() || this.win.isVisible()) return;
    this.win.show();
    this.win.focus();
  }

  // ------------------------------------------------------------ lookup

  activeTab() {
    return this.activeTabId ? this.tabs.get(this.activeTabId) || null : null;
  }

  tabForRef(refId) {
    for (const t of this.tabs.values()) if (t.refId === refId) return t;
    return null;
  }

  spaceTabs(spaceId = this.activeSpaceId) {
    return this.order.map((id) => this.tabs.get(id)).filter((t) => t && t.spaceId === spaceId);
  }

  /** Tabs in sidebar order (favorites, pinned, today) for Ctrl+Tab / Ctrl+1..9. */
  sidebarTabOrder() {
    const lib = this.ctl.library;
    const out = [];
    for (const it of lib.favorites) out.push({ itemId: it.id, tab: this.tabForRef(it.id) });
    for (const it of lib.space(this.activeSpaceId)?.pinned || []) out.push({ itemId: it.id, tab: this.tabForRef(it.id) });
    for (const t of this.spaceTabs()) out.push({ itemId: null, tab: t });
    return out;
  }

  // ------------------------------------------------------------ layout

  metrics() {
    const [W, H] = this.win.getContentSize();
    const s = this.ctl.settings.data;
    if (this.htmlFullscreen || this.focusMode) {
      return { W, H, sidebar: 0, gap: 0, top: 0, radius: 0, content: { x: 0, y: 0, width: W, height: H }, bare: true };
    }
    const sidebar = s.sidebarHidden ? 0 : s.sidebarCompact ? COMPACT_WIDTH : s.sidebarWidth;
    const gap = s.contentGap;
    const radius = this.win.isMaximized() || this.win.isFullScreen() ? Math.min(s.cornerRadius, 8) : s.cornerRadius;
    const left = s.sidebarSide === 'left';
    const x = left && sidebar ? sidebar : gap;
    const width = Math.max(200, W - sidebar - (sidebar ? gap : gap * 2));
    return {
      W,
      H,
      sidebar,
      gap,
      top: TOPBAR_HEIGHT,
      radius,
      content: { x, y: TOPBAR_HEIGHT, width, height: Math.max(150, H - TOPBAR_HEIGHT - gap) },
      bare: false
    };
  }

  visibleInfobar() {
    return this.infobars.find((b) => b.tabId === this.activeTabId) || null;
  }

  topInset() {
    if (this.htmlFullscreen) return 0;
    const tab = this.activeTab();
    let h = 0;
    if (this.visibleInfobar()) h += INFOBAR_HEIGHT;
    if (this.find.open && tab) h += FIND_HEIGHT;
    return h;
  }

  /** Tabs on screen: the active tab, or both halves of a split view. */
  visibleTabs() {
    const a = this.activeTab();
    if (!a) return [];
    if (this.split) {
      const pair = this.split.ids.map((id) => this.tabs.get(id));
      if (pair.some((t) => !t)) this.split = null;
      else if (pair.includes(a) && !this.htmlFullscreen) return pair;
    }
    return [a];
  }

  /** Screen rectangles for each visible tab (x/y in window coordinates). */
  paneRects() {
    const m = this._metrics || this.metrics();
    const inset = this.topInset();
    const c = m.content;
    const y = c.y + inset;
    const h = Math.max(50, c.height - inset);
    const tabs = this.visibleTabs();
    if (tabs.length < 2) return tabs.map((t) => ({ tab: t, x: c.x, y, width: c.width, height: h }));
    const w1 = Math.floor((c.width - SPLIT_GAP) / 2);
    return [
      { tab: tabs[0], x: c.x, y, width: w1, height: h },
      { tab: tabs[1], x: c.x + w1 + SPLIT_GAP, y, width: c.width - w1 - SPLIT_GAP, height: h }
    ];
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const m = this.metrics();
    this._metrics = m;
    this.uiView.setBounds({ x: 0, y: 0, width: m.W, height: m.H });
    for (const p of this.paneRects()) {
      const v = p.tab.view;
      if (!v || !this.shownViews.includes(v)) continue;
      v.setBounds({ x: p.x, y: p.y, width: p.width, height: p.height });
      if (v._techinRadius !== m.radius) {
        v._techinRadius = m.radius;
        v.setBorderRadius(m.radius);
      }
    }
    this.scheduleState();
  }

  applyViewStyle(view) {
    const r = this._metrics ? this._metrics.radius : this.ctl.settings.data.cornerRadius;
    view._techinRadius = r;
    view.setBorderRadius(r);
  }

  /** Puts the right page(s) on screen and orders UI vs pages. */
  syncViews() {
    if (this.win.isDestroyed()) return;
    const desired = [];
    if (!this.panel) {
      for (const t of this.visibleTabs()) {
        if (t.error || t.crashed) continue;
        t.ensureView();
        desired.push(t.view);
      }
    }
    for (const v of this.shownViews) {
      if (desired.includes(v)) continue;
      try {
        this.win.contentView.removeChildView(v);
      } catch {}
    }
    for (const v of desired) {
      if (this.shownViews.includes(v)) continue;
      this.win.contentView.addChildView(v);
      this.uiOnTop = false;
    }
    this.shownViews = desired;
    const wantUiTop = (!!this.modal && this.uiTopReady) || !desired.length;
    if (wantUiTop && !this.uiOnTop) {
      this.win.contentView.addChildView(this.uiView);
      this.uiOnTop = true;
    } else if (!wantUiTop && this.uiOnTop) {
      for (const v of desired) this.win.contentView.addChildView(v);
      this.uiOnTop = false;
    }
    this.layout();
  }

  detachTabView(tab) {
    if (tab.view && this.shownViews.includes(tab.view)) {
      try {
        this.win.contentView.removeChildView(tab.view);
      } catch {}
      this.shownViews = this.shownViews.filter((v) => v !== tab.view);
    }
  }

  focusPage() {
    const tab = this.activeTab();
    if (tab && tab.alive && !this.modal && this.shownViews.includes(tab.view)) tab.wc.focus();
    else if (!this.uiView.webContents.isDestroyed()) this.uiView.webContents.focus();
  }

  /** Clicking into one half of a split view makes that tab the active one. */
  onTabFocused(tab) {
    if (this.split && this.split.ids.includes(tab.id) && this.activeTabId !== tab.id && this.visibleTabs().includes(tab)) {
      this.activeTabId = tab.id;
      this.activeBySpace[this.activeSpaceId] = tab.id;
      this.find = { open: false, text: '' };
      this.layout();
    }
  }

  toggleSplit(withTabId) {
    const a = this.activeTab();
    if (!a) return;
    if (this.split && this.split.ids.includes(a.id) && !withTabId) {
      this.split = null;
      this.syncViews();
      this.focusPage();
      return;
    }
    let b = withTabId ? this.tabs.get(withTabId) : null;
    if (!b) {
      b = [...this.tabs.values()]
        .filter((t) => t !== a && (t.kind === 'favorite' || t.spaceId === this.activeSpaceId))
        .sort((x, y) => y.lastActive - x.lastActive)[0];
    }
    if (!b || b === a) {
      this.ctl.toast(this.ctl.t('Bölmek için önce başka bir sekme açın'), 'info');
      return;
    }
    this.split = { ids: [a.id, b.id] };
    this.find = { open: false, text: '' };
    this.syncViews();
    this.focusPage();
  }
  // ------------------------------------------------------------ tabs

  createTab(opts = {}) {
    const kind = opts.kind || 'normal';
    const tab = new Tab(this, {
      url: opts.url,
      title: opts.title,
      favicon: opts.favicon,
      navState: opts.navState,
      kind,
      refId: opts.refId,
      spaceId: opts.spaceId || this.activeSpaceId,
      openerId: opts.openerId,
      adoptWebContents: opts.adopt
    });
    this.tabs.set(tab.id, tab);
    if (kind === 'normal') {
      let at = 0;
      if (Number.isInteger(opts.orderIndex)) at = this._globalIndexFor(tab.spaceId, opts.orderIndex);
      else if (opts.openerId && this.order.includes(opts.openerId)) {
        // Below the opener and below siblings it already opened.
        at = this.order.indexOf(opts.openerId) + 1;
        while (at < this.order.length && this.tabs.get(this.order[at])?.openerId === opts.openerId) at++;
      }
      this.order.splice(at, 0, tab.id);
    }
    if (opts.background) {
      this.scheduleState();
    } else {
      this.activateTab(tab.id);
    }
    this.ctl.saveSessionSoon();
    return tab;
  }

  _globalIndexFor(spaceId, spaceIndex) {
    const inSpace = this.order.filter((id) => this.tabs.get(id)?.spaceId === spaceId);
    if (spaceIndex >= inSpace.length) {
      const last = inSpace[inSpace.length - 1];
      return last ? this.order.indexOf(last) + 1 : this.order.length;
    }
    return this.order.indexOf(inSpace[Math.max(0, spaceIndex)]);
  }

  addTabFromOpener(opener, webContents, { url, background }) {
    return this.createTab({
      adopt: webContents,
      url,
      spaceId: opener.spaceId || this.activeSpaceId,
      openerId: opener.kind === 'normal' ? opener.id : null,
      background
    });
  }

  activateTab(id, { focus = true } = {}) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const prev = this.activeTab();
    if (prev && prev !== tab) {
      prev.lastActive = Date.now();
      if (this.find.open && prev.alive) prev.wc.stopFindInPage('clearSelection');
      this.find = { open: false, text: '' };
    }
    if (tab.kind !== 'favorite' && tab.spaceId && tab.spaceId !== this.activeSpaceId) this.activeSpaceId = tab.spaceId;
    this.activeTabId = id;
    this.activeBySpace[this.activeSpaceId] = id;
    tab.lastActive = Date.now();
    this.panel = null;
    this.syncViews();
    if (focus) this.focusPage();
    this.scheduleState();
    this.ctl.saveSessionSoon();
  }

  removeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (!this.incognito && /^https?:/.test(tab.url)) {
      this.closedTabs.push({
        url: tab.url,
        title: tab.title,
        favicon: tab.favicon,
        kind: tab.kind,
        refId: tab.refId,
        spaceId: tab.spaceId,
        navState: tab.navState,
        orderIndex: this.spaceTabs(tab.spaceId).indexOf(tab)
      });
      if (this.closedTabs.length > MAX_CLOSED) this.closedTabs.shift();
    }
    const wasActive = this.activeTabId === id;
    if (this.split && this.split.ids.includes(id)) {
      const other = this.split.ids.find((x) => x !== id);
      this.split = null;
      if (wasActive && this.tabs.has(other)) {
        tab.destroy();
        this.tabs.delete(id);
        const oi0 = this.order.indexOf(id);
        if (oi0 >= 0) this.order.splice(oi0, 1);
        this.dismissInfobar((b) => b.tabId === id);
        this.activeTabId = null;
        this.activateTab(other);
        this.ctl.saveSessionSoon();
        return;
      }
    }
    let next = null;
    if (wasActive) next = this._pickNextAfterClose(tab);
    tab.destroy();
    this.tabs.delete(id);
    const oi = this.order.indexOf(id);
    if (oi >= 0) this.order.splice(oi, 1);
    this.dismissInfobar((b) => b.tabId === id);
    for (const [sp, tid] of Object.entries(this.activeBySpace)) if (tid === id) delete this.activeBySpace[sp];
    if (wasActive) {
      this.activeTabId = null;
      if (next) this.activateTab(next.id);
      else this.syncViews();
    }
    this.scheduleState();
    this.ctl.saveSessionSoon();
  }

  _pickNextAfterClose(tab) {
    const opener = tab.openerId && this.tabs.get(tab.openerId);
    if (opener && opener.spaceId === tab.spaceId) return opener;
    if (tab.kind === 'normal') {
      const list = this.spaceTabs(tab.spaceId);
      const i = list.indexOf(tab);
      const cand = list[i + 1] || list[i - 1];
      if (cand) return cand;
    }
    // Most recently used remaining tab of this space.
    let best = null;
    for (const t of this.tabs.values()) {
      if (t === tab) continue;
      if (t.kind !== 'favorite' && t.spaceId !== this.activeSpaceId) continue;
      if (!best || t.lastActive > best.lastActive) best = t;
    }
    return best;
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (tab) tab.close();
  }

  reopenClosed() {
    const c = this.closedTabs.pop();
    if (!c) return;
    if (c.refId && this.ctl.library.find(c.refId) && !this.tabForRef(c.refId)) {
      const found = this.ctl.library.find(c.refId);
      return this.createTab({ url: c.url, title: c.title, favicon: c.favicon, navState: c.navState, kind: found.kind, refId: c.refId, spaceId: found.spaceId || c.spaceId });
    }
    this.createTab({ url: c.url, title: c.title, favicon: c.favicon, navState: c.navState, spaceId: c.spaceId, orderIndex: c.orderIndex });
  }

  moveTab(tabId, spaceIndex) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.kind !== 'normal' || !Number.isInteger(spaceIndex)) return;
    this.order.splice(this.order.indexOf(tabId), 1);
    this.order.splice(this._globalIndexFor(tab.spaceId, spaceIndex), 0, tabId);
    this.scheduleState();
    this.ctl.saveSessionSoon();
  }

  moveTabToSpace(tabId, spaceId) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.kind !== 'normal' || !this.ctl.library.space(spaceId)) return;
    tab.spaceId = spaceId;
    this.order.splice(this.order.indexOf(tabId), 1);
    this.order.unshift(tabId);
    if (this.activeTabId === tabId) this.activeBySpace[spaceId] = tabId;
    this.switchSpace(spaceId);
  }

  cycleTab(dir) {
    const list = this.sidebarTabOrder();
    if (!list.length) return;
    let i = list.findIndex((e) => e.tab && e.tab.id === this.activeTabId);
    if (i < 0) i = dir > 0 ? -1 : 0;
    const e = list[(i + dir + list.length) % list.length];
    if (e.tab) this.activateTab(e.tab.id);
    else this.openItem(e.itemId);
  }

  selectTabIndex(n) {
    const list = this.sidebarTabOrder();
    const e = n === 9 ? list[list.length - 1] : list[n - 1];
    if (!e) return;
    if (e.tab) this.activateTab(e.tab.id);
    else this.openItem(e.itemId);
  }

  clearToday() {
    for (const t of this.spaceTabs()) if (!t.audible) t.close({ force: true });
  }

  sleepTab(id) {
    const t = this.tabs.get(id);
    if (t) t.sleep();
  }

  duplicateTab(id) {
    const t = this.tabs.get(id);
    if (!t) return;
    this.createTab({ url: t.url, title: t.title, favicon: t.favicon, navState: t.currentNavState(), openerId: t.kind === 'normal' ? t.id : null, spaceId: t.spaceId || this.activeSpaceId });
  }

  tabChanged(tab) {
    if (tab.id === this.activeTabId || tab.kind !== 'normal' || tab.spaceId === this.activeSpaceId) this.scheduleState();
  }

  onTabNavigated(tab) {
    // Permission prompts belong to the page that asked.
    const origin = originOf(tab.url);
    this.dismissInfobar((b) => b.tabId === tab.id && b.type === 'permission' && b.origin !== origin);
    if (tab.id === this.activeTabId && this.find.open) this.closeFind(false);
    this.ctl.saveSessionSoon();
  }

  onTabMeta(tab) {
    if (!tab.refId) return;
    const found = this.ctl.library.find(tab.refId);
    if (!found) return;
    const sameSite = hostOf(found.item.url) && hostOf(found.item.url) === hostOf(tab.url);
    if (!sameSite) return;
    const patch = {};
    if (tab.favicon && tab.favicon !== found.item.favicon) patch.favicon = tab.favicon;
    if (!found.item.customTitle && tab.title && tab.title !== found.item.title && !found.item.title) patch.title = tab.title;
    if (Object.keys(patch).length) this.ctl.library.updateItem(tab.refId, patch);
  }

  // ------------------------------------------------------------ favorites / pinned / spaces

  openItem(itemId, { background = false } = {}) {
    const existing = this.tabForRef(itemId);
    if (existing) return background ? existing : (this.activateTab(existing.id), existing);
    const found = this.ctl.library.find(itemId);
    if (!found) return null;
    return this.createTab({
      url: found.item.url,
      title: found.item.title,
      favicon: found.item.favicon,
      kind: found.kind,
      refId: itemId,
      spaceId: found.spaceId || this.activeSpaceId,
      background
    });
  }

  resetItem(itemId) {
    const found = this.ctl.library.find(itemId);
    const tab = this.tabForRef(itemId);
    if (found && tab) tab.load(found.item.url);
  }

  pinTab(tabId, kind, index) {
    const tab = this.tabs.get(tabId);
    if (!tab || !/^(https?|file):/.test(tab.url)) return;
    const spaceId = tab.spaceId || this.activeSpaceId;
    if (tab.refId) {
      this.ctl.library.moveItem(tab.refId, kind, spaceId, index);
      return;
    }
    const item = this.ctl.library.addItem(kind, spaceId, { url: tab.url, title: tab.title, favicon: tab.favicon }, index);
    if (!item) return this.ctl.toast(this.ctl.t('Sık kullanılanlar dolu (en fazla 24).'), 'star');
    tab.kind = kind;
    tab.refId = item.id;
    const oi = this.order.indexOf(tabId);
    if (oi >= 0) this.order.splice(oi, 1);
    this.ctl.onLibraryChanged();
  }

  /** Moves a pinned/favorite item back to the "today" list at spaceIndex. */
  unpinItem(itemId, spaceIndex) {
    const found = this.ctl.library.find(itemId);
    if (!found) return;
    const tab = this.tabForRef(itemId);
    this.ctl.library.removeItem(itemId); // triggers reconcileLibrary() in every window
    if (tab) {
      if (Number.isInteger(spaceIndex)) this.moveTab(tab.id, spaceIndex);
    } else if (Number.isInteger(spaceIndex)) {
      this.createTab({ url: found.item.url, title: found.item.title, favicon: found.item.favicon, background: true, orderIndex: spaceIndex });
    }
  }

  /** Library changed (maybe in another window): relink tabs to items. */
  reconcileLibrary() {
    const lib = this.ctl.library;
    if (!lib.space(this.activeSpaceId)) this.activeSpaceId = lib.spaces[0].id;
    for (const tab of this.tabs.values()) {
      if (!lib.space(tab.spaceId)) tab.spaceId = this.activeSpaceId;
      if (!tab.refId) continue;
      const found = lib.find(tab.refId);
      if (!found) {
        tab.kind = 'normal';
        tab.refId = null;
        if (!this.order.includes(tab.id)) this.order.unshift(tab.id);
      } else {
        tab.kind = found.kind;
        if (found.spaceId) tab.spaceId = found.spaceId;
        const oi = this.order.indexOf(tab.id);
        if (oi >= 0) this.order.splice(oi, 1);
      }
    }
    const active = this.activeTab();
    if (active && active.kind !== 'favorite' && active.spaceId !== this.activeSpaceId) this.activeSpaceId = active.spaceId;
    this.scheduleState();
    this.ctl.saveSessionSoon();
  }

  switchSpace(spaceId) {
    if (!this.ctl.library.space(spaceId)) return;
    const prev = this.activeTab();
    this.activeSpaceId = spaceId;
    this.panel = null;
    const id = this.activeBySpace[spaceId];
    const t = id && this.tabs.get(id);
    if (t && (t.kind === 'favorite' || t.spaceId === spaceId)) {
      this.activateTab(t.id);
    } else {
      if (prev) prev.lastActive = Date.now();
      this.activeTabId = null;
      this.find = { open: false, text: '' };
      this.syncViews();
      this.focusPage();
    }
    this.scheduleState();
    this.ctl.saveSessionSoon();
  }

  deleteSpace(spaceId) {
    const lib = this.ctl.library;
    if (lib.spaces.length <= 1) return;
    const target = lib.spaces.find((s) => s.id !== spaceId);
    for (const w of this.ctl.windows) {
      for (const t of [...w.tabs.values()]) if (t.spaceId === spaceId && t.kind !== 'favorite') t.close({ force: true });
    }
    lib.removeSpace(spaceId);
    this.switchSpace(target.id);
  }

  // ------------------------------------------------------------ navigation

  searchTemplate() {
    return this.ctl.searchTemplate();
  }

  /** Opens typed text / URL, in a new tab or the current one. */
  openUrl(text, { newTab = false, background = false } = {}) {
    const n = normalizeInput(text, this.searchTemplate());
    if (!n) return null;
    const tab = this.activeTab();
    if (!newTab && tab) {
      tab.load(n.url);
      this.activateTab(tab.id);
      return tab;
    }
    return this.createTab({ url: n.url, background });
  }

  downloadURL(url) {
    const tab = this.activeTab();
    if (tab && tab.alive) tab.wc.downloadURL(url);
    else this.session.downloadURL(url);
  }

  navigate(op) {
    const tab = this.activeTab();
    if (!tab) return;
    if (op === 'back') tab.goBack();
    else if (op === 'forward') tab.goForward();
    else if (op === 'reload') tab.reload(false);
    else if (op === 'hardReload') tab.reload(true);
    else if (op === 'stop') tab.stop();
  }

  errorAction(op) {
    const tab = this.activeTab();
    if (!tab || !tab.error) return;
    const err = tab.error;
    if (op === 'retry') {
      tab.error = null;
      tab.load(err.url || tab.url);
      this.syncViews();
    } else if (op === 'back') {
      tab.error = null;
      this.syncViews();
      if (tab.alive && tab.wc.navigationHistory.canGoBack()) tab.wc.navigationHistory.goBack();
      else if (tab.kind === 'normal') tab.close({ force: true });
    } else if (op === 'proceed' && err.host) {
      if (err.kind === 'cert' && err.cert?.fingerprint) this.ctl.bypass.cert.set(err.host, err.cert.fingerprint);
      else if (err.kind === 'malware' || err.kind === 'phishing') this.ctl.bypass.threat.add(err.host);
      else return;
      tab.error = null;
      tab.load(err.url);
      this.syncViews();
    } else if (op === 'http' && err.kind === 'https-only' && err.host) {
      this.ctl.bypass.http.add(err.host);
      tab.upgradedHost = null;
      tab.error = null;
      const u = safeURL(err.url);
      if (u) {
        u.protocol = 'http:';
        tab.load(u.href);
      }
      this.syncViews();
    }
    this.scheduleState();
  }

  // ------------------------------------------------------------ panels, modal, find, infobars

  openPanel(name) {
    if (!['settings', 'history', 'downloads'].includes(name)) return;
    this.closeModal();
    this.panel = name;
    this.syncViews();
    this.uiView.webContents.focus();
    this.scheduleState();
  }

  closePanel() {
    if (!this.panel) return;
    this.panel = null;
    this.syncViews();
    this.focusPage();
  }

  openModal(modal) {
    const replacing = !!this.modal;
    if (replacing) this.closeModal(null, true);
    this.modal = modal;
    modal._seq = this._modalSeq = (this._modalSeq || 0) + 1;
    // Raise the UI above the page only once it has painted the dialog and the
    // see-through hole over the page; raising first shows a frame or two of the
    // UI's own background where the page is (a visible black flicker).
    this.uiTopReady = replacing && this.uiOnTop;
    clearTimeout(this._modalRaiseFallback);
    this._modalRaiseFallback = setTimeout(() => this.onModalPainted(modal._seq), 250);
    this.syncViews();
    this.uiView.webContents.focus();
    this.sendState();
    this.sendEvent('modal-open', { type: modal.type });
  }

  /** The UI reports that the dialog with this sequence number is on screen. */
  onModalPainted(seq) {
    if (!this.modal || this.modal._seq !== seq || this.uiTopReady || this.win.isDestroyed()) return;
    clearTimeout(this._modalRaiseFallback);
    this.uiTopReady = true;
    this.syncViews();
  }

  closeModal(result = null, replacing = false) {
    const m = this.modal;
    if (!m) return;
    this.modal = null;
    clearTimeout(this._modalRaiseFallback);
    try {
      m.onClose?.(result);
    } catch (err) {
      console.error(err);
    }
    if (replacing) return; // openModal() takes over right away, keep the UI where it is
    this.uiTopReady = false;
    this.syncViews();
    this.focusPage();
    this.scheduleState();
  }

  openPalette(mode = 'new', text = '') {
    const tab = this.activeTab();
    const edit = mode === 'edit' && tab;
    this.openModal({ type: 'palette', mode: edit ? 'edit' : 'new', text: edit ? tab.url : text });
  }

  openFind() {
    const tab = this.activeTab();
    if (!tab || !tab.alive || this.panel) return;
    this.find.open = true;
    this.layout();
    this.uiView.webContents.focus();
    this.sendEvent('find-focus', {});
    if (this.find.text) this.findQuery({ text: this.find.text, forward: true, newSession: true });
  }

  findQuery({ text, forward = true, newSession = false }) {
    const tab = this.activeTab();
    if (!tab || !tab.alive) return;
    text = String(text || '').slice(0, 500);
    const changed = text !== this.find.text;
    this.find.text = text;
    if (!text) {
      tab.wc.stopFindInPage('clearSelection');
      tab.findResult = null;
      this.scheduleState();
      return;
    }
    tab.wc.findInPage(text, { forward: forward !== false, findNext: newSession || changed, matchCase: false });
  }

  closeFind(focus = true) {
    const tab = this.activeTab();
    this.find.open = false;
    if (tab && tab.alive) {
      tab.wc.stopFindInPage('keepSelection');
      tab.findResult = null;
    }
    this.layout();
    if (focus) this.focusPage();
  }

  showInfobar(bar) {
    bar.id = bar.id || newId('b');
    // Merge duplicate permission requests from the same page.
    const dup = this.infobars.find((b) => b.type === bar.type && b.tabId === bar.tabId && b.origin === bar.origin && String(b.perms) === String(bar.perms));
    if (dup && bar.resolve) {
      const prev = dup.resolve;
      dup.resolve = (c) => {
        prev?.(c);
        bar.resolve(c);
      };
      return dup;
    }
    if (bar.type === 'unresponsive' && this.infobars.some((b) => b.type === 'unresponsive' && b.tabId === bar.tabId)) return null;
    this.infobars.push(bar);
    this.layout();
    return bar;
  }

  dismissInfobar(pred) {
    const gone = this.infobars.filter(pred);
    if (!gone.length) return;
    this.infobars = this.infobars.filter((b) => !gone.includes(b));
    for (const b of gone) b.resolve?.('dismiss');
    this.layout();
  }

  respondInfobar(id, choice) {
    const bar = this.infobars.find((b) => b.id === id);
    if (!bar) return;
    this.infobars = this.infobars.filter((b) => b !== bar);
    if (bar.type === 'unresponsive') {
      const tab = this.tabs.get(bar.tabId);
      if (choice === 'kill' && tab) tab.reloadCrashed();
    } else {
      bar.resolve?.(choice);
    }
    this.layout();
    this.focusPage();
  }

  setHtmlFullscreen(tab, on) {
    this.htmlFullscreen = on ? tab.id : null;
    if (on && !this.win.isFullScreen()) this.win.setFullScreen(true);
    if (!on && this.win.isFullScreen() && !this.focusMode) this.win.setFullScreen(false);
    this.layout();
  }

  toggleFocusMode() {
    this.focusMode = !this.focusMode;
    this.win.setFullScreen(this.focusMode);
    this.layout();
  }

  toggleMaximize() {
    if (this.win.isFullScreen()) this.win.setFullScreen(false);
    else if (this.win.isMaximized()) this.win.unmaximize();
    else this.win.maximize();
  }

  // ------------------------------------------------------------ keyboard

  handleKey(input, sourceTab) {
    if (input.type !== 'keyDown') return false;
    const ctrl = input.control || input.meta;
    const { shift, alt } = input;
    const key = String(input.key || '').toLowerCase();
    const code = input.code || '';
    const tab = this.activeTab();
    const run = (fn) => {
      fn();
      return true;
    };

    if (ctrl && !alt) {
      if (code === 'KeyT') return run(() => (shift ? this.reopenClosed() : this.openPalette('new')));
      if (code === 'KeyN') return run(() => this.ctl.newWindow({ incognito: shift }));
      if (code === 'KeyL' && !shift) return run(() => this.openPalette('edit'));
      if ((code === 'KeyW' && !shift) || code === 'F4') {
        return run(() => {
          if (this.modal) this.closeModal();
          else if (this.panel) this.closePanel();
          else if (tab) tab.close();
        });
      }
      if (code === 'KeyW' && shift) return run(() => this.win.close());
      if (code === 'Tab' || code === 'PageDown' || code === 'PageUp') {
        return run(() => this.cycleTab(code === 'PageUp' || (code === 'Tab' && shift) ? -1 : 1));
      }
      if (/^Digit[1-9]$/.test(code) && !shift) return run(() => this.selectTabIndex(Number(code.slice(5))));
      if (code === 'KeyR') return run(() => this.navigate(shift ? 'hardReload' : 'reload'));
      if (code === 'KeyF' && !shift) return run(() => this.openFind());
      if (code === 'KeyH' && !shift) return run(() => this.openPanel('history'));
      if (code === 'KeyJ' && !shift) return run(() => this.openPanel('downloads'));
      if (code === 'Comma') return run(() => this.openPanel('settings'));
      if (code === 'KeyD' && !shift) return run(() => tab && this.togglePinActive('favorite'));
      if (code === 'KeyP' && !shift) return run(() => tab && tab.alive && tab.wc.print());
      if (code === 'KeyU' && !shift) {
        return run(() => tab && /^https?:/.test(tab.url) && this.createTab({ url: 'view-source:' + tab.url, openerId: tab.kind === 'normal' ? tab.id : null }));
      }
      if (code === 'KeyS' && shift) return run(() => this.ctl.setSetting('sidebarHidden', !this.ctl.settings.data.sidebarHidden));
      if (code === 'Backslash' && shift) return run(() => this.toggleSplit());
      if (code === 'KeyC' && shift) {
        return run(() => {
          if (tab) {
            tab.copyUrl();
            this.ctl.toast(this.ctl.t('Bağlantı kopyalandı'), 'link');
          }
        });
      }
      if (code === 'KeyI' && shift) return run(() => this.toggleDevTools(tab));
      if (code === 'Delete' && shift) return run(() => this.openPanel('settings') || this.sendEvent('settings-section', { id: 'privacy' }));
      // Zoom keys by character, not key position (Turkish Q has '-' where US has '=').
      if (key === '+' || key === '=' || code === 'NumpadAdd') return run(() => tab && tab.zoomStep(1));
      if (key === '-' || key === '_' || code === 'NumpadSubtract') return run(() => tab && tab.zoomStep(-1));
      if (key === '0' || code === 'Numpad0') return run(() => tab && tab.setZoom(1));
      return false;
    }
    if (alt && !ctrl && !shift) {
      if (code === 'ArrowLeft') return run(() => this.navigate('back'));
      if (code === 'ArrowRight') return run(() => this.navigate('forward'));
      if (code === 'KeyD') return run(() => this.openPalette('edit'));
      if (code === 'Home') return run(() => tab && tab.refId && this.resetItem(tab.refId));
      return false;
    }
    if (!ctrl && !alt) {
      if (code === 'F5') return run(() => this.navigate('reload'));
      if (code === 'F6') return run(() => this.openPalette('edit'));
      if (code === 'F11') return run(() => this.toggleFocusMode());
      if (code === 'F12') return run(() => this.toggleDevTools(tab));
      if (code === 'F3') {
        return run(() => {
          if (!this.find.open) this.openFind();
          else this.findQuery({ text: this.find.text, forward: !shift });
        });
      }
      if (code === 'BrowserBack') return run(() => this.navigate('back'));
      if (code === 'BrowserForward') return run(() => this.navigate('forward'));
      if (code === 'Escape' && sourceTab && tab && tab.loading && !this.htmlFullscreen) {
        tab.stop();
        return false; // the page still gets Escape
      }
    }
    if (ctrl && code === 'F5') return run(() => this.navigate('hardReload'));
    return false;
  }

  toggleDevTools(tab) {
    if (!tab || !tab.alive) return;
    if (tab.wc.isDevToolsOpened()) tab.wc.closeDevTools();
    else tab.wc.openDevTools({ mode: 'detach' });
  }

  togglePinActive(kind) {
    const tab = this.activeTab();
    if (!tab) return;
    if (tab.refId) {
      const found = this.ctl.library.find(tab.refId);
      if (found && found.kind === kind) return this.unpinItem(tab.refId, 0);
    }
    this.pinTab(tab.id, kind);
    this.ctl.toast(kind === 'favorite' ? this.ctl.t('Sık kullanılanlara eklendi') : this.ctl.t('Sabitlendi'), kind === 'favorite' ? 'star' : 'pin');
  }

  serialize() {
    const lib = this.ctl.library;
    const refTabs = [...this.tabs.values()].filter((t) => t.kind !== 'normal');
    const ordered = [...refTabs, ...this.order.map((id) => this.tabs.get(id)).filter(Boolean)];
    return {
      bounds: this.win.getNormalBounds(),
      maximized: this.win.isMaximized(),
      activeSpaceId: lib.space(this.activeSpaceId) ? this.activeSpaceId : lib.spaces[0].id,
      activeTabId: this.activeTabId,
      activeBySpace: this.activeBySpace,
      tabs: ordered.map((t) => t.serialize())
    };
  }

  // ------------------------------------------------------------ state for the UI

  scheduleState() {
    if (this._stateTimer || this.win.isDestroyed()) return;
    this._stateTimer = setTimeout(() => {
      this._stateTimer = null;
      this.sendState();
    }, 16);
  }

  sendState() {
    const wc = this.uiView.webContents;
    if (wc.isDestroyed() || wc.isLoading()) return;
    wc.send('techin:state', this.buildState());
  }

  sendEvent(name, data) {
    const wc = this.uiView.webContents;
    if (!wc.isDestroyed()) wc.send('techin:event', name, data);
  }

  _tabState(t) {
    return {
      id: t.id,
      title: t.title || displayHost(t.url) || this.ctl.t('Yeni sekme'),
      url: t.url,
      favicon: t.favicon,
      loading: t.loading,
      audible: t.audible,
      muted: t.muted,
      sleeping: t.sleeping,
      crashed: !!t.crashed,
      active: t.id === this.activeTabId
    };
  }

  _itemState(item) {
    const t = this.tabForRef(item.id);
    return {
      id: item.id,
      url: item.url,
      title: item.customTitle ? item.title : t?.title || item.title || displayHost(item.url),
      favicon: t?.favicon || item.favicon,
      tabId: t ? t.id : null,
      open: !!t,
      active: !!t && t.id === this.activeTabId,
      sleeping: !t || t.sleeping,
      loading: !!t?.loading,
      audible: !!t?.audible,
      muted: !!t?.muted,
      moved: !!t && hostOf(t.url) !== hostOf(item.url)
    };
  }

  buildState() {
    const ctl = this.ctl;
    const s = ctl.settings.data;
    const lib = ctl.library;
    const space = lib.space(this.activeSpaceId) || lib.spaces[0];
    const tab = this.activeTab();
    const m = this._metrics || this.metrics();
    const infobar = this.visibleInfobar();
    let active = null;
    if (tab) {
      active = {
        id: tab.id,
        kind: tab.kind,
        refId: tab.refId,
        url: tab.url,
        host: displayHost(tab.url),
        title: tab.title,
        favicon: tab.favicon,
        security: tab.error && tab.error.kind === 'cert' ? 'cert-error' : securityState(tab.url),
        canGoBack: tab.canGoBack,
        canGoForward: tab.canGoForward,
        loading: tab.loading,
        blocked: tab.blocked,
        zoom: tab.zoom,
        error: tab.error,
        crashed: tab.crashed,
        sleeping: tab.sleeping,
        adblockOff: ctl.protection.isAllowlisted(tab.url),
        hoverUrl: s.showHoverUrl ? tab.hoverUrl : '',
        find: tab.findResult
      };
    }
    return {
      win: {
        id: this.id,
        incognito: this.incognito,
        maximized: this.win.isMaximized(),
        fullscreen: this.win.isFullScreen(),
        focused: this.win.isFocused(),
        bare: m.bare
      },
      layout: {
        side: s.sidebarSide,
        sidebar: m.sidebar,
        compact: s.sidebarCompact,
        hidden: s.sidebarHidden,
        gap: m.gap,
        radius: m.radius,
        content: m.content,
        topInset: this.topInset(),
        W: m.W,
        H: m.H,
        pageVisible: this.shownViews.length > 0,
        top: m.top,
        panes: this.paneRects().map((p) => ({ tabId: p.tab.id, x: p.x, y: p.y, width: p.width, height: p.height }))
      },
      theme: { mode: ctl.themeMode(), material: this.incognito ? 'gradient' : s.material, hue: space.hue, scale: s.uiScale },
      lang: ctl.lang,
      spaces: lib.spaces.map((sp) => ({ id: sp.id, name: sp.name, icon: sp.icon, hue: sp.hue })),
      activeSpaceId: space.id,
      favorites: lib.favorites.map((it) => this._itemState(it)),
      pinned: space.pinned.map((it) => this._itemState(it)),
      tabs: this.spaceTabs(space.id).map((t) => this._tabState(t)),
      active,
      panel: this.panel,
      find: { open: this.find.open && !!tab, text: this.find.text },
      infobar: infobar ? { id: infobar.id, type: infobar.type, origin: infobar.origin, perms: infobar.perms, url: infobar.url, host: infobar.host } : null,
      modal: this.modal ? { type: this.modal.type, mode: this.modal.mode, text: this.modal.text, data: this.modal.data || null, seq: this.modal._seq } : null,
      downloads: ctl.downloads.summary(this.incognito),
      closedCount: this.closedTabs.length,
      split: this.split ? this.split.ids : null,
      update: ctl.updater ? ctl.updater.state : null,
      settings: s,
      protection: {
        adblock: ctl.protection.status.adblock,
        rules: ctl.protection.status.rules,
        threats: ctl.protection.counts()
      },
      topSites: this.activeTabId || this.incognito ? null : ctl.history.topSites(8),
      meta: ctl.meta
    };
  }
}

module.exports = { TechinWindow, INFOBAR_HEIGHT, FIND_HEIGHT, COMPACT_WIDTH };
