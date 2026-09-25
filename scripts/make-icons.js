'use strict';
// Builds app icons from build/logo-source.png (run with: npm run icons).
// Crops the navy rounded square out of the white canvas, gives it clean
// anti-aliased transparent corners, and writes PNG + multi-size ICO files.
const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage } = require('electron');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'logo-source.png');

function run() {
  const img = nativeImage.createFromPath(SRC);
  if (img.isEmpty()) throw new Error('cannot read ' + SRC);
  const { width: W, height: H } = img.getSize();
  const buf = img.toBitmap(); // BGRA, premultiplied

  // Bounding box of the visible logo (the source already has transparent, oval corners).
  let x0 = W;
  let y0 = H;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (buf[(y * W + x) * 4 + 3] > 16) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  // Square canvas, logo centered and NOT stretched, with a little breathing room.
  const side = Math.round(Math.max(w, h) * 1.04);
  const ox = Math.floor((side - w) / 2);
  const oy = Math.floor((side - h) / 2);
  console.log('logo', w, 'x', h, '->', side);
  const out = Buffer.alloc(side * side * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y + y0) * W + (x + x0)) * 4;
      const di = ((y + oy) * side + (x + ox)) * 4;
      const a = buf[si + 3];
      if (a < 250) {
        // Anti-aliased outer edge: keep its shape, drop the light halo (navy, premultiplied).
        out[di] = Math.round((0x40 * a) / 255);
        out[di + 1] = Math.round((0x23 * a) / 255);
        out[di + 2] = Math.round((0x0b * a) / 255);
      } else {
        out[di] = buf[si];
        out[di + 1] = buf[si + 1];
        out[di + 2] = buf[si + 2];
      }
      out[di + 3] = a;
    }
  }
  const square = nativeImage.createFromBitmap(out, { width: side, height: side });
  const png = (size) => square.resize({ width: size, height: size, quality: 'best' }).toPNG();
  fs.mkdirSync(path.join(ROOT, 'src', 'ui', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'src', 'ui', 'assets', 'logo.png'), png(256));
  fs.writeFileSync(path.join(ROOT, 'src', 'ui', 'assets', 'icon.png'), png(256));
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), png(512));

  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const blobs = sizes.map(png);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(s >= 256 ? 0 : s, e);
    header.writeUInt8(s >= 256 ? 0 : s, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(blobs[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += blobs[i].length;
  });
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), Buffer.concat([header, ...blobs]));
  console.log('icons written');
}

app.whenReady().then(() => {
  try {
    run();
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.quit();
});
