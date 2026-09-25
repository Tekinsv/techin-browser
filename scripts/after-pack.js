'use strict';
// electron-builder afterPack hook: lock down the packaged executable with
// Electron fuses (can't be flipped back without re-signing the binary).
const path = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  const ext = { win32: '.exe', darwin: '.app', linux: '' }[context.electronPlatformName] ?? '';
  const exe = path.join(context.appOutDir, context.packager.appInfo.productFilename + ext);
  await flipFuses(exe, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: context.electronPlatformName === 'darwin',
    // The exe can't be abused as a generic Node.js runtime (ELECTRON_RUN_AS_NODE).
    [FuseV1Options.RunAsNode]: false,
    // Cookies on disk are encrypted with the OS key store (DPAPI on Windows).
    [FuseV1Options.EnableCookieEncryption]: true,
    // NODE_OPTIONS / --inspect can't inject code into the browser process.
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    // Only our packaged app.asar may be loaded, and it is integrity-checked.
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // file:// pages get exactly Chrome's (limited) privileges.
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
  });
  console.log('  • fuses flipped:', path.basename(exe));
};
