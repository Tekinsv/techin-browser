'use strict';
// The only door from the UI renderer into the main process. Every call must
// come from the main frame of one of our own UI views, and every argument is
// type-checked before use. Web pages have no access to this channel at all.
const { ipcMain, dialog, shell, app } = require('electron');
const palette = require('./palette');
const { ID_RE } = require('./library');
const { originOf, isNavigable } = require('./url');
const { ASKABLE } = require('./policy');

const UI_URL_PREFIX = 'techin-ui://app/ui/';

function isUiUrl(url) {
  return typeof url === 'string' && url.startsWith(UI_URL_PREFIX);
}

const str = (v, max = 2000) => (typeof v === 'string' && v.length <= max ? v : null);
const id = (v) => (typeof v === 'string' && (ID_RE.test(v) || /^[a-z]-[0-9a-f]{8}$/.test(v)) ? v : null);
const int = (v, min = -1e9, max = 1e9) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
const bool = (v) => v === true;

const HANDLERS = {
  // ---- window
  'ui.ready': (ctl, w) => {
    w.uiReady = true;
    w.show();
    w.scheduleState();
  },
  'window.minimize': (ctl, w) => w.win.minimize(),
  'window.maximize': (ctl, w) => w.toggleMaximize(),
  'window.close': (ctl, w) => w.win.close(),
  'window.new': (ctl, w, a) => ctl.newWindow({ incognito: bool(a.incognito) }),
  'menu.app': (ctl, w) => ctl.menus.appMenu(w),
  'menu.tab': (ctl, w, a) => id(a.tabId) && ctl.menus.tabMenu(w, a.tabId),
  'menu.item': (ctl, w, a) => id(a.itemId) && ctl.menus.itemMenu(w, a.itemId),
  'menu.space': (ctl, w, a) => id(a.spaceId) && ctl.menus.spaceMenu(w, a.spaceId),

  // ---- tabs
  'tab.activate': (ctl, w, a) => id(a.tabId) && w.activateTab(a.tabId),
  'tab.close': (ctl, w, a) => id(a.tabId) && w.closeTab(a.tabId),
  'tab.mute': (ctl, w, a) => id(a.tabId) && w.tabs.get(a.tabId)?.toggleMute(),
  'tab.move': (ctl, w, a) => id(a.tabId) && int(a.index, 0, 10000) !== null && w.moveTab(a.tabId, a.index),
  'tab.pin': (ctl, w, a) => {
    if (!id(a.tabId) || !['pinned', 'favorite'].includes(a.kind)) return;
    w.pinTab(a.tabId, a.kind, int(a.index, 0, 1000) ?? undefined);
  },
  'tab.reopen': (ctl, w) => w.reopenClosed(),
  'tabs.clearToday': (ctl, w) => w.clearToday(),
  'item.open': (ctl, w, a) => id(a.itemId) && w.openItem(a.itemId),
  'item.close': (ctl, w, a) => id(a.itemId) && w.tabForRef(a.itemId)?.close(),
  'item.move': (ctl, w, a) => {
    if (!id(a.itemId) || !['pinned', 'favorite'].includes(a.kind)) return;
    ctl.library.moveItem(a.itemId, a.kind, w.activeSpaceId, int(a.index, 0, 1000) ?? undefined);
  },
  'item.unpin': (ctl, w, a) => id(a.itemId) && w.unpinItem(a.itemId, int(a.index, 0, 10000) ?? undefined),
  'item.rename': (ctl, w, a) => {
    const title = str(a.title, 200);
    if (id(a.itemId) && title !== null) ctl.library.updateItem(a.itemId, { title: title.trim(), custom: title.trim() !== '' });
  },

  // ---- navigation
  'nav.back': (ctl, w) => w.navigate('back'),
  'nav.forward': (ctl, w) => w.navigate('forward'),
  'nav.reload': (ctl, w, a) => w.navigate(bool(a.hard) ? 'hardReload' : 'reload'),
  'nav.stop': (ctl, w) => w.navigate('stop'),
  'nav.open': (ctl, w, a) => {
    const text = str(a.text, 16384);
    if (text) w.openUrl(text, { newTab: bool(a.newTab) || !w.activeTab() });
  },
  'nav.resetItem': (ctl, w) => {
    const tab = w.activeTab();
    if (tab && tab.refId) w.resetItem(tab.refId);
  },
  'error.action': (ctl, w, a) => ['retry', 'back', 'proceed', 'http'].includes(a.op) && w.errorAction(a.op),
  'zoom.reset': (ctl, w) => w.activeTab()?.setZoom(1),

  // ---- command bar
  'palette.open': (ctl, w, a) => w.openPalette(a.mode === 'edit' ? 'edit' : 'new', str(a.text, 100) || ''),
  'palette.query': (ctl, w, a) => palette.query(ctl, w, str(a.text, 1000) || ''),
  'palette.suggest': (ctl, w, a) => palette.suggest(ctl, str(a.text, 1000) || ''),
  'palette.submit': (ctl, w, a) => {
    const mode = w.modal?.type === 'palette' ? w.modal.mode : 'new';
    w.closeModal();
    palette.submit(ctl, w, a.pick, { newTab: bool(a.newTab), mode });
  },
  'modal.close': (ctl, w, a) => {
    const m = w.modal;
    if (!m) return;
    let result = null;
    const r = a.result;
    if (r && typeof r === 'object') {
      if (m.type === 'picker' && str(r.id, 200)) result = { id: r.id, audio: bool(r.audio) };
      if (m.type === 'auth' && str(r.user, 500) !== null && str(r.pass, 500) !== null) result = { user: r.user, pass: r.pass };
    }
    w.closeModal(result);
  },
  'space.switch': (ctl, w, a) => id(a.spaceId) && w.switchSpace(a.spaceId),
  'space.new': (ctl, w) => w.openModal({ type: 'space', data: { id: null, name: '', icon: '', hue: Math.floor(Math.random() * 360) } }),
  'space.edit': (ctl, w, a) => {
    const sp = id(a.spaceId) && ctl.library.space(a.spaceId);
    if (sp) w.openModal({ type: 'space', data: { id: sp.id, name: sp.name, icon: sp.icon, hue: sp.hue } });
  },
  'space.save': (ctl, w, a) => {
    const name = str(a.name, 40);
    const icon = str(a.icon, 8) ?? '';
    const hue = Number.isFinite(a.hue) ? a.hue : 214;
    if (a.id) {
      if (id(a.id)) ctl.library.updateSpace(a.id, { name: name || undefined, icon, hue });
    } else {
      const sp = ctl.library.addSpace({ name: name || undefined, icon, hue });
      if (sp) w.switchSpace(sp.id);
    }
    if (w.modal?.type === 'space') w.closeModal();
  },
  'space.move': (ctl, w, a) => id(a.spaceId) && int(a.index, 0, 100) !== null && ctl.library.moveSpace(a.spaceId, a.index),

  // ---- panels, find, infobars
  'panel.open': (ctl, w, a) => w.openPanel(str(a.name, 20)),
  'panel.close': (ctl, w) => w.closePanel(),
  'find.open': (ctl, w) => w.openFind(),
  'find.query': (ctl, w, a) => w.findQuery({ text: str(a.text, 500) || '', forward: a.forward !== false }),
  'find.close': (ctl, w) => w.closeFind(),
  'infobar.respond': (ctl, w, a) => {
    if (str(a.id, 20) && ['allow', 'deny', 'dismiss', 'kill', 'wait'].includes(a.choice)) w.respondInfobar(a.id, a.choice);
  },
  'focus.page': (ctl, w) => w.focusPage(),

  // ---- sidebar & settings
  'sidebar.resize': (ctl, w, a) => int(a.width, 100, 1000) !== null && ctl.setSetting('sidebarWidth', a.width, { quiet: true }),
  'settings.set': (ctl, w, a) => ctl.setSetting(str(a.key, 40), a.value),
  'settings.reset': (ctl) => ctl.resetSettings(),
  'site.info': (ctl, w) => ctl.siteInfo(w),
  'site.permission': (ctl, w, a) => {
    const origin = str(a.origin, 500);
    if (!origin || originOf(origin + '/') !== origin || !ASKABLE.has(a.perm)) return;
    ctl.setSitePermission(origin, a.perm, ['allow', 'deny', 'ask'].includes(a.value) ? a.value : 'ask', w.incognito);
  },
  'site.permissions.list': (ctl) => ctl.listSitePermissions(),
  'site.permissions.clear': (ctl, w, a) => {
    const origin = str(a.origin, 500);
    if (origin) ctl.clearSitePermissions(origin);
  },
  'site.adblock': (ctl, w, a) => {
    const host = str(a.host, 253);
    if (host && /^[a-z0-9.-]+$/i.test(host)) ctl.setAdblockForHost(host, bool(a.enabled));
  },
  'site.clearData': (ctl, w, a) => {
    const origin = str(a.origin, 500);
    if (origin && originOf(origin + '/') === origin) return ctl.clearSiteData(w, origin);
  },

  // ---- history, downloads, data
  'history.list': (ctl, w, a) => ctl.history.list({ query: str(a.query, 200) || '', offset: int(a.offset, 0, 1e6) || 0, limit: 150 }),
  'history.remove': (ctl, w, a) => str(a.url, 4096) && ctl.history.remove(a.url),
  'history.open': (ctl, w, a) => {
    const url = str(a.url, 4096);
    if (url && isNavigable(url)) w.createTab({ url, background: bool(a.background) });
  },
  'downloads.action': (ctl, w, a) => {
    if (str(a.id, 20) && ['pause', 'resume', 'cancel', 'open', 'show', 'remove', 'retry'].includes(a.op)) return ctl.downloads.action(a.id, a.op, w.win);
  },
  'downloads.clear': (ctl) => ctl.downloads.clearFinished(),
  'data.clear': (ctl, w, a) => {
    const what = Array.isArray(a.what) ? a.what.filter((x) => ['history', 'cookies', 'cache', 'downloads', 'permissions'].includes(x)) : [];
    const range = ['hour', 'day', 'week', 'all'].includes(a.range) ? a.range : 'hour';
    return ctl.clearBrowsingData(what, range);
  },
  'memory.stats': (ctl, w) => ctl.memoryStats(w),
  'tab.sleep': (ctl, w, a) => id(a.tabId) && w.sleepTab(a.tabId),

  // ---- app
  'app.chooseDownloadDir': async (ctl, w) => {
    const r = await dialog.showOpenDialog(w.win, { properties: ['openDirectory', 'createDirectory'] });
    if (!r.canceled && r.filePaths[0]) ctl.setSetting('downloadDir', r.filePaths[0]);
  },
  'app.openDownloadDir': (ctl) => shell.openPath(ctl.downloads.downloadDir()),
  'app.defaultBrowser': (ctl, w) => ctl.makeDefaultBrowser(w),
  'app.relaunch': (ctl) => ctl.relaunch(),
  'app.chooseProfileDir': (ctl, w) => ctl.chooseProfileDir(w),
  'app.openExternalDoc': (ctl, w, a) => {
    // Opens our own help links inside a tab (never arbitrary shell execution).
    const url = str(a.url, 500);
    if (url && /^https:\/\//.test(url)) w.createTab({ url });
  },
  'app.quit': (ctl) => ctl.quit(),

  // ---- updates, split view, top bar
  'update.check': (ctl) => ctl.updater.check(true),
  'update.open': (ctl, w) => w.openModal({ type: 'update' }),
  'update.download': (ctl) => ctl.updater.download(),
  'update.install': (ctl) => ctl.updater.install(),
  'split.toggle': (ctl, w) => w.toggleSplit(),
  'tab.copyUrl': (ctl, w) => {
    const tab = w.activeTab();
    if (!tab) return;
    tab.copyUrl();
    ctl.toast(ctl.t('Bağlantı kopyalandı'), 'link');
  }
};

function installIpc(ctl) {
  ipcMain.handle('techin:cmd', async (event, action, args) => {
    const frame = event.senderFrame;
    const win = ctl.windowForUi(event.sender);
    if (!win || !frame || frame !== event.sender.mainFrame || !isUiUrl(frame.url)) {
      throw new Error('Forbidden');
    }
    const fn = typeof action === 'string' && Object.prototype.hasOwnProperty.call(HANDLERS, action) ? HANDLERS[action] : null;
    if (!fn) throw new Error('Unknown action');
    const result = await fn(ctl, win, args && typeof args === 'object' ? args : {});
    return result === undefined || typeof result === 'boolean' || result === null || typeof result === 'object' ? result ?? null : null;
  });

  // Page crashes aside, the UI must never be able to reach anything else.
  ipcMain.on('techin:log', (event, msg) => {
    if (ctl.windowForUi(event.sender) && typeof msg === 'string') console.log('[ui]', msg.slice(0, 500));
  });
}

module.exports = { installIpc, HANDLERS, UI_URL_PREFIX };
