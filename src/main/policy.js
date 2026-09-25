'use strict';
// Pure security/download policy helpers (unit-tested, no Electron imports).
const path = require('node:path');

// ---------------------------------------------------------------- permissions

// Harmless or required for normal browsing (DRM needs mediaKeySystem).
const ALWAYS_ALLOW = new Set([
  'fullscreen',
  'pointerLock',
  'keyboardLock',
  'clipboard-sanitized-write',
  'mediaKeySystem',
  'persistent-storage',
  'speaker-selection',
  'storage-access',
  'top-level-storage-access',
  'midi'
]);

// The user is asked, and the answer is remembered per origin.
const ASKABLE = new Set([
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'midiSysex',
  'clipboard-read',
  'idle-detection',
  'window-management'
]);

/**
 * Splits Electron's permission name into the names we store decisions under.
 * 'media' covers camera and microphone, which are remembered separately.
 */
function expandPermission(permission, details = {}) {
  if (permission === 'media') {
    const types = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    const out = [];
    if (types.includes('video')) out.push('camera');
    if (types.includes('audio')) out.push('microphone');
    return out.length ? out : ['camera', 'microphone'];
  }
  if (permission === 'window-placement') return ['window-management'];
  return [permission];
}

/** Returns 'allow' | 'deny' | 'ask' for one expanded permission. */
function decide(name, stored) {
  if (stored === 'allow') return 'allow';
  if (stored === 'deny') return 'deny';
  if (ALWAYS_ALLOW.has(name)) return 'allow';
  if (ASKABLE.has(name)) return 'ask';
  return 'deny'; // hid, serial, usb, bluetooth, unknown ...
}

/** Combines several decisions: any deny wins, then ask, else allow. */
function combine(decisions) {
  if (decisions.includes('deny')) return 'deny';
  if (decisions.includes('ask')) return 'ask';
  return 'allow';
}

// ---------------------------------------------------------------- downloads

const DANGEROUS_EXTENSIONS = new Set([
  'exe', 'msi', 'msix', 'msixbundle', 'msp', 'appx', 'appxbundle', 'appinstaller', 'bat', 'cmd', 'com', 'scr', 'pif',
  'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ws', 'hta', 'cpl', 'jar', 'lnk', 'reg', 'dll',
  'sys', 'drv', 'ocx', 'iso', 'img', 'vhd', 'vhdx', 'application', 'gadget', 'msc', 'inf', 'scf', 'url', 'xll',
  'docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'appref-ms', 'chm', 'diagcab', 'settingcontent-ms', 'library-ms',
  'search-ms', 'website', 'cab', 'xbap', 'vsix', 'mst', 'crx'
]);

const RESERVED_WIN_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function extensionOf(name) {
  const m = /\.([^.\\/]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

function isDangerousFile(name) {
  return DANGEROUS_EXTENSIONS.has(extensionOf(name));
}

function sanitizeFilename(name) {
  let n = String(name || '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*‪-‮⁦-⁩]/g, '_') // incl. bidi overrides (fake extensions)
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '');
  if (!n) n = 'download';
  if (RESERVED_WIN_NAMES.test(n)) n = '_' + n;
  if (n.length > 180) {
    const ext = extensionOf(n);
    const keep = ext && ext.length < 16 ? '.' + ext : '';
    n = n.slice(0, 180 - keep.length) + keep;
  }
  return n;
}

/** 'report.pdf' -> 'report (1).pdf' while exists(fullPath) is true. */
function uniquePath(dir, name, exists) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let candidate = path.join(dir, name);
  for (let i = 1; exists(candidate) && i < 10000; i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
  return candidate;
}

/** Contents of the NTFS Zone.Identifier stream ("Mark of the Web"). */
function zoneIdentifier(url, referrer) {
  const lines = ['[ZoneTransfer]', 'ZoneId=3'];
  const clean = (u) => (/^https?:\/\//i.test(u || '') ? String(u).replace(/[\r\n]/g, '').slice(0, 2000) : '');
  if (clean(referrer)) lines.push('ReferrerUrl=' + clean(referrer));
  lines.push('HostUrl=' + (clean(url) || 'about:internet'));
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- errors

function classifyLoadError(code) {
  if (code === -105 || code === -137) return 'dns';
  if (code === -106) return 'offline';
  if (code <= -200 && code >= -299) return 'cert';
  if (code === -20) return 'blocked';
  if (code === -310) return 'redirects';
  if (code === -6) return 'file';
  if ([-7, -21, -100, -101, -102, -104, -109, -118, -130, -324].includes(code)) return 'network';
  if (code === -107 || code === -113 || code === -117 || code === -141) return 'tls';
  return 'generic';
}

/** Parses a hosts-format blocklist ("0.0.0.0 bad.example") into a Set of hostnames. */
function parseHostsList(text) {
  const set = new Set();
  for (const line of String(text).split('\n')) {
    if (!line || line[0] === '#') continue;
    const parts = line.trim().split(/\s+/);
    const host = (parts.length > 1 ? parts[1] : parts[0]).toLowerCase();
    if (host && host !== '0.0.0.0' && host !== 'localhost' && /^[a-z0-9.-]+$/.test(host)) set.add(host);
  }
  return set;
}

module.exports = {
  parseHostsList,
  ALWAYS_ALLOW,
  ASKABLE,
  expandPermission,
  decide,
  combine,
  DANGEROUS_EXTENSIONS,
  extensionOf,
  isDangerousFile,
  sanitizeFilename,
  uniquePath,
  zoneIdentifier,
  classifyLoadError
};
