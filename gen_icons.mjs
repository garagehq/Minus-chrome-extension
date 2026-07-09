// Render the Minus toolbar logo: a capital "M" in VT323 on a TRANSPARENT
// background (blue = idle, red = actively blocking). Writes PNGs at the four
// toolbar sizes for each state into extension/icons/.
//
// NB: we FORCE the font to load (document.fonts.load) and assert it before
// screenshotting — otherwise the render silently falls back to a serif face.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';

const woff2 = readFileSync(new URL('./extension/VT323.ttf', import.meta.url)).toString('base64');
const SIZES = [16, 32, 48, 128];
const COLORS = { blue: '#3b82f6', red: '#ef4444' };

const box = (id, size, color) => `
  <div id="${id}" style="width:${size}px;height:${size}px;background:transparent;
       display:flex;align-items:center;justify-content:center;overflow:hidden">
    <span style="font-family:'VT323',monospace;font-size:${Math.round(size * 1.18)}px;line-height:1;
          color:${color};margin-top:${Math.round(size * 0.02)}px">M</span>
  </div>`;

let boxes = '';
for (const [name, color] of Object.entries(COLORS))
  for (const s of SIZES) boxes += box(`m-${name}-${s}`, s, color);

const html = `<!doctype html><html><head><style>
  @font-face { font-family:'VT323'; src:url(data:font/ttf;base64,${woff2}) format('truetype'); }
  html,body { margin:0; background:transparent; }
  #sample { font-family:'VT323',monospace; font-size:80px; color:#111; background:#fff; padding:10px 20px; }
</style></head><body>
  <div id="sample">VT323 Mm 0123</div>
  ${boxes}
</body></html>`;

const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--no-sandbox'] });
const p = await browser.newPage({ deviceScaleFactor: 1 });
await p.setContent(html);
// Force the font to actually load, then verify — fail loud if it didn't.
await p.evaluate(() => document.fonts.load("80px 'VT323'"));
const loaded = await p.evaluate(() => document.fonts.check("80px 'VT323'"));
if (!loaded) { console.error('VT323 did NOT load — aborting'); await browser.close(); process.exit(1); }
console.log('VT323 loaded:', loaded);

// authenticity sample for eyeballing
await (await p.$('#sample')).screenshot({ path: '/tmp/claude-1000/-home-ubuntu-training/1c6c42b9-d31d-4774-b29a-6c90dadcad3b/scratchpad/_vt323_sample.png' });

for (const name of Object.keys(COLORS))
  for (const s of SIZES) {
    const el = await p.$(`#m-${name}-${s}`);
    const buf = await el.screenshot({ omitBackground: true }); // transparent background
    writeFileSync(new URL(`./extension/icons/m-${name}-${s}.png`, import.meta.url), buf);
    console.log(`wrote icons/m-${name}-${s}.png`);
  }

await browser.close();
