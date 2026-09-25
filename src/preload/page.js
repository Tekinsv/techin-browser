'use strict';
// Runs in every web page frame (sandboxed, isolated world). It only acts on
// Google's account sign-in pages, where Techin presents itself as Firefox:
// Firefox has no navigator.userAgentData, so hide Chromium's to stay consistent.
const { webFrame } = require('electron');

if (/^accounts\.(google|youtube)\.[a-z.]+$/.test(location.hostname)) {
  webFrame.executeJavaScript(
    'try { Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => undefined, configurable: true }); } catch (e) {}'
  );
}
