'use strict';
// Rebuilds the auto-update metadata for an installer that changed after
// electron-builder wrote it (e.g. it was code-signed afterwards). Writes
// <installer>.blockmap and latest.yml next to the installer, so installed
// copies verify the signed file instead of rejecting a checksum mismatch.
// Usage: node scripts/finalize-release.js dist/Techin-Browser-Setup-1.2.3.exe
const fs = require('node:fs');
const path = require('node:path');
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');

async function finalize(installer) {
  const file = path.resolve(installer);
  const name = path.basename(file);
  const m = /-(\d+\.\d+\.\d+)\.exe$/.exec(name);
  if (!m) throw new Error(`Not an installer name: ${name}`);
  const { size, sha512 } = await buildBlockMap(file, 'gzip', `${file}.blockmap`);
  const yml = [
    `version: ${m[1]}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    ''
  ].join('\n');
  fs.writeFileSync(path.join(path.dirname(file), 'latest.yml'), yml);
  return { version: m[1], size, sha512 };
}

if (require.main === module) {
  finalize(process.argv[2]).then(
    (r) => console.log(`latest.yml: ${r.version} (${r.size} bytes)`),
    (err) => {
      console.error(err.message);
      process.exit(1);
    }
  );
}

module.exports = { finalize };
