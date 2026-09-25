'use strict';
// Settings schema: every value coming from disk or from the UI passes through
// sanitizeSettings(), so a corrupt file or a bad IPC call can't inject junk.
const { SEARCH_ENGINES } = require('./url');

const SCHEMA = {
  language: { type: 'enum', values: ['auto', 'tr', 'en'], def: 'auto' },
  theme: { type: 'enum', values: ['system', 'light', 'dark'], def: 'system' },
  material: { type: 'enum', values: ['gradient', 'mica'], def: 'gradient' },
  sidebarSide: { type: 'enum', values: ['left', 'right'], def: 'left' },
  sidebarWidth: { type: 'int', min: 180, max: 420, def: 240 },
  sidebarHidden: { type: 'bool', def: false },
  sidebarCompact: { type: 'bool', def: false },
  contentGap: { type: 'int', min: 0, max: 16, def: 8 },
  cornerRadius: { type: 'int', min: 0, max: 18, def: 10 },
  uiScale: { type: 'enum', values: ['small', 'normal', 'large'], def: 'normal' },
  searchEngine: { type: 'enum', values: [...Object.keys(SEARCH_ENGINES), 'custom'], def: 'google' },
  customSearchUrl: { type: 'string', max: 500, def: '', test: (v) => v === '' || (/^https:\/\/.+%s/.test(v)) },
  searchSuggestions: { type: 'bool', def: true },
  startup: { type: 'enum', values: ['restore', 'fresh'], def: 'restore' },
  adblock: { type: 'bool', def: true },
  adblockLevel: { type: 'enum', values: ['standard', 'strict'], def: 'standard' },
  adblockAllowlist: { type: 'hosts', def: [] },
  malwareProtection: { type: 'bool', def: true },
  httpsOnly: { type: 'bool', def: true },
  gpc: { type: 'bool', def: true },
  clearOnExit: { type: 'bool', def: false },
  tabSleepMinutes: { type: 'enum', values: [0, 5, 15, 30, 60, 120], def: 15 },
  memorySaver: { type: 'bool', def: true },
  smoothScroll: { type: 'enum', values: ['fluid', 'standard', 'off'], def: 'fluid' },
  gpuRaster: { type: 'bool', def: true },
  autoArchiveHours: { type: 'enum', values: [0, 12, 24, 168], def: 0 },
  downloadDir: { type: 'string', max: 1000, def: '' },
  askDownload: { type: 'bool', def: false },
  spellcheck: { type: 'bool', def: true },
  showHoverUrl: { type: 'bool', def: true },
  onboarded: { type: 'bool', def: false }
};

// Changing these only takes effect after a restart (Chromium command-line switches).
const RESTART_KEYS = new Set(['smoothScroll', 'gpuRaster', 'memorySaver']);

function sanitizeValue(spec, value) {
  switch (spec.type) {
    case 'enum':
      return spec.values.includes(value) ? value : undefined;
    case 'bool':
      return typeof value === 'boolean' ? value : undefined;
    case 'int': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      return Math.min(spec.max, Math.max(spec.min, Math.round(value)));
    }
    case 'string': {
      if (typeof value !== 'string' || value.length > spec.max) return undefined;
      if (spec.test && !spec.test(value)) return undefined;
      return value;
    }
    case 'hosts': {
      if (!Array.isArray(value)) return undefined;
      const out = [];
      for (const h of value) {
        if (typeof h === 'string' && /^[a-z0-9.-]{1,253}$/i.test(h) && !out.includes(h.toLowerCase())) {
          out.push(h.toLowerCase());
        }
        if (out.length >= 2000) break;
      }
      return out;
    }
    default:
      return undefined;
  }
}

function defaults() {
  const out = {};
  for (const [k, spec] of Object.entries(SCHEMA)) out[k] = Array.isArray(spec.def) ? [...spec.def] : spec.def;
  return out;
}

function sanitizeSettings(obj) {
  const out = defaults();
  if (obj && typeof obj === 'object') {
    for (const [k, spec] of Object.entries(SCHEMA)) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      const v = sanitizeValue(spec, obj[k]);
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

/** Validates one key/value change from the UI. Returns the clean value or undefined. */
function sanitizeChange(key, value) {
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(SCHEMA, key)) return undefined;
  return sanitizeValue(SCHEMA[key], value);
}

module.exports = { SCHEMA, RESTART_KEYS, defaults, sanitizeSettings, sanitizeChange };
