'use strict';
// Download manager: safe file names, no silent overwrite, Mark-of-the-Web
// (so Windows SmartScreen checks downloaded programs), progress for the UI.
const fs = require('node:fs');
const path = require('node:path');
const { app, shell, dialog } = require('electron');
const { randomUUID } = require('node:crypto');
const { sanitizeFilename, uniquePath, isDangerousFile, zoneIdentifier } = require('./policy');

function sanitizeDownloads(obj) {
  const items = Array.isArray(obj?.items) ? obj.items : [];
  return {
    items: items
      .filter((d) => d && typeof d.path === 'string' && typeof d.url === 'string')
      .slice(0, 200)
      .map((d) => ({
        id: typeof d.id === 'string' ? d.id.slice(0, 20) : randomUUID().slice(0, 8),
        url: d.url.slice(0, 4096),
        filename: typeof d.filename === 'string' ? d.filename.slice(0, 260) : path.basename(d.path),
        path: d.path,
        total: Number(d.total) || 0,
        received: Number(d.received) || 0,
        state: ['completed', 'cancelled', 'interrupted'].includes(d.state) ? d.state : 'interrupted',
        dangerous: !!d.dangerous,
        start: Number(d.start) || 0
      }))
  };
}

class Downloads {
  constructor(ctl, store) {
    this.ctl = ctl;
    this.store = store;
    this.live = new Map(); // id -> { d, item }
    this.sessions = new WeakSet();
    this._tick = null;
  }

  get items() {
    return this.store.data.items;
  }

  attach(ses, incognito) {
    if (this.sessions.has(ses)) return;
    this.sessions.add(ses);
    ses.on('will-download', (event, item, wc) => this._onWillDownload(item, wc, incognito));
  }

  downloadDir() {
    const custom = this.ctl.settings.data.downloadDir;
    if (custom) {
      try {
        if (fs.statSync(custom).isDirectory()) return custom;
      } catch {}
    }
    return app.getPath('downloads');
  }

  _onWillDownload(item, wc, incognito) {
    const dir = this.downloadDir();
    const filename = sanitizeFilename(item.getFilename());
    const target = uniquePath(dir, filename, (p) => fs.existsSync(p) || [...this.live.values()].some((l) => l.d.path === p));
    if (this.ctl.settings.data.askDownload) {
      item.setSaveDialogOptions({ defaultPath: target, title: filename });
    } else {
      item.setSavePath(target);
    }
    let referrer = '';
    try {
      referrer = wc && !wc.isDestroyed() ? wc.getURL() : '';
    } catch {}
    const d = {
      id: randomUUID().slice(0, 8),
      url: item.getURL(),
      filename: path.basename(target),
      path: target,
      total: item.getTotalBytes(),
      received: 0,
      state: 'progressing',
      paused: false,
      dangerous: isDangerousFile(filename),
      start: Date.now(),
      speed: 0,
      incognito
    };
    this.live.set(d.id, { d, item, lastBytes: 0, lastT: Date.now() });

    item.on('updated', (_e, state) => {
      const sp = item.getSavePath();
      if (sp) {
        d.path = sp;
        d.filename = path.basename(sp);
        d.dangerous = isDangerousFile(d.filename);
      }
      d.total = item.getTotalBytes();
      d.received = item.getReceivedBytes();
      d.paused = item.isPaused();
      d.state = state === 'interrupted' ? 'interrupted-live' : 'progressing';
      this._changed();
    });
    item.once('done', (_e, state) => {
      const entry = this.live.get(d.id);
      this.live.delete(d.id);
      d.state = state; // completed | cancelled | interrupted
      d.received = item.getReceivedBytes();
      d.path = item.getSavePath() || d.path;
      d.filename = path.basename(d.path);
      d.dangerous = isDangerousFile(d.filename);
      if (state === 'completed') this._markOfTheWeb(d.path, d.url, referrer);
      if (!incognito && state !== 'cancelled') {
        this.items.unshift(this._persisted(d));
        this.items.splice(200);
        this.store.save();
      }
      if (entry && incognito && state !== 'cancelled') this.incognitoDone.unshift(this._persisted(d));
      this._changed(true);
      if (state === 'completed') this.ctl.toast(this.ctl.t('İndirme tamamlandı: {0}', d.filename), 'download');
    });
    this._changed(true);
    this.ctl.onDownloadStarted(d);
  }

  incognitoDone = [];

  _persisted(d) {
    const { id, url, filename, path: p, total, received, state, dangerous, start } = d;
    return { id, url, filename, path: p, total, received, state, dangerous, start };
  }

  _markOfTheWeb(file, url, referrer) {
    if (process.platform !== 'win32') return;
    try {
      const ads = `${file}:Zone.Identifier`;
      if (fs.existsSync(ads)) return;
      fs.writeFileSync(ads, zoneIdentifier(url, referrer));
    } catch {}
  }

  _changed(now = false) {
    if (now) {
      clearTimeout(this._tick);
      this._tick = null;
      return this.ctl.broadcastState();
    }
    if (this._tick) return;
    this._tick = setTimeout(() => {
      this._tick = null;
      for (const l of this.live.values()) {
        const t = Date.now();
        const dt = (t - l.lastT) / 1000;
        if (dt > 0.2) {
          l.d.speed = Math.max(0, (l.d.received - l.lastBytes) / dt);
          l.lastBytes = l.d.received;
          l.lastT = t;
        }
      }
      this.ctl.broadcastState();
    }, 250);
  }

  summary(incognito) {
    const live = [...this.live.values()].map((l) => l.d).filter((d) => incognito || !d.incognito);
    const done = incognito ? [...this.incognitoDone, ...this.items] : this.items;
    const list = [...live, ...done].slice(0, 60).map((d) => ({
      id: d.id,
      filename: d.filename,
      url: d.url,
      total: d.total,
      received: d.received,
      state: d.state,
      paused: !!d.paused,
      dangerous: d.dangerous,
      speed: d.speed || 0,
      start: d.start,
      exists: d.state === 'completed' ? this._exists(d.path) : true
    }));
    let total = 0;
    let received = 0;
    for (const d of live) {
      total += d.total;
      received += d.received;
    }
    return { active: live.length, progress: total > 0 ? received / total : live.length ? -1 : 0, items: list };
  }

  _existsCache = new Map();

  _exists(p) {
    const c = this._existsCache.get(p);
    if (c && Date.now() - c.t < 5000) return c.v;
    const v = fs.existsSync(p);
    this._existsCache.set(p, { v, t: Date.now() });
    return v;
  }

  find(id) {
    const l = this.live.get(id);
    if (l) return { d: l.d, item: l.item };
    const d = this.items.find((x) => x.id === id) || this.incognitoDone.find((x) => x.id === id);
    return d ? { d, item: null } : null;
  }

  async action(id, op, parentWindow) {
    const f = this.find(id);
    if (!f) return;
    const { d, item } = f;
    switch (op) {
      case 'pause':
        if (item && !item.isPaused()) item.pause();
        break;
      case 'resume':
        if (item && item.canResume()) item.resume();
        break;
      case 'cancel':
        if (item) item.cancel();
        break;
      case 'open': {
        if (d.state !== 'completed' || !this._exists(d.path)) return;
        if (d.dangerous) {
          const r = await dialog.showMessageBox(parentWindow, {
            type: 'warning',
            buttons: [this.ctl.t('Yine de aç'), this.ctl.t('Vazgeç')],
            defaultId: 1,
            cancelId: 1,
            title: 'Techin Browser',
            message: this.ctl.t('"{0}" bir program veya komut dosyası.', d.filename),
            detail: this.ctl.t('Bu tür dosyalar bilgisayarınıza zarar verebilir. Yalnızca kaynağına güveniyorsanız açın.')
          });
          if (r.response !== 0) return;
        }
        shell.openPath(d.path);
        break;
      }
      case 'show':
        if (this._exists(d.path)) shell.showItemInFolder(d.path);
        else shell.openPath(path.dirname(d.path));
        break;
      case 'remove': {
        if (item) return;
        for (const list of [this.items, this.incognitoDone]) {
          const i = list.indexOf(d);
          if (i >= 0) list.splice(i, 1);
        }
        this.store.save();
        break;
      }
      case 'retry':
        if (!item && d.url && this.ctl.lastWindow()) this.ctl.lastWindow().downloadURL(d.url);
        break;
      default:
        return;
    }
    this._changed(true);
  }

  clearFinished() {
    this.store.data.items = [];
    this.incognitoDone = [];
    this.store.save();
    this._changed(true);
  }
}

module.exports = { Downloads, sanitizeDownloads };
