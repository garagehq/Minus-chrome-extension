// Replicate Phase 3 exactly: 2 idle background tabs, then visit ad-heavy sites
// one at a time (open → bringToFront → 12s dwell → close), reading the
// background capOk/refused counters after each to see WHERE captures vanish.
import { chromium } from "playwright";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "extension");
const GPU = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface", "--no-sandbox"];
const ctx = await chromium.launchPersistentContext(join(HERE, ".profile-p3"), {
  channel: "chromium", headless: false, viewport: { width: 1440, height: 900 },
  args: [...GPU, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 60000 });
await sw.evaluate((c) => chrome.storage.local.set(c), { enabled: true, blockDisplay: true, blockVideo: true, disabledSites: [] });
for (let i = 0; i < 40; i++) {
  const st = await sw.evaluate(async () => { const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind: "lfm" }, res)); return r?.info?.state; }).catch(() => "?");
  if (st === "ready") { console.log("engine ready"); break; }
  await new Promise((r) => setTimeout(r, 3000));
}
const counters = () => sw.evaluate(() => ({ ok: globalThis.__minusCapOk || 0, refused: globalThis.__minusCapRefused || 0, cls: globalThis.__minusClsCalls || 0, imgs: globalThis.__minusClsImgs || 0, ads: globalThis.__minusAdsFound || 0, maxP: globalThis.__minusMaxP || 0, clsRef: globalThis.__minusClsRefused || 0 }));
// 2 idle background tabs (as Phase 3 holds open)
for (const u of ["https://en.wikipedia.org/wiki/Advertising", "https://www.google.com/"]) {
  const bg = await ctx.newPage(); await bg.goto(u, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
}
const sites = ["https://www.tomshardware.com/", "https://www.forbes.com/", "https://nypost.com/", "https://www.cnet.com/", "https://www.pcmag.com/"];
for (const url of sites) {
  const before = await counters();
  const pg = await ctx.newPage();
  await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await pg.bringToFront();
  const active = await sw.evaluate(async (u) => { const ts = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); return ts[0]?.url?.slice(0, 30); }, url).catch(() => "?");
  await pg.waitForTimeout(12000);
  const ov = await pg.evaluate(() => document.querySelectorAll("[data-minus-overlay]").length).catch(() => -1);
  const hidden = await pg.evaluate(() => document.hidden).catch(() => "?");
  const after = await counters();
  console.log(`${url.slice(8, 30).padEnd(22)} capOk+${after.ok - before.ok} clsCalls+${after.cls - before.cls} imgs+${after.imgs - before.imgs} ads+${after.ads - before.ads} maxP=${after.maxP.toFixed(2)} clsRef+${after.clsRef - before.clsRef} ov=${ov}`);
  await pg.close().catch(() => {});
}
await ctx.close();
process.exit(0);
