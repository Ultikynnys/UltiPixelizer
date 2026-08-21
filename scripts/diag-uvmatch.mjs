// Diagnostic: does the Book FBX's UV layout match the texture's opaque region?
// Rasterizes the model's UV triangles at 512x512 using the tool's exact
// mapping (x = u*W, y = (1-v)*H) and compares the coverage mask against the
// texture's opaque pixels, with and without the V flip. Higher agreement
// identifies the orientation the wireframe/bake should use.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

if (typeof globalThis.URL.createObjectURL !== 'function') {
  globalThis.URL.createObjectURL = () => 'blob:diag';
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElementNS: () => ({ style: {}, setAttribute: () => {}, addEventListener: () => {}, removeEventListener: () => {} }),
  };
}

// ---- decode the base color PNG -------------------------------------------
function decodePng(path) {
  const data = readFileSync(path);
  let pos = 8;
  let width = 0; let height = 0; let colorType = 0;
  const idat = [];
  while (pos < data.length) {
    const len = data.readUInt32BE(pos);
    const type = data.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') { width = data.readUInt32BE(pos + 8); height = data.readUInt32BE(pos + 12); colorType = data[pos + 17]; }
    else if (type === 'IDAT') idat.push(data.subarray(pos + 8, pos + 8 + len));
    else if (type === 'IEND') break;
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
      if (channels === 4) { out[o] = recon[x * 4]; out[o + 1] = recon[x * 4 + 1]; out[o + 2] = recon[x * 4 + 2]; out[o + 3] = recon[x * 4 + 3]; }
      else if (channels === 3) { out[o] = recon[x * 3]; out[o + 1] = recon[x * 3 + 1]; out[o + 2] = recon[x * 3 + 2]; out[o + 3] = 255; }
    }
    prev.set(recon);
  }
  return { width, height, data: out };
}

// ---- load the FBX, collect the active LOD's triangles --------------------
const file = readFileSync('Example/Book.fbx');
const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
const scene = new FBXLoader().parse(buffer, 'Example/');
const triangles = [];
scene.traverse((child) => {
  if (!child.isMesh || !child.visible) return;
  const geo = child.geometry;
  const uv = geo.getAttribute('uv');
  if (!uv) return;
  const index = geo.getIndex();
  const pos = geo.getAttribute('position');
  for (let tri = 0; tri < pos.count / 3; tri += 1) {
    const [ia, ib, ic] = index
      ? [index.getX(tri * 3), index.getX(tri * 3 + 1), index.getX(tri * 3 + 2)]
      : [tri * 3, tri * 3 + 1, tri * 3 + 2];
    triangles.push([
      [uv.getX(ia), uv.getY(ia)],
      [uv.getX(ib), uv.getY(ib)],
      [uv.getX(ic), uv.getY(ic)],
    ]);
  }
});
console.log(`triangles: ${triangles.length}`);

// ---- rasterize coverage with a V orientation -----------------------------
function coverage(flipV, size) {
  const mask = new Uint8Array(size * size);
  const box = { minX: 0, minY: 0, maxX: size, maxY: size };
  const raster = (a, b, c) => {
    // edge functions in texel space
    const [ax, ay] = [(a[0]) * size, (flipV ? 1 - a[1] : a[1]) * size];
    const [bx, by] = [(b[0]) * size, (flipV ? 1 - b[1] : b[1]) * size];
    const [cx, cy] = [(c[0]) * size, (flipV ? 1 - c[1] : c[1]) * size];
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)));
    const det = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (det === 0) return;
    for (let y = minY; y <= maxY; y += 1) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / det;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / det;
        const w2 = 1 - w0 - w1;
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) mask[y * size + x] = 1;
      }
    }
  };
  for (const [a, b, c] of triangles) raster(a, b, c);
  return mask;
}

// ---- compare against the texture's opaque mask ---------------------------
const png = decodePng('Example/Book_BaseColor.png');
const size = 512;
const opaque = new Uint8Array(size * size);
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    opaque[y * size + x] = png.data[(y * size + x) * 4 + 3] >= 250 ? 1 : 0;
  }
}

for (const flipV of [true, false]) {
  const mask = coverage(flipV, size);
  let tp = 0, fp = 0, fn = 0;
  let opaqueCount = 0;
  for (let i = 0; i < size * size; i += 1) {
    if (opaque[i]) { opaqueCount += 1; if (mask[i]) tp += 1; else fn += 1; }
    else if (mask[i]) fp += 1;
  }
  const maskCount = tp + fp;
  console.log(`flipV=${flipV}: opaque=${opaqueCount} mask=${maskCount} overlap(tp)=${tp} recall=${(100 * tp / opaqueCount).toFixed(2)}% precision=${(100 * tp / maskCount).toFixed(2)}%`);
}
