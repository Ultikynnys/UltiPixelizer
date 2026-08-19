// Renders the app's brand wordmark (src/main.ts `.brand`) to a transparent PNG.
// Usage: node scripts/render-brand.mjs [out.png] [scale]
//
// Launches headless Chrome, loads a minimal page that reproduces the exact
// `.brand` markup + CSS from src/style.css, parameterized by the brand values
// in scripts/brand.json (single source of truth for mark colors/geometry),
// and captures the element's bounding box with a transparent background.
// Requires a system Chrome/Edge install.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, process.argv[2] ?? 'Assets/brand.png');
const SCALE = Number(process.argv[3] ?? 4);

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const CHROME = CANDIDATES.find((p) => existsSync(p));
const BRAND = JSON.parse(readFileSync(join(ROOT, 'scripts/brand.json'), 'utf8'));

const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Manrope:wght=${BRAND.fontWeight}&display=swap');
  html, body { margin: 0; background: transparent; }
  body { padding: 60px; }
  .brand {
    align-items: center;
    color: ${BRAND.paper};
    display: flex;
    font-size: ${BRAND.fontSize}px;
    font-weight: ${BRAND.fontWeight};
    gap: ${BRAND.wordGap}px;
    letter-spacing: -0.04em;
    text-decoration: none;
    width: fit-content;
    font-family: 'Manrope', system-ui, sans-serif;
  }
  .brand > span:nth-child(2) > span { color: ${BRAND.accent}; }
  .brand-mark { display: grid; grid-template-columns: repeat(2, ${BRAND.cell}px); gap: ${BRAND.gap}px; transform: rotate(${BRAND.rotate}deg); }
  .brand-mark i { background: ${BRAND.paper}; display: block; height: ${BRAND.cell}px; }
  .brand-mark i:last-child { background: ${BRAND.accent}; }
</style>
</head>
<body>
  <a class="brand" href="#" aria-label="UltiPixelizer home">
    <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <span>ULTI<span>PIXELIZER</span></span>
  </a>
</body>
</html>`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!CHROME) throw new Error('No Chrome/Edge executable found.');

  const tmp = mkdtempSync(join(tmpdir(), 'brand-'));
  writeFileSync(join(tmp, 'brand.html'), HTML);
  const port = 9400 + Math.floor(Math.random() * 400);

  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${join(tmp, 'profile')}`,
    '--window-size=960,320',
    '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i += 1) {
    await wait(250);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* not ready yet */ }
  }
  if (!wsUrl) {
    chrome.kill();
    rmSync(tmp, { recursive: true, force: true });
    throw new Error('Headless Chrome did not expose a debug target.');
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WebSocket error')); });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  try {
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await send('Page.enable');
    await send('Page.navigate', { url: 'file:///' + join(tmp, 'brand.html').replace(/\\/g, '/') });
    await wait(900);
    await send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true, returnByValue: true });

    const fontOk = await send('Runtime.evaluate', {
      expression: `document.fonts.check('${BRAND.fontWeight} ${BRAND.fontSize}px Manrope')`,
      returnByValue: true,
    });

    const rect = await send('Runtime.evaluate', {
      expression: `(() => {
        const b = document.querySelector('.brand').getBoundingClientRect();
        const m = document.querySelector('.brand-mark').getBoundingClientRect();
        const pad = 12;
        const x = Math.floor(Math.min(b.left, m.left) - pad);
        const y = Math.floor(Math.min(b.top, m.top) - pad);
        const right = Math.ceil(Math.max(b.right, m.right) + pad);
        const bottom = Math.ceil(Math.max(b.bottom, m.bottom) + pad);
        return { x, y, width: right - x, height: bottom - y };
      })()`,
      returnByValue: true,
    });
    const r = rect.result.value;

    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: SCALE },
    });

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log(`wrote ${OUT}`);
    console.log(`  css px ${r.width}x${r.height} @${SCALE}x -> ${r.width * SCALE}x${r.height * SCALE}`);
    console.log(`  Manrope loaded: ${fontOk.result.value}`);
  } finally {
    try { ws.close(); } catch { /* noop */ }
    chrome.kill();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* profile lock may outlive the process */ }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
