'use strict';
// Native context menus (fast, never covered by the page).
const { Menu, clipboard, dialog } = require('electron');
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

  popup(win, items) {
    const list = tidy(items);
    if (!list.length || win.win.isDestroyed()) return;
    Menu.buildFromTemplate(list).popup({ window: win.win });
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

    items.push({
      label: t('İncele'),
      click: () => {
        if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' });
        wc.inspectElement(p.x, p.y);
      }
    });
    this.popup(win, items);
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
    this.popup(win, [
      { label: t('Yenile'), click: () => tab.reload() },
      { label: t('Çoğalt'), click: () => win.duplicateTab(tab.id) },
      { label: tab.muted ? t('Sesi aç') : t('Sessize al'), click: () => tab.toggleMute() },
      { label: t('Uyut (belleği boşalt)'), enabled: tab.alive && tab.id !== win.activeTabId && !tab.audible, click: () => tab.sleep() },
      SEP,
      { label: t('Sık kullanılanlara ekle'), click: () => win.pinTab(tab.id, 'favorite') },
      { label: t('Sabitle'), click: () => win.pinTab(tab.id, 'pinned') },
      { label: t('Bölünmüş görünümde aç'), enabled: !!win.activeTab() && tab.id !== win.activeTabId, click: () => win.toggleSplit(tab.id) },
      { label: t('Bağlantıyı kopyala'), click: () => tab.copyUrl() },
      ...(spaceItems.length ? [{ label: t('Başka alana taşı'), submenu: spaceItems }] : []),
      SEP,
      { label: t('Sekmeyi kapat'), accelerator: 'Ctrl+W', registerAccelerator: false, click: () => tab.close() },
      { label: t('Diğer sekmeleri kapat'), enabled: list.length > 1, click: () => list.filter((x) => x !== tab).forEach((x) => x.close({ force: true })) },
      { label: t('Alttaki sekmeleri kapat'), enabled: below.length > 0, click: () => below.forEach((x) => x.close({ force: true })) }
    ]);
  }

  itemMenu(win, itemId) {
    const found = this.ctl.library.find(itemId);
    if (!found) return;
    const t = this.t.bind(this);
    const tab = win.tabForRef(itemId);
    const fav = found.kind === 'favorite';
    this.popup(win, [
      { label: t('Aç'), click: () => win.openItem(itemId) },
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
