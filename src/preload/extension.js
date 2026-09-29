'use strict';
// Runs in extension contexts only: an extension's service worker and its own
// pages (toolbar popup, options page, offscreen document). Electron implements
// just part of Chrome's extension API; this adds the rest the way Chrome
// behaves (toolbar button, context menus, tabs/windows of *this* browser,
// notifications, ...) by asking the main process (src/main/extensions.js).
// Web pages load this file too (registered for every frame) and leave at once.
const { contextBridge, ipcRenderer } = require('electron');

// A service worker's preload realm has no window/self/location of its own; the
// check that it is an extension's worker happens in the worker (chrome.runtime.id).
const isWorker = typeof window === 'undefined';
const scheme = isWorker ? 'chrome-extension:' : location.protocol;

if (scheme === 'chrome-extension:') {
  let dispatch = null;
  ipcRenderer.on('techin-ext-event', (_e, name, args) => {
    if (dispatch) dispatch(name, args);
  });
  const bridge = {
    invoke: (method, args) => ipcRenderer.invoke('techin-ext', method, args),
    listen: (name) => ipcRenderer.send('techin-ext-listen', name),
    onEvent: (fn) => {
      dispatch = fn;
    }
  };
  try {
    contextBridge.executeInMainWorld({ func: installChromeApi, args: [bridge, { isWorker }] });
  } catch (err) {
    console.error('[techin] extension API', err);
  }
}

// ---- runs in the extension's own (main) world; must be self-contained
function installChromeApi(bridge, ctx) {
  const c = globalThis.chrome;
  if (!c || !c.runtime || !c.runtime.id) return;
  const manifest = c.runtime.getManifest();

  // -- events: listeners live here, main only learns which events are wanted
  const events = new Map();
  const ev = (name) => {
    let e = events.get(name);
    if (e) return e;
    const ls = [];
    e = {
      addListener(fn) {
        if (typeof fn !== 'function' || ls.includes(fn)) return;
        if (!ls.length) bridge.listen(name);
        ls.push(fn);
      },
      removeListener(fn) {
        const i = ls.indexOf(fn);
        if (i >= 0) ls.splice(i, 1);
      },
      hasListener: (fn) => ls.includes(fn),
      hasListeners: () => ls.length > 0,
      _fire(args) {
        for (const fn of ls.slice()) {
          try {
            fn(...args);
          } catch (err) {
            console.error(err);
          }
        }
      }
    };
    events.set(name, e);
    return e;
  };
  const local = new Map(); // in-page handlers: contextMenus onclick
  bridge.onEvent((name, args) => {
    reapply();
    args = Array.isArray(args) ? args : [];
    if (name === 'contextMenus.onClicked') {
      const fn = local.get('menu:' + (args[0] && args[0].menuItemId));
      if (fn) {
        try {
          fn(...args);
        } catch (err) {
          console.error(err);
        }
      }
    }
    const e = events.get(name);
    if (e) e._fire(args);
  });

  // -- calls: promise style, or callback as the last argument (Chrome allows both)
  const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'function' ? undefined : x))));
  const lastError = (err) => {
    try {
      Object.defineProperty(c.runtime, 'lastError', { value: err ? { message: String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') } : undefined, configurable: true });
    } catch (e) {}
  };
  const finish = (p, cb) => {
    if (!cb) return p.catch((err) => Promise.reject(new Error(String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))));
    p.then(
      (r) => {
        try {
          cb(r);
        } catch (err) {
          console.error(err);
        }
      },
      (err) => {
        lastError(err);
        try {
          cb();
        } finally {
          lastError(null);
        }
      }
    );
    return undefined;
  };
  const call =
    (method, prep) =>
    (...args) => {
      let cb = null;
      if (args.length && typeof args[args.length - 1] === 'function') cb = args.pop();
      const p = Promise.resolve(prep ? prep(args) : args).then((a) => bridge.invoke(method, plain(a)));
      return finish(p, cb);
    };
  // Chromium re-installs its own API objects on `chrome` once a service worker's
  // script has run (and maybe later), silently undoing these. Remember every
  // override and put it back before any of our events/calls, and right after start.
  const defs = [];
  const put = (obj, name, value) => {
    try {
      Object.defineProperty(obj, name, { value, configurable: true, writable: true, enumerable: true });
    } catch (e) {
      try {
        obj[name] = value;
      } catch (e2) {}
    }
  };
  const resolve = (where) => {
    const ch = globalThis.chrome;
    return where === 'chrome' ? ch : ch && ch[where];
  };
  const def = (where, name, value) => {
    defs.push([where, name, value]);
    const target = resolve(where);
    if (target) put(target, name, value);
  };
  const reapply = () => {
    for (const [where, name, value] of defs) {
      try {
        const target = resolve(where);
        if (target && target[name] !== value) put(target, name, value);
      } catch (e) {}
    }
  };
  const keep = (native, names) => {
    const out = {};
    if (!native) return out;
    for (const k of names) {
      try {
        const v = native[k];
        if (v !== undefined) out[k] = typeof v === 'function' ? v.bind(native) : v;
      } catch (e) {}
    }
    return out;
  };
  const events$ = (ns, names) => {
    const o = {};
    for (const n of names) o[n] = ev(ns + '.' + n);
    return o;
  };

  // ImageData (or {size: ImageData}) -> PNG data URL, for action.setIcon
  const toDataUrl = async (d) => {
    if (!d) return null;
    if (typeof d.width === 'number' && d.data) {
      const img = d instanceof ImageData ? d : new ImageData(new Uint8ClampedArray(d.data), d.width, d.height);
      const cv = new OffscreenCanvas(img.width, img.height);
      cv.getContext('2d').putImageData(img, 0, 0);
      const blob = await cv.convertToBlob({ type: 'image/png' });
      return await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => res(null);
        fr.readAsDataURL(blob);
      });
    }
    const sizes = Object.keys(d).filter((k) => /^\d+$/.test(k));
    if (!sizes.length) return null;
    const best = sizes.map(Number).sort((a, b) => Math.abs(a - 32) - Math.abs(b - 32))[0];
    return toDataUrl(d[best]);
  };

  // ---- action (toolbar button)
  const action = {
    ...events$('action', ['onClicked', 'onUserSettingsChanged']),
    setIcon: call('action.setIcon', async ([d = {}]) => [{ tabId: d.tabId, path: d.path, imageData: d.imageData ? await toDataUrl(d.imageData) : undefined }]),
    setTitle: call('action.setTitle'),
    getTitle: call('action.getTitle'),
    setBadgeText: call('action.setBadgeText'),
    getBadgeText: call('action.getBadgeText'),
    setBadgeBackgroundColor: call('action.setBadgeBackgroundColor'),
    getBadgeBackgroundColor: call('action.getBadgeBackgroundColor'),
    setBadgeTextColor: call('action.setBadgeTextColor'),
    getBadgeTextColor: call('action.getBadgeTextColor'),
    setPopup: call('action.setPopup'),
    getPopup: call('action.getPopup'),
    enable: call('action.enable'),
    disable: call('action.disable'),
    isEnabled: call('action.isEnabled'),
    openPopup: call('action.openPopup'),
    getUserSettings: call('action.getUserSettings')
  };
  def('chrome', 'action', action);
  if (manifest.browser_action) def('chrome', 'browserAction', action);

  // ---- context menus
  let menuSeq = 0;
  const contextMenus = {
    ...events$('contextMenus', ['onClicked']),
    ACTION_MENU_TOP_LEVEL_LIMIT: 6,
    ContextType: { ALL: 'all', PAGE: 'page', FRAME: 'frame', SELECTION: 'selection', LINK: 'link', EDITABLE: 'editable', IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', LAUNCHER: 'launcher', BROWSER_ACTION: 'browser_action', PAGE_ACTION: 'page_action', ACTION: 'action' },
    ItemType: { NORMAL: 'normal', CHECKBOX: 'checkbox', RADIO: 'radio', SEPARATOR: 'separator' },
    create(props, cb) {
      props = props || {};
      const id = props.id !== undefined ? props.id : `techin-${++menuSeq}`;
      if (typeof props.onclick === 'function') {
        local.set('menu:' + id, props.onclick);
        bridge.listen('contextMenus.onClicked');
      }
      finish(bridge.invoke('contextMenus.create', plain([{ ...props, id }])), typeof cb === 'function' ? cb : null)?.catch?.(() => {});
      return id;
    },
    update: call('contextMenus.update', (a) => {
      if (a[1] && typeof a[1].onclick === 'function') {
        local.set('menu:' + a[0], a[1].onclick);
        bridge.listen('contextMenus.onClicked');
      }
      return a;
    }),
    remove: call('contextMenus.remove', (a) => {
      local.delete('menu:' + a[0]);
      return a;
    }),
    removeAll: call('contextMenus.removeAll', (a) => {
      for (const k of [...local.keys()]) if (k.startsWith('menu:')) local.delete(k);
      return a;
    })
  };
  def('chrome', 'contextMenus', contextMenus);

  // ---- tabs: our own tab list; messaging/zoom stay native (same tab ids)
  const tabs = {
    ...keep(c.tabs, ['sendMessage', 'connect', 'setZoom', 'getZoom', 'getZoomSettings', 'setZoomSettings', 'TabStatus', 'MutedInfoReason', 'WindowType', 'ZoomSettingsMode', 'ZoomSettingsScope']),
    ...events$('tabs', ['onCreated', 'onUpdated', 'onActivated', 'onRemoved', 'onHighlighted', 'onMoved', 'onAttached', 'onDetached', 'onReplaced', 'onZoomChange', 'onActiveChanged', 'onSelectionChanged', 'onHighlightChanged']),
    TAB_ID_NONE: -1,
    TAB_INDEX_NONE: -1,
    MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND: 2,
    query: call('tabs.query'),
    get: call('tabs.get'),
    getCurrent: call('tabs.getCurrent'),
    create: call('tabs.create'),
    update: call('tabs.update', (a) => (typeof a[0] === 'object' && a[0] !== null ? [null, a[0]] : a)),
    remove: call('tabs.remove'),
    reload: call('tabs.reload', (a) => (typeof a[0] === 'object' && a[0] !== null ? [null, a[0]] : a)),
    duplicate: call('tabs.duplicate'),
    goBack: call('tabs.goBack'),
    goForward: call('tabs.goForward'),
    discard: call('tabs.discard'),
    highlight: call('tabs.highlight'),
    move: call('tabs.move'),
    group: call('tabs.group'),
    ungroup: call('tabs.ungroup'),
    detectLanguage: call('tabs.detectLanguage'),
    captureVisibleTab: call('tabs.captureVisibleTab', (a) => (typeof a[0] === 'object' && a[0] !== null ? [null, a[0]] : a))
  };
  if (c.scripting) {
    // MV2 style helpers some MV3 extensions still call
    tabs.executeScript = (tabId, details, cb) => {
      if (typeof tabId === 'object') [tabId, details, cb] = [null, tabId, details];
      const target = { tabId };
      const p = (tabId === null ? tabs.query({ active: true, lastFocusedWindow: true }).then((t) => ((target.tabId = t[0] && t[0].id), 0)) : Promise.resolve())
        .then(() => c.scripting.executeScript(details.file ? { target, files: [details.file] } : { target, func: new Function(details.code) }))
        .then((r) => r.map((x) => x.result));
      return finish(p, cb);
    };
    tabs.insertCSS = (tabId, details, cb) => {
      if (typeof tabId === 'object') [tabId, details, cb] = [null, tabId, details];
      const target = { tabId };
      const p = (tabId === null ? tabs.query({ active: true, lastFocusedWindow: true }).then((t) => ((target.tabId = t[0] && t[0].id), 0)) : Promise.resolve()).then(() =>
        c.scripting.insertCSS(details.file ? { target, files: [details.file] } : { target, css: details.code })
      );
      return finish(p, cb);
    };
  }
  def('chrome', 'tabs', tabs);

  // ---- windows
  def('chrome', 'windows', {
    ...events$('windows', ['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged']),
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    WindowType: { NORMAL: 'normal', POPUP: 'popup', PANEL: 'panel', APP: 'app', DEVTOOLS: 'devtools' },
    WindowState: { NORMAL: 'normal', MINIMIZED: 'minimized', MAXIMIZED: 'maximized', FULLSCREEN: 'fullscreen', LOCKED_FULLSCREEN: 'locked-fullscreen' },
    CreateType: { NORMAL: 'normal', POPUP: 'popup', PANEL: 'panel' },
    get: call('windows.get'),
    getCurrent: call('windows.getCurrent'),
    getLastFocused: call('windows.getLastFocused'),
    getAll: call('windows.getAll'),
    create: call('windows.create'),
    update: call('windows.update'),
    remove: call('windows.remove')
  });

  // ---- notifications
  def('chrome', 'notifications', {
    ...events$('notifications', ['onClicked', 'onClosed', 'onButtonClicked', 'onPermissionLevelChanged', 'onShowSettings']),
    TemplateType: { BASIC: 'basic', IMAGE: 'image', LIST: 'list', PROGRESS: 'progress' },
    PermissionLevel: { GRANTED: 'granted', DENIED: 'denied' },
    create: call('notifications.create', (a) => (typeof a[0] === 'object' && a[0] !== null ? [null, a[0]] : a)),
    update: call('notifications.update'),
    clear: call('notifications.clear'),
    getAll: call('notifications.getAll'),
    getPermissionLevel: call('notifications.getPermissionLevel')
  });

  // ---- permissions: whatever the manifest declares is granted
  def('chrome', 'permissions', {
    ...events$('permissions', ['onAdded', 'onRemoved']),
    contains: call('permissions.contains'),
    getAll: call('permissions.getAll'),
    request: call('permissions.request'),
    remove: call('permissions.remove'),
    addHostAccessRequest: call('permissions.noop'),
    removeHostAccessRequest: call('permissions.noop')
  });

  // ---- runtime extras. Electron never fires onInstalled/onStartup; ours do
  // (install / update / browser start), and only ours, so nothing runs twice.
  if (c.runtime) {
    def('runtime', 'openOptionsPage', call('runtime.openOptionsPage'));
    def('runtime', 'setUninstallURL', call('runtime.setUninstallURL'));
    def('runtime', 'onInstalled', ev('runtime.onInstalled'));
    def('runtime', 'onStartup', ev('runtime.onStartup'));
  }

  // ---- storage.sync: no Google sync here, kept on this computer like local
  // (Electron has no sync storage at all: "sync is not available in this instance")
  if (c.storage && c.storage.local) {
    const local = c.storage.local;
    const alias = { ...keep(local, ['get', 'set', 'remove', 'clear', 'getBytesInUse', 'getKeys', 'setAccessLevel']), QUOTA_BYTES: 102400, QUOTA_BYTES_PER_ITEM: 8192, MAX_ITEMS: 512, MAX_WRITE_OPERATIONS_PER_HOUR: 1800, MAX_WRITE_OPERATIONS_PER_MINUTE: 120 };
    alias.onChanged = local.onChanged;
    def('storage', 'sync', alias);
  }

  // ---- chrome.extension helpers Electron leaves out
  if (c.extension) {
    const missing = {
      isAllowedFileSchemeAccess: call('extension.false'),
      isAllowedIncognitoAccess: call('extension.false'),
      getViews: () => [],
      setUpdateUrlData: () => undefined
    };
    for (const [k, v] of Object.entries(missing)) {
      let has = false;
      try {
        has = typeof c.extension[k] === 'function';
      } catch (e) {}
      if (!has) def('extension', k, v);
    }
  }

  // ---- font list (font pickers, e.g. Dark Reader)
  def('chrome', 'fontSettings', {
    ...events$('fontSettings', ['onFontChanged', 'onDefaultFontSizeChanged', 'onDefaultFixedFontSizeChanged', 'onMinimumFontSizeChanged']),
    getFontList: call('fontSettings.getFontList'),
    getFont: call('fontSettings.getFont'),
    setFont: call('permissions.noop'),
    clearFont: call('permissions.noop'),
    getDefaultFontSize: call('fontSettings.size16'),
    getDefaultFixedFontSize: call('fontSettings.size13'),
    getMinimumFontSize: call('fontSettings.size0'),
    setDefaultFontSize: call('permissions.noop'),
    setDefaultFixedFontSize: call('permissions.noop'),
    setMinimumFontSize: call('permissions.noop'),
    clearDefaultFontSize: call('permissions.noop'),
    clearDefaultFixedFontSize: call('permissions.noop'),
    clearMinimumFontSize: call('permissions.noop')
  });

  // ---- commands (keyboard shortcuts): none are assigned
  def('chrome', 'commands', { ...events$('commands', ['onCommand', 'onChanged']), getAll: call('commands.getAll') });

  // ---- webNavigation: top-level page events of our tabs
  def('chrome', 'webNavigation', {
    ...events$('webNavigation', ['onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onCompleted', 'onErrorOccurred', 'onCreatedNavigationTarget', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated', 'onTabReplaced']),
    getFrame: call('webNavigation.getFrame'),
    getAllFrames: call('webNavigation.getAllFrames')
  });

  // ---- offscreen documents (hidden page for DOM work / audio)
  def('chrome', 'offscreen', {
    Reason: new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? k : undefined) }),
    createDocument: call('offscreen.createDocument'),
    closeDocument: call('offscreen.closeDocument'),
    hasDocument: call('offscreen.hasDocument')
  });

  // ---- cookies
  def('chrome', 'cookies', {
    ...events$('cookies', ['onChanged']),
    get: call('cookies.get'),
    getAll: call('cookies.getAll'),
    set: call('cookies.set'),
    remove: call('cookies.remove'),
    getAllCookieStores: call('cookies.getAllCookieStores')
  });

  // ---- downloads
  def('chrome', 'downloads', {
    ...events$('downloads', ['onCreated', 'onChanged', 'onErased', 'onDeterminingFilename']),
    download: call('downloads.download'),
    search: call('downloads.search'),
    open: call('downloads.noop'),
    show: call('downloads.noop'),
    showDefaultFolder: call('downloads.noop'),
    pause: call('downloads.noop'),
    resume: call('downloads.noop'),
    cancel: call('downloads.noop'),
    erase: call('downloads.search'),
    setUiOptions: call('downloads.noop'),
    getFileIcon: call('downloads.noop')
  });

  // ---- identity: only the redirect URL helper; Google sign-in needs Chrome
  def('chrome', 'identity', {
    ...events$('identity', ['onSignInChanged']),
    getRedirectURL: (path) => `https://${c.runtime.id}.chromiumapp.org/${path || ''}`,
    getAuthToken: call('unsupported.identity'),
    launchWebAuthFlow: call('unsupported.identity'),
    getProfileUserInfo: call('identity.getProfileUserInfo'),
    removeCachedAuthToken: call('permissions.noop'),
    clearAllCachedAuthTokens: call('permissions.noop')
  });

  // ---- everything else the manifest asks for and Electron lacks: harmless
  // no-ops (events that never fire, calls that resolve empty) instead of a crash
  const stub = (ns) =>
    new Proxy(
      {},
      {
        get(t, k) {
          if (typeof k !== 'string') return undefined;
          if (k in t) return t[k];
          if (/^on[A-Z]/.test(k)) return (t[k] = ev(ns + '.' + k));
          if (/^[A-Z0-9_]+$/.test(k)) return undefined;
          return (t[k] = call('stub.' + ns + '.' + k));
        }
      }
    );
  const perms = [...(manifest.permissions || []), ...(manifest.optional_permissions || [])].filter((p) => typeof p === 'string' && /^[a-zA-Z]+(\.[a-zA-Z]+)?$/.test(p));
  const extra = ['sidePanel', 'tabGroups', 'declarativeNetRequest', 'history', 'bookmarks', 'idle', 'tts', 'ttsEngine', 'privacy', 'proxy', 'contentSettings', 'search', 'omnibox', 'sessions', 'topSites', 'pageCapture', 'browsingData', 'readingList', 'webRequestAuthProvider', 'userScripts', 'system'];
  for (const p of new Set([...perms.map((p) => p.split('.')[0]), ...extra])) {
    let has = false;
    try {
      has = c[p] !== undefined && c[p] !== null;
    } catch (e) {}
    if (!has) def('chrome', p, stub(p));
  }

  // Chromium's re-install happens right after a worker's script ran; handlers of
  // Chrome's own events (runtime.onMessage ...) must still see ours afterwards.
  for (const ms of [0, 20, 200, 1000, 5000]) setTimeout(reapply, ms);
  if (ctx.isWorker && c.runtime && c.runtime.onMessage) {
    for (const k of ['onMessage', 'onMessageExternal', 'onConnect', 'onConnectExternal']) {
      const native = c.runtime[k];
      if (!native || typeof native.addListener !== 'function') continue;
      const add = native.addListener.bind(native);
      const wrapped = new WeakMap();
      native.addListener = (fn) => {
        if (typeof fn !== 'function') return add(fn);
        const w = function (...a) {
          reapply();
          return fn.apply(this, a);
        };
        wrapped.set(fn, w);
        return add(w);
      };
      const remove = native.removeListener.bind(native);
      native.removeListener = (fn) => remove(wrapped.get(fn) || fn);
      const has = native.hasListener.bind(native);
      native.hasListener = (fn) => has(wrapped.get(fn) || fn);
    }
  }

  // ---- toolbar popup: window.close() closes it
  if (!ctx.isWorker) {
    const close = window.close.bind(window);
    window.close = () => {
      bridge.invoke('popup.close', []).then((handled) => {
        if (!handled) close();
      });
    };
  }
}
