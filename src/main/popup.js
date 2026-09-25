'use strict';
// Real popup windows (window.open with size features) — needed for sign-in
// flows that talk back to their opener. The title always shows the site's host
// so a popup can't pretend to be another site.
const { BaseWindow, WebContentsView, screen } = require('electron');
const { isNavigable, isOpenableFromPage, displayHost } = require('./url');
const { applySigninUserAgent } = require('./security');

function parseFeatures(features = '') {
  const out = {};
  for (const part of String(features).split(',')) {
    const [k, v] = part.split('=').map((s) => s && s.trim().toLowerCase());
    if (k && v && /^\d+$/.test(v)) out[k] = Number(v);
  }
  return out;
}

function openPopup(ctl, parentWin, webContents, details) {
  const f = parseFeatures(details.features);
  const area = screen.getDisplayMatching(parentWin.win.getBounds()).workArea;
  const width = Math.min(area.width, Math.max(320, f.width || 520));
  const height = Math.min(area.height, Math.max(240, (f.height || 640) + 32));
  const pb = parentWin.win.getBounds();
  const x = Number.isFinite(f.left) ? Math.min(Math.max(area.x, f.left), area.x + area.width - width) : Math.round(pb.x + (pb.width - width) / 2);
  const y = Number.isFinite(f.top) ? Math.min(Math.max(area.y, f.top), area.y + area.height - height) : Math.round(pb.y + (pb.height - height) / 3);

  const bw = new BaseWindow({
    width,
    height,
    x,
    y,
    minWidth: 240,
    minHeight: 160,
    title: displayHost(details.url) || 'Techin Browser',
    icon: ctl.iconPath,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff'
  });
  const view = new WebContentsView({ webContents });
  bw.contentView.addChildView(view);
  const fit = () => {
    const [w, h] = bw.getContentSize();
    view.setBounds({ x: 0, y: 0, width: w, height: h });
  };
  fit();
  bw.on('resize', fit);

  const wc = view.webContents;
  const popup = { kind: 'popup', win: parentWin, bw, wc, view };
  ctl.registerPopup(wc.id, popup);

  const setTitle = () => {
    if (bw.isDestroyed() || wc.isDestroyed()) return;
    const host = displayHost(wc.getURL());
    const title = wc.getTitle();
    bw.setTitle(host ? `${host}${title && title !== host ? ' — ' + title : ''}` : title || 'Techin Browser');
  };
  wc.on('page-title-updated', setTitle);
  // Sign-in popups need the same user agent handling as tabs.
  applySigninUserAgent(ctl, wc, details.url);
  wc.on('did-start-navigation', (e) => e.isMainFrame && !e.isSameDocument && applySigninUserAgent(ctl, wc, e.url));
  wc.on('did-redirect-navigation', (e) => e.isMainFrame && applySigninUserAgent(ctl, wc, e.url));
  wc.on('did-navigate', setTitle);
  wc.on('will-navigate', (e) => {
    if (!isNavigable(e.url)) e.preventDefault();
  });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (ctrl && input.code === 'KeyW') {
      e.preventDefault();
      bw.close();
    } else if (input.code === 'F12') {
      e.preventDefault();
      wc.openDevTools({ mode: 'detach' });
    } else if (input.code === 'F5' || (ctrl && input.code === 'KeyR')) {
      e.preventDefault();
      wc.reload();
    }
  });
  wc.on('context-menu', (_e, params) => {
    if (params.isEditable) ctl.menus.editMenu({ win: bw }, params);
  });
  wc.setWindowOpenHandler((d) => {
    if (!isOpenableFromPage(d.url)) return { action: 'deny' };
    return {
      action: 'allow',
      createWindow: (options) => {
        if (d.disposition === 'new-window') return openPopup(ctl, parentWin, options.webContents, d).webContents;
        const target = parentWin.win.isDestroyed() ? ctl.lastWindow() : parentWin;
        return target.createTab({ adopt: options.webContents, url: d.url }).wc;
      }
    };
  });
  wc.on('destroyed', () => {
    ctl.unregisterPopup(wc.id);
    if (!bw.isDestroyed()) bw.close();
  });
  bw.on('closed', () => {
    if (!wc.isDestroyed()) wc.close();
  });
  setTitle();
  return view;
}

module.exports = { openPopup, parseFeatures };
