// Diagnostic: does the active-tab capture guard refuse the ACTIVE tab?
// Opens ONE ad-heavy site (definitely active), dwells, reads the background's
// capture ok/refused counters + sender.tab.active seen for refusals.
import { chromium } from "playwright";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "extension");
const GPU = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface", "--no-sandbox"];
const ctx = await chromium.launchPersistentContext(join(HERE, ".profile-probe"), {
  channel: "chromium", headless: false, viewport: { width: 1440, height: 900 },
  args: [...GPU, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 60000 });
await sw.evaluate((c) => chrome.storage.local.set(c), { enabled: true, blockDisplay: true, blockVideo: true, disabledSites: [] });
// wait for engine
for (let i = 0; i < 40; i++) {
  const st = await sw.evaluate(async () => { const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind: "lfm" }, res)); return r?.info?.state; }).catch(() => "?");
  if (st === "ready") { console.log("engine ready"); break; }
  await new Promise((r) => setTimeout(r, 3000));
}
const pg = await ctx.newPage();
await pg.goto("https://www.tomshardware.com/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await pg.bringToFront();
// what does the page see about its own visibility + what does chrome think is active?
await pg.waitForTimeout(40000);
const ov = await pg.evaluate(() => document.querySelectorAll("[data-minus-overlay]").length).catch(() => -1);
const hidden = await pg.evaluate(() => document.hidden).catch(() => "?");
const counters = await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  return {
    capOk: globalThis.__minusCapOk || 0,
    capRefused: globalThis.__minusCapRefused || 0,
    lastRefusedActive: globalThis.__minusLastRefusedActive,
    tabs: tabs.map((t) => ({ id: t.id, active: t.active, url: (t.url || "").slice(0, 40) })),
  };
});
console.log("overlays:", ov, "| page.document.hidden:", hidden);
console.log("capture OK:", counters.capOk, "| refused:", counters.capRefused, "| lastRefusedActive:", counters.lastRefusedActive);
console.log("tabs:", JSON.stringify(counters.tabs));
await ctx.close();
process.exit(0);
