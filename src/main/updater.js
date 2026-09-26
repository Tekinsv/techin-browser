'use strict';
// Auto-update from GitHub Releases (electron-updater). Nothing is downloaded
// or installed without the user's click: check -> "Güncelleme var" -> İndir ->
// "Yeniden başlat ve güncelle" (or it installs quietly when the browser quits).
const { app } = require('electron');

const CHECK_EVERY = 6 * 3600 * 1000;

function plainNotes(notes) {
  let text = '';
  if (Array.isArray(notes)) text = notes.map((n) => n && n.note).filter(Boolean).join('\n');
  else if (typeof notes === 'string') text = notes;
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 2000);
}

class Updater {
  constructor(ctl) {
    this.ctl = ctl;
    this.state = { status: 'idle', version: null, notes: '', percent: 0, error: null, checkedAt: 0, current: app.getVersion() };
    this.promptedFor = null;
    this.au = null;
  }

  init() {
    // Selftest may point the updater at a local test server (never in normal use).
    const testFeed = process.argv.includes('--selftest') ? process.env.TECHIN_UPDATE_URL : null;
    if (!app.isPackaged && !testFeed) {
      this.state.status = 'unsupported';
      return;
    }
    if (!this._setup()) return;
    const au = this.au;
    if (testFeed) this.useTestFeed(testFeed);
    setTimeout(() => this.check(false), 8000).unref?.();
    setInterval(() => this.check(false), CHECK_EVERY).unref?.();
  }

  /** Self test only: point at a local feed and never auto-install on quit. */
  useTestFeed(url) {
    if (!this.au && !this._setup()) return;
    this.au.forceDevUpdateConfig = true;
    this.au.autoInstallOnAppQuit = false;
    this.testFeed = true;
    this.au.setFeedURL({ provider: 'generic', url });
    this.state = { ...this.state, status: 'idle', version: null, error: null };
  }

  _setup() {
    try {
      this.au = require('electron-updater').autoUpdater;
    } catch (err) {
      this.state = { ...this.state, status: 'unsupported', error: err.message };
      return false;
    }
    const au = this.au;
    au.autoDownload = false;
    au.autoInstallOnAppQuit = true;
    au.allowPrerelease = false;
    au.logger = null;
    au.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    au.on('update-not-available', () => this.set({ status: 'none', checkedAt: Date.now() }));
    au.on('update-available', (info) => {
      this.set({ status: 'available', version: info.version, notes: plainNotes(info.releaseNotes), checkedAt: Date.now() });
      this.promptOnce();
    });
    au.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.floor(p.percent || 0))) }));
    au.on('update-downloaded', (info) => {
      this.set({ status: 'ready', version: info.version || this.state.version, percent: 100 });
      // The user already said "Güncelle": install and reopen right away, no second click.
      if (this.installWhenReady && !this.testFeed) {
        this.ctl.toast(this.ctl.t('Güncelleme kuruluyor, tarayıcı yeniden açılacak…'), 'download');
        return setTimeout(() => this.install(), 1200);
      }
      this.ctl.toast(this.ctl.t('Güncelleme hazır — yeniden başlatınca kurulacak'), 'download');
    });
    au.on('error', (err) => {
      const was = this.state.status;
      // A failed background check stays quiet; a failed download is reported.
      this.set({ status: was === 'downloading' ? 'error' : this.state.version ? 'available' : 'idle', error: String(err && err.message ? err.message : err).slice(0, 300) });
      if (was === 'downloading') this.ctl.toast(this.ctl.t('Güncelleme indirilemedi'), 'warn');
    });
    return true;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.ctl.broadcastState();
  }

  async check(manual) {
    if (!this.au) {
      if (manual) this.ctl.toast(this.ctl.t('Güncelleme yalnızca kurulu sürümde çalışır'), 'info');
      return;
    }
    if (['checking', 'downloading', 'ready'].includes(this.state.status)) return;
    this.manual = manual;
    try {
      await this.au.checkForUpdates();
      if (manual && this.state.status === 'none') this.ctl.toast(this.ctl.t('Techin Browser güncel'), 'check');
    } catch (err) {
      this.set({ status: this.state.version ? 'available' : 'idle', error: String(err.message || err).slice(0, 300) });
      if (manual) this.ctl.toast(this.ctl.t('Güncelleme denetlenemedi'), 'warn');
    }
  }

  /** Asks once per new version: "Yeni güncelleme var, indirmek ister misiniz?" */
  promptOnce() {
    if (this.promptedFor === this.state.version) return;
    this.promptedFor = this.state.version;
    const w = this.ctl.lastWindow();
    if (w && !w.modal) w.openModal({ type: 'update' });
  }

  async download({ install = true } = {}) {
    if (!this.au || this.state.status !== 'available') return;
    this.installWhenReady = install;
    this.set({ status: 'downloading', percent: 0, error: null });
    try {
      await this.au.downloadUpdate();
    } catch (err) {
      this.set({ status: 'error', error: String(err.message || err).slice(0, 300) });
    }
  }

  install() {
    if (!this.au || this.state.status !== 'ready' || this.testFeed) return;
    this.ctl.prepareForUpdate();
    // Silent (no installer window; keeps the install folder) and start the new version.
    setImmediate(() => this.au.quitAndInstall(true, true));
  }
}

module.exports = { Updater, plainNotes };
