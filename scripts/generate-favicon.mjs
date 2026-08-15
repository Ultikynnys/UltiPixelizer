// Generates public/favicon.ico (32x32) from the app's brand mark.
// Usage: node scripts/generate-favicon.mjs
//
// The mark (src/style.css .brand-mark) is a 2x2 grid of 7px squares with 2px
// gaps, rotated 45deg: three squares in --paper (#f3f0e6), the last one in
// --accent (#ff5a36). This script rasterizes it with 4x supersampling, encodes
// a PNG via node:zlib, wraps it in an ICO, and self-validates the output.
import { deflateSync, inflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public');

const PAPER = [243, 240, 230]; // #f3f0e6
const ACCENT = [255, 90, 54]; // #ff5a36
const GRID = 16; // 7 + 2 + 7
const ROTATED_BBOX = GRID * Math.SQRT2; // 22.627...
const FILL = 0.8; // fraction of the canvas the diamond occupies
const SIZE = 32;

// ---- rasterizer ---------------------------------------------------------------
function render(size) {
  const s = (size * FILL) / ROTATED_BBOX;
  const c = Math.SQRT2 / 2;
  const SS = 4; // 4x4 supersampling
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i < SS; i++) {
        for (let j = 0; j < SS; j++) {
          const sx = x + (i + 0.5) / SS - size / 2;
          const sy = y + (j + 0.5) / SS - size / 2;
          // inverse transform: unscale, rotate -45deg, shift into brand grid
          const qx = sx / s, qy = sy / s;
          const gx = qx * c + qy * c + GRID / 2;
          const gy = -qx * c + qy * c + GRID / 2;
          let col = null;
          if (gx >= 0 && gx < 7) {
            if (gy >= 0 && gy < 7) col = PAPER; // top-left
            else if (gy >= 9 && gy < GRID) col = PAPER; // bottom-left
          } else if (gx >= 9 && gx < GRID) {
            if (gy >= 0 && gy < 7) col = PAPER; // top-right
            else if (gy >= 9 && gy < GRID) col = ACCENT; // bottom-right
          }
          if (col) { r += col[0]; g += col[1]; b += col[2]; a += 255; }
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        const n = SS * SS;
        rgba[o] = Math.round(r / n);
        rgba[o + 1] = Math.round(g / n);
        rgba[o + 2] = Math.round(b / n);
        rgba[o + 3] = Math.round(a / n);
      }
    }
  }
  return rgba;
}

// ---- PNG encoder (RGBA, 8-bit, no interlace) -----------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO wrapper (single 32x32 PNG entry) ---------------------------------------
function encodeIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count
  const entry = Buffer.alloc(16);
  entry[0] = size; // width (0 = 256)
  entry[1] = size; // height
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // offset: 6 (header) + 16 (entry)
  return Buffer.concat([header, entry, png]);
}

// ---- validation ------------------------------------------------------------------
function decodePng(buf) {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('bad PNG magic');
  let off = 8, width = 0, height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    if (crc !== crc32(buf.subarray(off + 4, off + 8 + len))) throw new Error(`bad CRC in ${type}`);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== height * (1 + width * 4)) throw new Error('decompressed size mismatch');
  return { width, height, raw };
}

const rgba = render(SIZE);
const png = encodePng(rgba, SIZE);
const ico = encodeIco(png, SIZE);
const { width, height, raw } = decodePng(png);

// spot checks: center sits in the gap between squares; bottom-right square is accent;
// top-left area is paper; some edge pixels are anti-aliased.
const px = (x, y) => {
  const o = y * (1 + SIZE * 4) + 1 + x * 4;
  return [raw[o], raw[o + 1], raw[o + 2], raw[o + 3]];
};
const [cr, cg, cb, ca] = px(16, 16);
if (ca !== 0) throw new Error(`expected transparent center, got ${cr},${cg},${cb},${ca}`);
const [ar, ag, ab] = px(16, 23); // bottom-right (accent) square center
if (!(ar > 200 && ag < 150 && ab < 120)) throw new Error(`expected accent bottom-right, got ${ar},${ag},${ab}`);
const [pr, pg, pb] = px(9, 16); // bottom-left (paper) square center
if (!(pr > 220 && pg > 220 && pb > 200)) throw new Error(`expected paper left, got ${pr},${pg},${pb}`);
let covered = 0, aa = 0;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const a = raw[y * (1 + SIZE * 4) + 1 + x * 4 + 3];
    if (a > 0) covered++;
    if (a > 0 && a < 255) aa++;
  }
}
if (covered < SIZE * SIZE * 0.1 || covered > SIZE * SIZE * 0.4) {
  throw new Error(`coverage out of range: ${covered}/${SIZE * SIZE}`);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'favicon.ico'), ico);
console.log(`wrote public/favicon.ico (${ico.length} bytes)`);
console.log(`  decoded OK: ${width}x${height}, ${covered} px covered (${aa} anti-aliased)`);
