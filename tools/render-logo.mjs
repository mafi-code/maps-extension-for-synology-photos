// Renders the SVG logo sources in assets/ to PNG (transparent background) with headless Edge.
// Usage: npm run logo
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, launchBrowser, sleep } from './harness.mjs';

const JOBS = [
  // [source svg, width, height, scale, output]
  ['assets/icon-small.svg', 16, 16, 1, 'icons/icon16.png'],
  ['assets/icon-small.svg', 32, 32, 1, 'icons/icon32.png'],
  ['assets/logo.svg', 48, 48, 1, 'icons/icon48.png'],
  ['assets/logo.svg', 128, 128, 1, 'icons/icon128.png'],
  ['assets/logo.svg', 512, 512, 1, 'docs/logo.png'],
  ['assets/banner.svg', 1200, 360, 2, 'docs/banner.png'],
  ['assets/banner-de.svg', 1200, 360, 2, 'docs/banner-de.png'],
];

const cdp = await launchBrowser({ port: 9466 });
try {
  for (const [src, width, height, scale, out] of JOBS) {
    const url = pathToFileURL(path.join(ROOT, src)).href;
    const session = await cdp.openPage(url, { width, height, scale });
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, session);
    await sleep(800); // fonts + embedded <image>
    const r = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width, height, scale: 1 },
    }, session);
    const file = path.join(ROOT, out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`  ${out}  ${width * scale}×${height * scale}  ${Math.round(fs.statSync(file).size / 1024)} KB`);
  }
} finally {
  await cdp.close();
}
