'use strict';
// Command bar results: open tabs, favorites/pinned, history, actions,
// search suggestions, plus Chrome-style inline site completion.
const { session } = require('electron');
const { normalizeInput, isNavigable, safeURL, parseSuggestResponse, SEARCH_ENGINES } = require('./url');
const { fold } = require('./history');

const ACTIONS = [
  { id: 'settings', title: 'Ayarlar', icon: 'settings', keys: 'ayarlar settings preferences tercihler' },
  { id: 'history', title: 'Geçmiş', icon: 'history', keys: 'gecmis history' },
  { id: 'downloads', title: 'İndirilenler', icon: 'download', keys: 'indirilenler indirmeler downloads' },
  { id: 'incognito', title: 'Yeni gizli pencere', icon: 'incognito', keys: 'gizli incognito private ozel' },
  { id: 'newWindow', title: 'Yeni pencere', icon: 'window', keys: 'yeni pencere new window' },
  { id: 'clearData', title: 'Tarama verilerini temizle', icon: 'trash', keys: 'temizle cerez clear data cookies cache onbellek' },
  { id: 'reopen', title: 'Kapatılan sekmeyi geri aç', icon: 'undo', keys: 'kapatilan geri ac reopen closed' },
  { id: 'compact', title: 'Kenar çubuğunu gizle / göster', icon: 'sidebar', keys: 'kenar cubugu sidebar gizle goster' },
  { id: 'split', title: 'Bölünmüş görünüm', icon: 'split', keys: 'bolunmus bol yan yana split view' },
  { id: 'update', title: 'Güncellemeleri denetle', icon: 'download', keys: 'guncelle guncelleme update surum' },
  { id: 'themeDark', title: 'Koyu tema', icon: 'moon', keys: 'koyu karanlik dark tema theme' },
  { id: 'themeLight', title: 'Açık tema', icon: 'sun', keys: 'acik aydinlik light tema theme' },
  { id: 'copyUrl', title: 'Sayfa bağlantısını kopyala', icon: 'link', keys: 'kopyala baglanti copy url link' },
  { id: 'find', title: 'Sayfada bul', icon: 'search', keys: 'bul ara find' },
  { id: 'pip', title: 'Resim içinde resim', icon: 'pip', keys: 'resim icinde pip picture video' },
  { id: 'mute', title: 'Sekmeyi sessize al / sesi aç', icon: 'volume', keys: 'ses sessiz mute' },
  { id: 'sleepAll', title: 'Arka plandaki sekmeleri uyut', icon: 'moon', keys: 'uyut bellek ram memory sleep' },
  { id: 'devtools', title: 'Geliştirici araçları', icon: 'code', keys: 'gelistirici devtools inspect incele' },
  { id: 'print', title: 'Yazdır', icon: 'print', keys: 'yazdir print pdf' },
  { id: 'newSpace', title: 'Yeni alan oluştur', icon: 'plus', keys: 'yeni alan space' }
];

const PIP_SCRIPT =
  "(() => { if (document.pictureInPictureElement) return document.exitPictureInPicture(); const v = [...document.querySelectorAll('video')].filter((x) => x.readyState > 0).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]; if (v) return v.requestPictureInPicture(); })()";

let suggestSession = null;
function getSuggestSession() {
  if (!suggestSession) {
    suggestSession = session.fromPartition('techin-suggest');
    suggestSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  }
  return suggestSession;
}

function matches(terms, ...fields) {
  const hay = fold(fields.join(' '));
  return terms.every((t) => hay.includes(t));
}

function query(ctl, win, text) {
  const q = String(text || '').trim().slice(0, 500);
  const results = [];
  const t = ctl.t.bind(ctl);
  const tabs = [...win.tabs.values()];

  if (!q) {
    for (const tab of tabs.filter((x) => x.id !== win.activeTabId).sort((a, b) => b.lastActive - a.lastActive).slice(0, 6)) {
      results.push({ type: 'tab', tabId: tab.id, title: tab.title || tab.url, url: tab.url, favicon: tab.favicon });
    }
    return results;
  }

  const terms = fold(q).split(/\s+/).filter(Boolean);
  const n = normalizeInput(q, ctl.searchTemplate());
  const primarySearch = { type: 'search', text: q, url: n.search ? n.url : ctl.searchUrl(q), engine: ctl.engineName() };

  // Inline completion: "yout" -> youtube.com (from history).
  let inline = null;
  if (/^[\p{L}\p{N}.-]{2,}$/u.test(q) && !q.includes('..')) {
    const lower = q.toLowerCase().replace(/^www\./, '');
    let best = null;
    for (const s of ctl.history.topSites(60)) {
      if (s.host.startsWith(lower) && (!best || s.visits > best.visits)) best = s;
    }
    if (best) inline = { type: 'url', url: best.url, title: best.title || best.host, completion: best.host, inline: true };
  }

  if (inline) results.push(inline);
  if (n.search) results.push(primarySearch);
  else if (!inline || inline.url !== n.url) results.push({ type: 'url', url: n.url, title: '' });

  const seen = new Set(results.map((r) => r.url));
  let tabCount = 0;
  for (const tab of tabs) {
    if (tabCount >= 4) break;
    if (matches(terms, tab.title, tab.url)) {
      results.push({ type: 'tab', tabId: tab.id, title: tab.title || tab.url, url: tab.url, favicon: tab.favicon });
      seen.add(tab.url);
      tabCount++;
    }
  }
  const items = [...ctl.library.favorites, ...ctl.library.spaces.flatMap((s) => s.pinned)];
  let itemCount = 0;
  for (const it of items) {
    if (itemCount >= 3) break;
    if (!seen.has(it.url) && matches(terms, it.title, it.url)) {
      results.push({ type: 'item', itemId: it.id, title: it.title || it.url, url: it.url, favicon: it.favicon });
      seen.add(it.url);
      itemCount++;
    }
  }
  for (const h of ctl.history.search(q, 6)) {
    if (seen.has(h.url)) continue;
    results.push({ type: 'history', url: h.url, title: h.title });
    seen.add(h.url);
  }
  if (!results.some((r) => r.type === 'search')) results.push(primarySearch);

  let actionCount = 0;
  for (const a of ACTIONS) {
    if (actionCount >= 3) break;
    if (matches(terms, t(a.title), a.title, a.keys)) {
      results.push({ type: 'action', id: a.id, title: t(a.title), icon: a.icon });
      actionCount++;
    }
  }
  for (const sp of ctl.library.spaces) {
    if (sp.id !== win.activeSpaceId && matches(terms, sp.name + ' alan space')) {
      results.push({ type: 'action', id: 'space:' + sp.id, title: t('Alana geç: {0}', sp.name), icon: 'space' });
    }
  }
  return results.slice(0, 14);
}

async function suggest(ctl, text) {
  const q = String(text || '').trim();
  const s = ctl.settings.data;
  if (!s.searchSuggestions || q.length < 2 || q.length > 200) return [];
  const engine = s.searchEngine === 'custom' ? null : SEARCH_ENGINES[s.searchEngine];
  if (!engine || !engine.suggest) return [];
  try {
    const res = await getSuggestSession().fetch(engine.suggest.replace('%s', encodeURIComponent(q)), {
      signal: AbortSignal.timeout(1500),
      credentials: 'omit'
    });
    if (!res.ok) return [];
    const list = parseSuggestResponse(await res.json());
    return list
      .filter((x) => fold(x) !== fold(q))
      .slice(0, 4)
      .map((x) => ({ type: 'suggest', text: x, url: ctl.searchUrl(x) }));
  } catch {
    return [];
  }
}

function runAction(ctl, win, id) {
  const tab = win.activeTab();
  switch (id) {
    case 'settings':
    case 'history':
    case 'downloads':
      return win.openPanel(id);
    case 'incognito':
      return ctl.newWindow({ incognito: true });
    case 'newWindow':
      return ctl.newWindow();
    case 'clearData':
      win.openPanel('settings');
      return win.sendEvent('settings-section', { id: 'privacy' });
    case 'reopen':
      return win.reopenClosed();
    case 'compact':
      return ctl.setSetting('sidebarHidden', !ctl.settings.data.sidebarHidden);
    case 'themeDark':
      return ctl.setSetting('theme', 'dark');
    case 'themeLight':
      return ctl.setSetting('theme', 'light');
    case 'copyUrl':
      if (tab) {
        tab.copyUrl();
        ctl.toast(ctl.t('Bağlantı kopyalandı'), 'link');
      }
      return;
    case 'find':
      return win.openFind();
    case 'split':
      return win.toggleSplit();
    case 'update':
      return ctl.updater.check(true);
    case 'pip':
      if (tab && tab.alive) tab.wc.executeJavaScriptInIsolatedWorld(1001, [{ code: PIP_SCRIPT }], true).catch(() => {});
      return;
    case 'mute':
      return tab && tab.toggleMute();
    case 'sleepAll': {
      let n = 0;
      for (const w of ctl.windows) for (const x of w.tabs.values()) if (x.sleep()) n++;
      return ctl.toast(ctl.t('{0} sekme uyutuldu', n), 'moon');
    }
    case 'devtools':
      return win.toggleDevTools(tab);
    case 'print':
      return tab && tab.alive && tab.wc.print();
    case 'newSpace':
      return win.openModal({ type: 'space', data: { id: null, name: '', icon: '', hue: Math.floor(Math.random() * 360) } });
    default:
      if (typeof id === 'string' && id.startsWith('space:')) return win.switchSpace(id.slice(6));
  }
}

/** Executes the chosen command-bar row. Everything is re-validated here. */
function submit(ctl, win, pick, { newTab = false, mode = 'new' } = {}) {
  if (!pick || typeof pick !== 'object') return;
  let url = null;
  switch (pick.type) {
    case 'tab':
      if (typeof pick.tabId === 'string' && win.tabs.has(pick.tabId)) win.activateTab(pick.tabId);
      return;
    case 'item':
      if (typeof pick.itemId === 'string') win.openItem(pick.itemId);
      return;
    case 'action':
      return runAction(ctl, win, pick.id);
    case 'search':
    case 'suggest':
      if (typeof pick.text === 'string' && pick.text.trim()) url = ctl.searchUrl(pick.text.trim().slice(0, 500));
      break;
    case 'url':
    case 'history':
      if (typeof pick.url === 'string' && isNavigable(pick.url)) url = safeURL(pick.url).href;
      break;
    case 'text': {
      const n = normalizeInput(pick.text, ctl.searchTemplate());
      if (n) url = n.url;
      break;
    }
    default:
      return;
  }
  if (!url) return;
  const tab = win.activeTab();
  if (mode === 'edit' && tab && !newTab) {
    tab.load(url);
    win.activateTab(tab.id);
  } else {
    win.createTab({ url });
  }
}

module.exports = { query, suggest, submit, runAction, ACTIONS, PIP_SCRIPT };
