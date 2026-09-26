'use strict';
// electron-builder afterSign hook: optional Widevine VMP signing (castlabs EVS).
// Netflix, Disney+ and similar services only hand out licenses to browsers
// with a *production* VMP signature. Set TECHIN_VMP_SIGN=1 after creating a
// free castlabs EVS account (see KURULUM.md) to sign during `npm run dist`.
// On Windows VMP signing must come AFTER code signing, hence afterSign.
// PYTHON may point at the interpreter that has castlabs-evs installed.
const { execFileSync } = require('node:child_process');

exports.default = async function afterSign(context) {
  if (!process.env.TECHIN_VMP_SIGN) {
    console.log('  • VMP signing skipped (set TECHIN_VMP_SIGN=1 to enable)');
    return;
  }
  const python = process.env.PYTHON || 'python';
  execFileSync(python, ['-m', 'castlabs_evs.vmp', 'sign-pkg', context.appOutDir], { stdio: 'inherit' });
  // Throws when the signature isn't valid, so a release never ships unsigned.
  execFileSync(python, ['-m', 'castlabs_evs.vmp', 'verify-pkg', context.appOutDir], { stdio: 'inherit' });
  console.log('  • VMP signed and verified:', context.appOutDir);
};
