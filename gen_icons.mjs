// Render the Minus toolbar logo: a capital "M" in VT323, on a black rounded
// square. Blue = idle, Red = actively blocking on the page. Writes PNGs at the
// four toolbar sizes for each state into extension/icons/.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';

const woff2 = readFileSync(new URL('./extension/VT323.woff2', import.meta.url)).toString('base64');
const SIZES = [16, 32, 48, 128];
const COLORS = { blue: '#3b82f6', red: '#ef4444' };

const box = (id, size, color) => `
  <div id="${id}" style="width:${size}px;height:${size}px;background:#000;
       border-radius:${Math.round(size * 0.18)}px;display:flex;align-items:center;
       justify-content:center;overflow:hidden">
    <span style="font-family:VT323;font-size:${Math.round(size * 1.02)}px;line-height:1;
          color:${color};margin-top:${Math.round(size * 0.04)}px">M</span>
  </div>`;

let boxes = '';
for (const [name, color] of Object.entries(COLORS))
  for (const s of SIZES) boxes += box(`m-${name}-${s}`, s, color);

const html = `<!doctype html><html><head><style>
  @font-face { font-family:VT323; src:url(data:font/woff2;base64,${woff2}) format('woff2'); }
  body { margin:0; padding:20px; display:flex; flex-wrap:wrap; gap:20px; background:#888; }
</style></head><body>${boxes}
<script>document.fonts.ready.then(()=>document.body.setAttribute('data-fonts','ready'))<\/script>
</body></html>`;

const browser = await chromium.launch({ executablePath:
  '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux/chrome' });
const p = await browser.newPage({ deviceScaleFactor: 1 });
await p.setContent(html);
await p.waitForSelector('body[data-fonts="ready"]', { timeout: 5000 });

for (const name of Object.keys(COLORS))
  for (const s of SIZES) {
    const el = await p.$(`#m-${name}-${s}`);
    const buf = await el.screenshot({ omitBackground: false });
    const out = new URL(`./extension/icons/m-${name}-${s}.png`, import.meta.url);
    writeFileSync(out, buf);
    console.log(`wrote icons/m-${name}-${s}.png`);
  }

await browser.close();
