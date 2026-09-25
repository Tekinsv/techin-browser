'use strict';
// Pure URL helpers (no Electron imports) so they can be unit-tested with node --test.
const { parse: parseDomain } = require('tldts');
const { pathToFileURL } = require('node:url');

const SEARCH_ENGINES = {
  google: {
    name: 'Google',
    url: 'https://www.google.com/search?q=%s',
    suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q=%s'
  },
  duckduckgo: {
    name: 'DuckDuckGo',
    url: 'https://duckduckgo.com/?q=%s',
    suggest: 'https://duckduckgo.com/ac/?type=list&q=%s'
  },
  bing: {
    name: 'Bing',
    url: 'https://www.bing.com/search?q=%s',
    suggest: 'https://api.bing.com/osjson.aspx?query=%s'
  },
  brave: {
    name: 'Brave Search',
    url: 'https://search.brave.com/search?q=%s',
    suggest: 'https://search.brave.com/api/suggest?q=%s'
  },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s', suggest: null },
  ecosia: {
    name: 'Ecosia',
    url: 'https://www.ecosia.org/search?q=%s',
    suggest: 'https://ac.ecosia.org/autocomplete?type=list&q=%s'
  },
  yandex: {
    name: 'Yandex',
    url: 'https://yandex.com.tr/search/?text=%s',
    suggest: 'https://suggest.yandex.com.tr/suggest-ff.cgi?part=%s'
  }
};

const MAX_URL_LENGTH = 16384;

function safeURL(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return !!m && m.slice(1).every((p) => Number(p) <= 255);
}

function isIpLiteral(host) {
  return isIPv4(host) || /^\[[0-9a-f:.]+\]$/i.test(host) || /^[0-9a-f]*:[0-9a-f:.]+$/i.test(host);
}

// Hosts that are only reachable inside the user's machine or network.
// They are never upgraded to HTTPS and default to http:// when typed.
function isLocalHost(host) {
  if (!host) return false;
  host = host.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/\.(local|lan|internal|intranet|home|corp|test|home\.arpa)$/.test(host)) return true;
  if (host === '[::1]' || host === '::1') return true;
  if (isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return !host.includes('.') && !host.startsWith('[');
}

function looksLikeHost(host) {
  if (!host || host.length > 253) return false;
  if (isLocalHost(host) || isIpLiteral(host)) return true;
  if (!/^[\p{L}\p{N}.-]+$/u.test(host) || host.startsWith('.') || host.includes('..')) return false;
  let ascii = host;
  try {
    ascii = new URL('http://' + host).hostname;
  } catch {
    return false;
  }
  const info = parseDomain(ascii, { allowPrivateDomains: true });
  return !!info.domain && (info.isIcann === true || info.isPrivate === true);
}

function buildSearchUrl(text, template) {
  const tpl = typeof template === 'string' && template.includes('%s') ? template : SEARCH_ENGINES.google.url;
  return tpl.replace('%s', encodeURIComponent(text));
}

/**
 * Turns whatever the user typed into the address bar into a URL.
 * Returns { url, search } or null for empty input. Never returns a URL with a
 * dangerous scheme (javascript:, data:, chrome:, ...) — those become searches.
 */
function normalizeInput(raw, searchTemplate) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const search = () => ({ url: buildSearchUrl(text, searchTemplate), search: true });

  if (text.length > MAX_URL_LENGTH) return search();

  // Windows paths: C:\folder\file.pdf
  if (/^[a-zA-Z]:[\\/]/.test(text)) {
    try {
      return { url: pathToFileURL(text).href, search: false };
    } catch {
      return search();
    }
  }

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s === 'http' || s === 'https' || s === 'file') {
      const u = safeURL(text);
      if (u && (s === 'file' || u.hostname)) return { url: u.href, search: false };
      return search();
    }
    if (s === 'view-source') {
      const inner = normalizeInput(text.slice(12), searchTemplate);
      if (inner && !inner.search && /^https?:/.test(inner.url)) return { url: 'view-source:' + inner.url, search: false };
      return search();
    }
    if (text.toLowerCase() === 'about:blank') return { url: 'about:blank', search: false };
    // "localhost:3000" or "example.com:8080/x" look like a scheme but are host:port.
    if (!/^[^:]+:\d{1,5}(?:[/?#]|$)/.test(text)) return search();
  }

  if (/\s/.test(text)) return search();

  const m = /^(\[[0-9a-f:.]+\]|[^/?#:@]+)(:\d{1,5})?([/?#].*)?$/i.exec(text);
  if (!m) return search();
  const host = m[1];
  if (!looksLikeHost(host)) return search();
  // A single word ("youtube", "hava") is a search, like in Chrome. Intranet names
  // only count as addresses with a port or path ("nas/", "router:8080").
  const singleLabel = !host.includes('.') && !host.startsWith('[');
  if (singleLabel && host.toLowerCase() !== 'localhost' && !m[2] && !m[3]) return search();
  const proto = isLocalHost(host) || isIpLiteral(host) ? 'http' : 'https';
  const u = safeURL(proto + '://' + text);
  return u ? { url: u.href, search: false } : search();
}

// Schemes a tab may show at top level.
function isNavigable(url) {
  const u = safeURL(url);
  if (!u) return false;
  if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:') return true;
  if (u.href === 'about:blank') return true;
  if (u.protocol === 'view-source:') return /^view-source:https?:\/\//i.test(u.href);
  return false;
}

// Schemes a web page may open in a new tab/popup via window.open or target=_blank.
function isOpenableFromPage(url) {
  const u = safeURL(url);
  if (!u) return false;
  // blob: lets sites open generated files (PDF previews, exports) in a new tab.
  return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'blob:' || u.href === 'about:blank';
}

function hostOf(url) {
  const u = safeURL(url);
  return u && (u.protocol === 'http:' || u.protocol === 'https:') ? u.hostname : '';
}

function originOf(url) {
  const u = safeURL(url);
  return u && (u.protocol === 'http:' || u.protocol === 'https:') ? u.origin : '';
}

function displayHost(url) {
  const u = safeURL(url);
  if (!u) return '';
  if (u.protocol === 'file:') return decodeURIComponent(u.pathname.split('/').pop() || u.pathname);
  if (u.protocol === 'view-source:') return 'view-source:' + displayHost(url.slice(12));
  if (u.href === 'about:blank') return '';
  return u.hostname.replace(/^www\./, '');
}

function securityState(url, { certError = false } = {}) {
  const u = safeURL(url);
  if (!u) return 'none';
  if (certError) return 'cert-error';
  if (u.protocol === 'https:') return 'secure';
  if (u.protocol === 'http:') return isLocalHost(u.hostname) ? 'local' : 'insecure';
  if (u.protocol === 'file:') return 'file';
  return 'none';
}

function parseSuggestResponse(json) {
  if (Array.isArray(json) && Array.isArray(json[1])) {
    return json[1].filter((s) => typeof s === 'string' && s.length < 200).slice(0, 6);
  }
  return [];
}

module.exports = {
  SEARCH_ENGINES,
  safeURL,
  isIPv4,
  isIpLiteral,
  isLocalHost,
  looksLikeHost,
  buildSearchUrl,
  normalizeInput,
  isNavigable,
  isOpenableFromPage,
  hostOf,
  originOf,
  displayHost,
  securityState,
  parseSuggestResponse
};
