'use strict';
// Session hardening: permissions, device pickers, request pipeline
// (malware block -> HTTPS upgrade -> ad/tracker block -> GPC header),
// certificate errors and HTTP auth.
const { app, webContents: WebContents } = require('electron');
const { expandPermission, decide, combine } = require('./policy');
const { safeURL, isLocalHost, isIpLiteral, hostOf, originOf } = require('./url');

const FIREFOX_VERSION = Math.max(140, Number(String(process.versions.chrome || '152').split('.')[0]));
const SIGNIN_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${FIREFOX_VERSION}.0) Gecko/20100101 Firefox/${FIREFOX_VERSION}.0`;

/** Google account sign-in pages (where embedded Chromium browsers are refused). */
function isGoogleSignIn(url) {
  const host = hostOf(url);
  return host === 'accounts.google.com' || host === 'accounts.youtube.com' || /^accounts\.google\.[a-z.]{2,6}$/.test(host);
}


function requestOrigin(url) {
  return originOf(url);
}

function installPermissionHandlers(ses, ctl, incognito) {
  ses.setPermissionRequestHandler((wc, permission, callback, details = {}) => {
    try {
      if (permission === 'openExternal') {
        return ctl.promptExternal(wc, details.externalURL, callback);
      }
      const origin = requestOrigin(details.requestingUrl || wc.getURL());
      const names = expandPermission(permission, details);
      const verdicts = names.map((n) => decide(n, origin ? ctl.getSitePermission(origin, n, incognito) : undefined));
      const verdict = combine(verdicts);
      if (verdict !== 'ask' || !origin) return callback(verdict === 'allow');
      const askFor = names.filter((_, i) => verdicts[i] === 'ask');
      ctl.promptPermission(wc, origin, askFor, incognito, callback);
    } catch (err) {
      console.error('[permissions]', err);
      callback(false);
    }
  });

  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details = {}) => {
    const origin = requestOrigin(requestingOrigin || details.requestingUrl || '');
    let names;
    if (permission === 'media') {
      if (details.mediaType === 'video') names = ['camera'];
      else if (details.mediaType === 'audio') names = ['microphone'];
      else return false;
    } else {
      names = expandPermission(permission, details);
    }
    return names.every((n) => decide(n, origin ? ctl.getSitePermission(origin, n, incognito) : undefined) === 'allow');
  });

  // WebHID / WebSerial / WebUSB device pickers are not offered: always cancel
  // instead of Electron's default of silently picking the first device.
  ses.setDevicePermissionHandler(() => false);
  ses.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault();
    callback(null);
  });
  ses.on('select-serial-port', (event, _ports, _wc, callback) => {
    event.preventDefault();
    callback('');
  });
  ses.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });

  ses.setDisplayMediaRequestHandler((request, callback) => {
    let wc = null;
    try {
      wc = request.frame ? WebContents.fromFrame(request.frame) : null;
    } catch {}
    if (!wc) return callback({});
    ctl.promptScreenShare(wc, request, callback);
  });
}

function installRequestPipeline(ses, ctl) {
  const protection = ctl.protection;

  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    try {
      const s = ctl.settings.data;
      // The GrantFileProtocolExtraPrivileges fuse has to stay on (castlabs only
      // VMP-signs a fixed fuse set, and Netflix needs that signature). It would
      // let a local HTML file fetch() other local files; Chrome doesn't allow
      // that, so neither do we. Plain subresources (images, scripts) still load.
      if (details.resourceType === 'xhr' && details.url.startsWith('file:')) {
        let from = details.referrer || '';
        try {
          from = (details.frame && details.frame.url) || from;
        } catch {}
        if (!from || from.startsWith('file:')) return callback({ cancel: true });
      }
      if (details.resourceType === 'mainFrame') {
        const u = safeURL(details.url);
        if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return callback({});
        const host = u.hostname;
        if (s.malwareProtection && !ctl.bypass.threat.has(host)) {
          const verdict = protection.checkHost(host);
          if (verdict) {
            ctl.noteBlockedMain(details.webContentsId, { kind: verdict, url: details.url });
            return callback({ cancel: true });
          }
        }
        if (s.httpsOnly && u.protocol === 'http:' && !isLocalHost(host) && !isIpLiteral(host) && !ctl.bypass.http.has(host)) {
          if (ctl.noteUpgrade(details.webContentsId, host)) {
            u.protocol = 'https:';
            if (u.port === '80') u.port = '';
            return callback({ redirectURL: u.href });
          }
        }
        return callback({});
      }
      if (!s.adblock || !protection.blocker) return callback({});
      const tab = ctl.tabByWcId(details.webContentsId);
      if (tab && protection.isAllowlisted(tab.url)) return callback({});
      const res = protection.matchRequest(details);
      if (res) {
        if (tab) tab.onRequestBlocked();
        return callback(res);
      }
      callback({});
    } catch {
      callback({});
    }
  });

  // Only documents need response-header work (adblock CSP rules); subresources skip the main thread.
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'], types: ['mainFrame', 'subFrame'] }, (details, callback) => {
    try {
      const s = ctl.settings.data;
      if (!s.adblock || !protection.blocker) return callback({});
      if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') return callback({});
      const tab = ctl.tabByWcId(details.webContentsId);
      if (protection.isAllowlisted(tab ? tab.url : details.url)) return callback({});
      protection.onHeadersReceived(details, callback);
    } catch {
      callback({});
    }
  });

  // Documents (GPC) and XHR/fetch (Google sign-in) only; images, scripts etc. skip the main thread.
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'], types: ['mainFrame', 'subFrame', 'xhr'] }, (details, callback) => {
    const signin = isGoogleSignIn(details.url);
    const gpc = ctl.settings.data.gpc && details.resourceType !== 'xhr';
    if (!gpc && !signin) return callback({});
    const requestHeaders = { ...details.requestHeaders };
    if (gpc) requestHeaders['Sec-GPC'] = '1';
    if (signin) {
      // Google blocks sign-in from Chromium-based embedded browsers; on its
      // sign-in pages only, we present ourselves as Firefox (like Min Browser).
      for (const k of Object.keys(requestHeaders)) {
        if (/^user-agent$/i.test(k) || /^sec-ch-ua/i.test(k)) delete requestHeaders[k];
      }
      requestHeaders['User-Agent'] = SIGNIN_USER_AGENT;
    }
    callback({ requestHeaders });
  });
}

function hardenSession(ses, ctl, { incognito = false } = {}) {
  ses.setUserAgent(ctl.userAgent, ctl.acceptLanguages);
  installPermissionHandlers(ses, ctl, incognito);
  installRequestPipeline(ses, ctl);
  ctl.protection.attachSession(ses);
  ses.registerPreloadScript({ type: 'frame', filePath: require('node:path').join(__dirname, '..', 'preload', 'page.js') });
  ctl.downloads.attach(ses, incognito);
  try {
    ses.setSSLConfig({ minVersion: 'tls1.2' });
  } catch {}
  ses.setSpellCheckerEnabled(ctl.settings.data.spellcheck);

}

function installAppSecurity(ctl) {
  app.on('web-contents-created', (_event, wc) => {
    // No <webview> anywhere, and no unexpected navigation for our own UI.
    wc.on('will-attach-webview', (e) => e.preventDefault());
  });

  app.on('certificate-error', (event, wc, url, error, certificate, callback, isMainFrame) => {
    const host = hostOf(url);
    const allowed = ctl.bypass.cert.get(host);
    if (allowed && allowed === certificate.fingerprint) {
      event.preventDefault();
      return callback(true);
    }
    if (isMainFrame !== false && wc) {
      ctl.noteCertError(wc.id, {
        host,
        error,
        fingerprint: certificate.fingerprint,
        issuer: certificate.issuerName,
        subject: certificate.subjectName,
        validExpiry: certificate.validExpiry
      });
    }
    callback(false);
  });

  app.on('login', (event, wc, details, authInfo, callback) => {
    event.preventDefault();
    if (!wc) return callback();
    ctl.promptLogin(wc, details, authInfo, callback);
  });

  app.on('select-client-certificate', (event, _wc, _url, list, callback) => {
    // Let Chromium's default handle it only when there's exactly one choice.
    if (list.length !== 1) {
      event.preventDefault();
      callback();
    }
  });
}

module.exports = { hardenSession, installAppSecurity, isGoogleSignIn, SIGNIN_USER_AGENT };
