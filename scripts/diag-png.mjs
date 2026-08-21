// Diagnostic: decode the sample PNG (no deps), report alpha coverage.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function decodePng(path) {
  const data = readFileSync(path);
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8;
  let width = 0; let height = 0; let bitDepth = 0; let colorType = 0;
  const idat = [];
  while (pos < data.length) {
    const len = data.readUInt32BE(pos);
    const type = data.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') {
      width = data.readUInt32BE(pos + 8);
      height = data.readUInt32BE(pos + 12);
      bitDepth = data[pos + 16];
      colorType = data[pos + 17];
    } else if (type === 'IDAT') {
      idat.push(data.subarray(pos + 8, pos + 8 + len));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let src = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src]; src += 1;
    const line = raw.subarray(src, src + stride); src += stride;
    const recon = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? recon[x - channels] : 0;
      const up = prev[x];
      const ul = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += Math.floor((left + up) / 2);
      else if (filter === 4) v += paeth(left, up, ul);
      recon[x] = v & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (channels === 4) {
        out[o] = recon[x * 4]; out[o + 1] = recon[x * 4 + 1]; out[o + 2] = recon[x * 4 + 2]; out[o + 3] = recon[x * 4 + 3];
      } else if (channels === 3) {
        out[o] = recon[x * 3]; out[o + 1] = recon[x * 3 + 1]; out[o + 2] = recon[x * 3 + 2]; out[o + 3] = 255;
      }
    }
    prev.set(recon);
  }
  return { width, height, data: out };
}

const png = decodePng('Example/Book_BaseColor.png');
let transparent = 0;
let opaque = 0;
const rows = new Array(png.height).fill(0);
for (let y = 0; y < png.height; y += 1) {
  for (let x = 0; x < png.width; x += 1) {
    const a = png.data[(y * png.width + x) * 4 + 3];
    if (a < 250) { transparent += 1; rows[y] += 1; } else opaque += 1;
  }
}
console.log(`size: ${png.width}x${png.height} opaque: ${opaque} translucent/<250: ${transparent} (${(100 * transparent / (png.width * png.height)).toFixed(2)}%)`);
const band = Math.max(1, Math.floor(png.height / 16));
for (let i = 0; i < 16; i += 1) {
  const start = i * band;
  const end = Math.min(png.height, (i + 1) * band);
  let count = 0;
  for (let y = start; y < end; y += 1) count += rows[y];
  console.log(`rows ${start}-${end}: ${count} translucent`);
}
