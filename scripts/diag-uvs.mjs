// Diagnostic: load the sample Book.fbx with three's FBXLoader and report the
// UV attribute bounds / orientation so wireframe-vs-image alignment can be
// checked against real data. Not part of the app or the build.
import { readFileSync } from 'node:fs';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

if (typeof globalThis.URL.createObjectURL !== 'function') {
  globalThis.URL.createObjectURL = () => 'blob:diag';
}

// three's ImageLoader (used for embedded FBX textures) needs a DOM `img`
// element factory; a never-decoding fake is enough — UVs parse fine either way.
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElementNS: () => ({
      style: {},
      setAttribute: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  };
}

const buffer = readFileSync('Example/Book.fbx').buffer.slice(
  readFileSync('Example/Book.fbx').byteOffset,
  readFileSync('Example/Book.fbx').byteOffset + readFileSync('Example/Book.fbx').byteLength,
);

const loader = new FBXLoader();
let scene;
try {
  scene = loader.parse(buffer, 'Example/');
} catch (error) {
  console.error('parse failed:', error);
  process.exit(1);
}

let meshCount = 0;
scene.traverse((child) => {
  if (!child.isMesh) return;
  meshCount += 1;
  const geo = child.geometry;
  const names = Object.keys(geo.attributes).filter((n) => /^uv\d*$/.test(n));
  for (const name of names) {
    const attr = geo.getAttribute(name);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    const bad = [];
    for (let i = 0; i < attr.count; i += 1) {
      const u = attr.getX(i);
      const v = attr.getY(i);
      if (!Number.isFinite(u) || !Number.isFinite(v)) bad.push(i);
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    console.log(`mesh ${meshCount} ${child.name || '(unnamed)'} attr ${name}: count=${attr.count} u=[${minU.toFixed(4)}, ${maxU.toFixed(4)}] v=[${minV.toFixed(4)}, ${maxV.toFixed(4)}] nonFinite=${bad.length}`);
    if (attr.count > 0) {
      console.log(`  first corner: (${attr.getX(0).toFixed(4)}, ${attr.getY(0).toFixed(4)})`);
    }
  }
});
console.log(`total meshes: ${meshCount}`);
