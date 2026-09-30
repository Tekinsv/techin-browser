'use strict';
// Native context menus (fast, never covered by the page).
const { Menu, clipboard, dialog, nativeImage } = require('electron');
const { isOpenableFromPage, displayHost } = require('./url');
const { sanitizeFilename } = require('./policy');

const SEP = { type: 'separator' };

function tidy(items) {
  // Drop leading/trailing/double separators.
  const out = [];
  for (const it of items) {
    if (it.type === 'separator' && (!out.length || out[out.length - 1].type === 'separator')) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

function mediaScript(x, y, body) {
  return `(() => { const el = document.elementsFromPoint(${Number(x) || 0}, ${Number(y) || 0}).find((e) => e instanceof HTMLMediaElement); if (!el) return; ${body} })()`;
}

class Menus {
  constructor(ctl) {
    this.ctl = ctl;
  }

  t(...a) {
    return this.ctl.t(...a);
  }

  popup(win, items, at) {
    const list = tidy(items);
    if (!list.length || win.win.isDestroyed()) return;
    Menu.buildFromTemplate(list).popup({ window: win.win, ...(at ? { x: Math.round(at.x), y: Math.round(at.y) } : {}) });
  }

  // ---- bookmarks

  _bmIcon(n) {
    if (n.type === 'folder' || !n.favicon) return undefined;
    try {
      const img = nativeImage.createFromDataURL(n.favicon);
      return img.isEmpty() ? undefined : img.resize({ width: 16, height: 16 });
    } catch {
      return undefined;
    }
  }

  /** Menu items for bookmark nodes: links open in the current tab (new tab with Ctrl), folders nest. */
  _bmItems(win, nodes, depth = 0) {
    const t = this.t.bind(this);
    if (!nodes.length) return [{ label: t('(boş)'), enabled: false }];
    return nodes.slice(0, 400).map((n) =>
      n.type === 'folder'
        ? { label: n.title.replace(/&/g, '&&') || t('Klasör'), submenu: depth < 12 ? this._bmItems(win, n.children, depth + 1) : [] }
        : {
            label: (n.title || n.url).slice(0, 80).replace(/&/g, '&&'),
            icon: this._bmIcon(n),
            click: (_m, _w, ev) => (ev && (ev.ctrlKey || ev.metaKey) ? win.createTab({ url: n.url, background: true }) : win.openUrl(n.url, { newTab: !win.activeTab() || !!win.activeTab()?.kind?.match(/pinned|favorite/) }))
          }
    );
  }

  bookmarkFolderMenu(win, id, at) {
    const f = this.ctl.bookmarks.find(id);
    if (!f || f.node.type !== 'folder') return;
    const t = this.t.bind(this);
    const items = this._bmItems(win, f.node.children);
    const urls = f.node.children.filter((n) => n.type === 'url');
    if (urls.length > 1) items.push(SEP, { label: t('Tümünü yeni sekmelerde aç ({0})', urls.length), click: () => urls.slice(0, 30).forEach((n) => win.createTab({ url: n.url, background: true })) });
    // Native menus can't be right-clicked: the manager edits what is inside folders.
    items.push(SEP, { label: t('Yer imlerini yönet…'), click: () => this.ctl.openBookmarkManager(win) });
    this.popup(win, items, at);
  }

  /** "Move to folder" submenu: the bar and every folder (not the item itself or its own subfolders). */
  _moveToItems(n) {
    const bm = this.ctl.bookmarks;
    const t = this.t.bind(this);
    const current = bm.parentId(n.id) || null;
    const inside = (id) => n.type === 'folder' && (id === n.id || !!bm.find(id, n.children));
    const items = [{ label: t('Yer imleri çubuğu'), type: 'radio', checked: current === null, click: () => current !== null && bm.move(n.id, null) }];
    for (const f of bm.folders().slice(0, 300)) {
      if (inside(f.id)) continue;
      items.push({ label: `${'    '.repeat(f.depth)}${(f.title || t('Klasör')).replace(/&/g, '&&')}`, type: 'radio', checked: current === f.id, click: () => current !== f.id && bm.move(n.id, f.id) });
    }
    return items;
  }

  bookmarkOverflowMenu(win, ids, at) {
    const nodes = ids.map((id) => this.ctl.bookmarks.find(id)?.node).filter(Boolean);
    this.popup(win, this._bmItems(win, nodes), at);
  }

  bookmarkMenu(win, id) {
    const f = this.ctl.bookmarks.find(id);
    if (!f) return;
    const t = this.t.bind(this);
    const n = f.node;
    const items =
      n.type === 'url'
        ? [
            { label: t('Aç'), click: () => win.openUrl(n.url) },
            { label: t('Yeni sekmede aç'), click: () => win.createTab({ url: n.url }) },
            { label: t('Bağlantıyı kopyala'), click: () => clipboard.writeText(n.url) },
            SEP,
            { label: t('Düzenle…'), click: () => win.editBookmark(n.id) },
            { label: t('Klasöre taşı'), submenu: this._moveToItems(n) },
            { label: t('Sil'), click: () => this.ctl.bookmarks.remove(n.id) }
          ]
        : [
            { label: t('Yeniden adlandır…'), click: () => win.editBookmark(n.id) },
            { label: t('Klasöre taşı'), submenu: this._moveToItems(n) },
            { label: t('Klasörü sil ({0} öğe)', this.ctl.bookmarks.countAll(n.children)), click: () => this.ctl.bookmarks.remove(n.id) }
          ];
    items.push(
      SEP,
      { label: t('Yeni klasör'), click: () => this.ctl.bookmarks.addFolder(t('Yeni klasör')) },
      { label: t('Yer imlerini yönet…'), click: () => this.ctl.openBookmarkManager(win) },
      {
        label: this.ctl.settings.data.bookmarksBar === 'never' ? t('Yer imleri çubuğunu göster') : t('Yer imleri çubuğunu gizle'),
        click: () => this.ctl.setSetting('bookmarksBar', this.ctl.settings.data.bookmarksBar === 'never' ? 'always' : 'never')
      }
    );
    this.popup(win, items);
  }

  pageMenu(tab, p) {
    const win = tab.win;
    const wc = tab.wc;
    if (!wc) return;
    const t = this.t.bind(this);
    const items = [];
    const newTab = (url) => win.createTab({ url, background: true, spaceId: tab.spaceId || win.activeSpaceId, openerId: tab.kind === 'normal' ? tab.id : null });
    const media = (body) => wc.executeJavaScriptInIsolatedWorld(1001, [{ code: mediaScript(p.x / tab.zoom, p.y / tab.zoom, body) }], true).catch(() => {});

    if (p.misspelledWord) {
      for (const s of (p.dictionarySuggestions || []).slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
      if (!p.dictionarySuggestions?.length) items.push({ label: t('Öneri yok'), enabled: false });
      items.push({ label: t('Sözlüğe ekle'), click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, SEP);
    }

    if (p.linkURL && isOpenableFromPage(p.linkURL)) {
      items.push(
        { label: t('Bağlantıyı yeni sekmede aç'), click: () => newTab(p.linkURL) },
        { label: t('Bağlantıyı gizli pencerede aç'), click: () => this.ctl.newWindow({ incognito: true, urls: [p.linkURL] }) },
        { label: t('Bağlantı adresini kopyala'), click: () => clipboard.writeText(p.linkURL) }
      );
      if (p.mediaType === 'none') items.push({ label: t('Bağlantıyı farklı kaydet…'), click: () => wc.downloadURL(p.linkURL) });
      items.push(SEP);
    }

    if (p.mediaType === 'image' && p.srcURL) {
      const httpSrc = /^https?:/.test(p.srcURL);
      if (httpSrc) items.push({ label: t('Resmi yeni sekmede aç'), click: () => newTab(p.srcURL) });
      items.push(
        { label: t('Resmi kaydet…'), click: () => wc.downloadURL(p.srcURL) },
        { label: t('Resmi kopyala'), click: () => wc.copyImageAt(p.x, p.y) }
      );
      if (httpSrc) items.push({ label: t('Resim adresini kopyala'), click: () => clipboard.writeText(p.srcURL) });
      items.push(SEP);
    }

    if (p.mediaType === 'video' || p.mediaType === 'audio') {
      const f = p.mediaFlags || {};
      items.push(
        { label: f.isPaused ? t('Oynat') : t('Duraklat'), click: () => media('el.paused ? el.play() : el.pause();') },
        { label: t('Döngü'), type: 'checkbox', checked: !!f.isLooping, click: () => media('el.loop = !el.loop;') },
        { label: t('Sessiz'), type: 'checkbox', checked: !!f.isMuted, click: () => media('el.muted = !el.muted;') },
        { label: t('Denetimleri göster'), type: 'checkbox', checked: !!f.isControlsVisible, click: () => media('el.controls = !el.controls;') }
      );
      if (p.mediaType === 'video') {
        items.push({
          label: t('Resim içinde resim'),
          click: () => media('document.pictureInPictureElement === el ? document.exitPictureInPicture() : el.requestPictureInPicture();')
        });
      }
      if (/^https?:/.test(p.srcURL || '')) {
        items.push(
          { label: p.mediaType === 'video' ? t('Videoyu kaydet…') : t('Sesi kaydet…'), click: () => wc.downloadURL(p.srcURL) },
          { label: t('Medya adresini kopyala'), click: () => clipboard.writeText(p.srcURL) }
        );
      }
      items.push(SEP);
    }

    if (p.isEditable) {
      const e = p.editFlags || {};
      items.push(
        { label: t('Geri al'), role: 'undo', enabled: e.canUndo },
        { label: t('Yinele'), role: 'redo', enabled: e.canRedo },
        SEP,
        { label: t('Kes'), role: 'cut', enabled: e.canCut },
        { label: t('Kopyala'), role: 'copy', enabled: e.canCopy },
        { label: t('Yapıştır'), role: 'paste', enabled: e.canPaste },
        { label: t('Düz metin olarak yapıştır'), role: 'pasteAndMatchStyle', enabled: e.canPaste },
        { label: t('Tümünü seç'), role: 'selectAll', enabled: e.canSelectAll },
        SEP
      );
    } else if (p.selectionText && p.selectionText.trim()) {
      const text = p.selectionText.trim().replace(/\s+/g, ' ');
      const short = text.length > 28 ? text.slice(0, 26) + '…' : text;
      items.push(
        { label: t('Kopyala'), role: 'copy' },
        { label: t('"{0}" için ara', short), click: () => newTab(this.ctl.searchUrl(text.slice(0, 500))) },
        SEP
      );
    }

    if (!p.linkURL && p.mediaType === 'none' && !p.isEditable && !(p.selectionText && p.selectionText.trim())) {
      items.push(
        { label: t('Geri'), enabled: tab.canGoBack, click: () => tab.goBack() },
        { label: t('İleri'), enabled: tab.canGoForward, click: () => tab.goForward() },
        { label: t('Yenile'), click: () => tab.reload() },
        SEP,
        { label: t('Farklı kaydet…'), click: () => this.savePage(tab) },
        { label: t('Yazdır…'), click: () => wc.print() }
      );
      if (/^https?:/.test(tab.url)) {
        items.push(
          { label: t('Bu sayfayı çevir'), click: () => newTab(`https://translate.google.com/translate?sl=auto&tl=${this.ctl.lang}&u=${encodeURIComponent(tab.url)}`) },
          { label: t('Sayfa kaynağını görüntüle'), click: () => newTab('view-source:' + tab.url) }
        );
      }
      items.push(SEP);
    }

    const ext = this.ctl.extensions ? this.ctl.extensions.pageMenuItems(tab, p) : [];
    if (ext.length) items.push(SEP, ...ext, SEP);

    items.push({
      label: t('İncele'),
      click: () => {
        if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' });
        wc.inspectElement(p.x, p.y);
      }
    });
    this.popup(win, items);
  }

  // ---- extensions

  /** Right-click on an extension's toolbar button. */
  extensionMenu(win, id) {
    const x = this.ctl.extensions;
    const ext = x && x.api.getExtension(id);
    if (!ext) return;
    const t = this.t.bind(this);
    const pinned = !this.ctl.settings.data.extUnpinned.includes(id);
    const own = x.actionMenuItems(win, id);
    this.popup(win, [
      { label: x.name(ext), enabled: false },
      SEP,
      ...own,
      ...(own.length ? [SEP] : []),
      { label: t('Seçenekler'), enabled: !!x._optionsPage(ext), click: () => x.openOptions(id, win) },
      { label: pinned ? t('Araç çubuğundan kaldır') : t('Araç çubuğuna sabitle'), click: () => this.ctl.setExtensionPinned(id, !pinned) },
      { label: t('Eklentiyi kaldır…'), click: () => this.ctl.confirmRemoveExtension(win, id) },
      SEP,
      { label: t('Eklentileri yönet'), click: () => this.ctl.openExtensionSettings(win) }
    ]);
  }

  /** The puzzle button: every installed extension, also the hidden ones. */
  extensionsMenu(win, rect) {
    const x = this.ctl.extensions;
    if (!x) return;
    const t = this.t.bind(this);
    const items = x.list().map((e) => ({
      label: e.name,
      icon: e.icon ? nativeImage.createFromDataURL(e.icon).resize({ width: 16, height: 16 }) : undefined,
      submenu: [
        { label: t('Aç'), click: () => x.activate(win, e.id, rect) },
        { label: e.pinned ? t('Araç çubuğundan kaldır') : t('Araç çubuğuna sabitle'), click: () => this.ctl.setExtensionPinned(e.id, !e.pinned) },
        { label: t('Seçenekler'), enabled: e.options, click: () => x.openOptions(e.id, win) },
        { label: t('Eklentiyi kaldır…'), click: () => this.ctl.confirmRemoveExtension(win, e.id) }
      ]
    }));
    if (!items.length) items.push({ label: t('Yüklü eklenti yok'), enabled: false });
    items.push(
      SEP,
      { label: t('Chrome Web Mağazası'), click: () => win.createTab({ url: 'https://chromewebstore.google.com/' }) },
      { label: t('Eklentileri yönet'), click: () => this.ctl.openExtensionSettings(win) }
    );
    this.popup(win, items, rect ? { x: rect.x, y: rect.y + rect.height + 4 } : null);
  }

  async savePage(tab) {
    if (!tab.alive) return;
    const name = sanitizeFilename((tab.title || displayHost(tab.url) || 'sayfa').slice(0, 100)) + '.html';
    const r = await dialog.showSaveDialog(tab.win.win, {
      defaultPath: require('node:path').join(this.ctl.downloads.downloadDir(), name),
      filters: [{ name: 'Web', extensions: ['html', 'htm'] }]
    });
    if (!r.canceled && r.filePath && tab.alive) tab.wc.savePage(r.filePath, 'HTMLComplete').catch(() => {});
  }

  editMenu(win, p) {
    const t = this.t.bind(this);
    const e = p.editFlags || {};
    this.popup(win, [
      { label: t('Geri al'), role: 'undo', enabled: e.canUndo },
      { label: t('Yinele'), role: 'redo', enabled: e.canRedo },
      SEP,
      { label: t('Kes'), role: 'cut', enabled: e.canCut },
      { label: t('Kopyala'), role: 'copy', enabled: e.canCopy },
      { label: t('Yapıştır'), role: 'paste', enabled: e.canPaste },
      { label: t('Tümünü seç'), role: 'selectAll' }
    ]);
  }

  tabMenu(win, tabId) {
    const tab = win.tabs.get(tabId);
    if (!tab) return;
    const t = this.t.bind(this);
    const lib = this.ctl.library;
    const spaceItems = lib.spaces
      .filter((sp) => sp.id !== tab.spaceId)
      .map((sp) => ({ label: `${sp.icon ? sp.icon + '  ' : ''}${sp.name}`, click: () => win.moveTabToSpace(tab.id, sp.id) }));
    const list = win.spaceTabs(tab.spaceId);
    const below = list.slice(list.indexOf(tab) + 1);
    const sideItems = this.sideScreenItems(win, (id) => this.ctl.openTabOnDisplay(win, tab.id, id));
    this.popup(win, [
      { label: t('Yenile'), click: () => tab.reload() },
      { label: t('Çoğalt'), click: () => win.duplicateTab(tab.id) },
      { label: tab.muted ? t('Sesi aç') : t('Sessize al'), click: () => tab.toggleMute() },
      { label: t('Uyut (belleği boşalt)'), enabled: tab.alive && tab.id !== win.activeTabId && !tab.audible, click: () => tab.sleep() },
      SEP,
      { label: t('Sık kullanılanlara ekle'), click: () => win.pinTab(tab.id, 'favorite') },
      { label: t('Sabitle'), click: () => win.pinTab(tab.id, 'pinned') },
      ...sideItems,
      { label: t('Bölünmüş görünümde aç'), enabled: !!win.activeTab() && tab.id !== win.activeTabId, click: () => win.toggleSplit(tab.id) },
      { label: t('Bağlantıyı kopyala'), click: () => tab.copyUrl() },
      ...(spaceItems.length ? [{ label: t('Başka alana taşı'), submenu: spaceItems }] : []),
      SEP,
      { label: t('Sekmeyi kapat'), accelerator: 'Ctrl+W', registerAccelerator: false, click: () => tab.close() },
      { label: t('Diğer sekmeleri kapat'), enabled: list.length > 1, click: () => list.filter((x) => x !== tab).forEach((x) => x.close({ force: true })) },
      { label: t('Alttaki sekmeleri kapat'), enabled: below.length > 0, click: () => below.forEach((x) => x.close({ force: true })) }
    ]);
  }

  /** "Open on the other screen": one item for two monitors, a submenu for more, nothing for one. */
  sideScreenItems(win, open) {
    const t = this.t.bind(this);
    const screens = this.ctl.otherDisplays(win).map((d, i) => ({ label: d.label || `${t('Ekran')} ${i + 2}  (${d.size.width}×${d.size.height})`, click: () => open(d.id) }));
    const label = win.sideScreen ? t('Diğer ekrana geri gönder') : t('Yan ekranda aç (tam ekran)');
    return screens.length === 1 ? [{ label, click: screens[0].click }] : screens.length > 1 ? [{ label, submenu: screens }] : [];
  }

  itemMenu(win, itemId) {
    const found = this.ctl.library.find(itemId);
    if (!found) return;
    const t = this.t.bind(this);
    const tab = win.tabForRef(itemId);
    const fav = found.kind === 'favorite';
    this.popup(win, [
      { label: t('Aç'), click: () => win.openItem(itemId) },
      ...this.sideScreenItems(win, (id) => this.ctl.openItemOnDisplay(win, itemId, id)),
      { label: t('Sabit adrese dön'), enabled: !!tab, click: () => win.resetItem(itemId) },
      { label: t('Yeniden adlandır'), visible: !fav, click: () => win.sendEvent('rename-item', { id: itemId }) },
      { label: t('Adresi bu sayfayla değiştir'), enabled: !!tab && tab.url !== found.item.url, click: () => this.ctl.library.updateItem(itemId, { url: tab.url }) },
      { label: t('Bağlantıyı kopyala'), click: () => clipboard.writeText(found.item.url) },
      { label: t('Sayfayı kapat'), enabled: !!tab, click: () => tab && tab.close() },
      SEP,
      fav
        ? { label: t('Sabitlenenlere taşı'), click: () => this.ctl.library.moveItem(itemId, 'pinned', win.activeSpaceId) }
        : { label: t('Sık kullanılanlara taşı'), click: () => this.ctl.library.moveItem(itemId, 'favorite') },
      { label: fav ? t('Sık kullanılanlardan çıkar') : t('Sabitlemeyi kaldır'), click: () => win.unpinItem(itemId, 0) }
    ]);
  }

  spaceMenu(win, spaceId) {
    const sp = this.ctl.library.space(spaceId);
    if (!sp) return;
    const t = this.t.bind(this);
    this.popup(win, [
      { label: t('Alanı düzenle…'), click: () => win.openModal({ type: 'space', data: { id: sp.id, name: sp.name, icon: sp.icon, hue: sp.hue } }) },
      { label: t('Yeni alan…'), click: () => win.openModal({ type: 'space', data: { id: null, name: '', icon: '', hue: (sp.hue + 70) % 360 } }) },
      SEP,
      {
        label: t('Alanı sil'),
        enabled: this.ctl.library.spaces.length > 1,
        click: async () => {
          const r = await dialog.showMessageBox(win.win, {
            type: 'warning',
            buttons: [t('Sil'), t('Vazgeç')],
            defaultId: 1,
            cancelId: 1,
            title: 'Techin Browser',
            message: t('"{0}" alanı silinsin mi?', sp.name),
            detail: t('Bu alandaki sabitlenmiş siteler ve açık sekmeler kapanır.')
          });
          if (r.response === 0) win.deleteSpace(sp.id);
        }
      }
    ]);
  }

  appMenu(win) {
    const t = this.t.bind(this);
    const tab = win.activeTab();
    const acc = (a) => ({ accelerator: a, registerAccelerator: false });
    this.popup(win, [
      { label: t('Yeni sekme'), ...acc('Ctrl+T'), click: () => win.newTab() },
      { label: t('Yeni pencere'), ...acc('Ctrl+N'), click: () => this.ctl.newWindow() },
      { label: t('Yeni gizli pencere'), ...acc('Ctrl+Shift+N'), click: () => this.ctl.newWindow({ incognito: true }) },
      { label: t('Kapatılan sekmeyi geri aç'), ...acc('Ctrl+Shift+T'), enabled: win.closedTabs.length > 0, click: () => win.reopenClosed() },
      SEP,
      { label: t('Geçmiş'), ...acc('Ctrl+H'), click: () => win.openPanel('history') },
      { label: t('İndirilenler'), ...acc('Ctrl+J'), click: () => win.openPanel('downloads') },
      { label: t('Ayarlar'), ...acc('Ctrl+,'), click: () => win.openPanel('settings') },
      SEP,
      { label: t('Sayfada bul'), ...acc('Ctrl+F'), enabled: !!tab?.alive, click: () => win.openFind() },
      { label: t('Yazdır…'), ...acc('Ctrl+P'), enabled: !!tab?.alive, click: () => tab.wc.print() },
      { label: t('Farklı kaydet…'), enabled: !!tab?.alive, click: () => this.savePage(tab) },
      {
        label: t('Yakınlaştırma'),
        enabled: !!tab,
        submenu: [
          { label: t('Yakınlaştır'), ...acc('Ctrl+Plus'), click: () => tab.zoomStep(1) },
          { label: t('Uzaklaştır'), ...acc('Ctrl+-'), click: () => tab.zoomStep(-1) },
          { label: t('Sıfırla ({0})', Math.round((tab?.zoom || 1) * 100) + '%'), ...acc('Ctrl+0'), click: () => tab.setZoom(1) }
        ]
      },
      { label: t('Geliştirici araçları'), ...acc('F12'), enabled: !!tab?.alive, click: () => win.toggleDevTools(tab) },
      SEP,
      { label: t('Kenar çubuğunu gizle'), type: 'checkbox', checked: this.ctl.settings.data.sidebarHidden, ...acc('Ctrl+Shift+S'), click: () => this.ctl.setSetting('sidebarHidden', !this.ctl.settings.data.sidebarHidden) },
      { label: t('Bölünmüş görünüm'), type: 'checkbox', checked: !!win.split && win.split.ids.includes(win.activeTabId), enabled: !!tab, ...acc('Ctrl+Shift+\\'), click: () => win.toggleSplit() },
      { label: t('Tam ekran'), ...acc('F11'), click: () => win.toggleFocusMode() },
      SEP,
      { label: t('Güncellemeleri denetle'), click: () => this.ctl.updater.check(true) },
      { label: t('Çıkış'), click: () => this.ctl.quit() }
    ]);
  }
}

module.exports = { Menus };
