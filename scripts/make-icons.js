#!/usr/bin/env node
/**
 * Generate the tray and application icons.
 *
 * Kept as a script rather than committing only the binaries so the artwork is
 * reproducible and tweakable. Writes PNGs plus a multi-size .ico for the packaged exe.
 *
 *   node scripts/make-icons.js
 *
 * The glyph is three descending bars — the overlay's own "the row is the bar" identity,
 * in the same ember/gold it uses on screen. It reads at 16px, which is the only size
 * that really matters for a tray.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'src', 'assets');

/** [x, width, colour] per bar, in unit coordinates. Gold on top: that row is you. */
const BARS = [
  { y: 0.16, h: 0.18, x: 0.10, w: 0.80, rgb: [0xe6, 0xac, 0x45] },
  { y: 0.41, h: 0.18, x: 0.10, w: 0.56, rgb: [0xc2, 0x78, 0x2e] },
  { y: 0.66, h: 0.18, x: 0.10, w: 0.34, rgb: [0xc2, 0x78, 0x2e] },
];

/** Render the glyph at `size` px as raw RGBA. */
function render(size) {
  const px = Buffer.alloc(size * size * 4, 0);

  for (const bar of BARS) {
    // Round outward so a bar never vanishes at 16px.
    const y0 = Math.floor(bar.y * size);
    const y1 = Math.max(y0 + 1, Math.round((bar.y + bar.h) * size));
    const x0 = Math.floor(bar.x * size);
    const x1 = Math.max(x0 + 1, Math.round((bar.x + bar.w) * size));

    for (let y = y0; y < Math.min(y1, size); y++) {
      for (let x = x0; x < Math.min(x1, size); x++) {
        const i = (y * size + x) * 4;
        px[i] = bar.rgb[0];
        px[i + 1] = bar.rgb[1];
        px[i + 2] = bar.rgb[2];
        px[i + 3] = 0xff;
      }
    }
  }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

function toPng(size) {
  const px = render(size);
  // One filter byte (0 = none) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;     // bit depth
  ihdr[9] = 6;     // colour type: RGBA
  ihdr[10] = 0;    // deflate
  ihdr[11] = 0;    // adaptive filtering
  ihdr[12] = 0;    // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An .ico is just a directory of images; Vista+ accepts PNG-compressed entries. */
function toIco(sizes) {
  const pngs = sizes.map((s) => ({ size: s, data: toPng(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;       // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;                            // palette count
    e[3] = 0;                            // reserved
    e.writeUInt16LE(1, 4);               // colour planes
    e.writeUInt16LE(32, 6);              // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

fs.mkdirSync(OUT, { recursive: true });

for (const size of [16, 32, 256]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, toPng(size));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

const ico = path.join(OUT, 'icon.ico');
fs.writeFileSync(ico, toIco([16, 24, 32, 48, 64, 128, 256]));
console.log(`wrote ${path.relative(process.cwd(), ico)}`);
