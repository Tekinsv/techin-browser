'use strict';
// Fetches favicons in a separate cookie-less session and turns them into small
// data: URLs, so the UI never loads remote content (strict CSP) and pinned
// sites keep their icons offline.
const { session, nativeImage } = require('electron');

const MAX_BYTES = 256 * 1024;
const RASTER = /^image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|bmp|avif)/;

class Favicons {
  constructor() {
    this.cache = new Map(); // url -> Promise<string|null>
    this.ses = null;
  }

  _session() {
    if (!this.ses) {
      this.ses = session.fromPartition('techin-favicons', { cache: true });
      this.ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    }
    return this.ses;
  }

  get(url) {
    if (typeof url !== 'string' || url.length > 8192) return Promise.resolve(null);
    if (url.startsWith('data:image/')) return Promise.resolve(url.length < 120000 && !url.startsWith('data:image/svg') ? url : this._svgData(url));
    if (!/^https?:\/\//.test(url)) return Promise.resolve(null);
    if (this.cache.has(url)) return this.cache.get(url);
    const p = this._fetch(url).catch(() => null);
    this.cache.set(url, p);
    if (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value);
    return p;
  }

  _svgData(url) {
    // SVG in <img> can't run scripts, but keep it small.
    return url.length < 60000 ? url : null;
  }

  async _fetch(url) {
    const res = await this._session().fetch(url, { signal: AbortSignal.timeout(8000), credentials: 'omit' });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    if (type.includes('svg') || /\.svg(\?|$)/i.test(url)) {
      return buf.length < 40000 ? 'data:image/svg+xml;base64,' + buf.toString('base64') : null;
    }
    let img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) {
      const { width } = img.getSize();
      if (width > 64) img = img.resize({ width: 64, quality: 'best' });
      return img.toDataURL();
    }
    if (RASTER.test(type)) return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`;
    return null;
  }
}

module.exports = { Favicons };
