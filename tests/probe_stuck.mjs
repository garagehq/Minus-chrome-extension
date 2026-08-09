// Focused diagnostic: for a few known-"stuck" YouTube IDs, poll the content
// script's data-minus-vdbg attribute continuously while the player is covered,
// so we can read the EXACT luma/std/pAd/unread the video sampler sees at each
// tick (the sampler's view, not Playwright's screenshot). This tells us whether
// a stuck cover is a screenshot-path letterbox (luma<46 should catch), a direct
// read of a dark content frame (luma>12 escapes), or a real long ad.
//   DISPLAY=:99 node tests/probe_stuck.mjs [id ...]
import { chromium } from "playwright";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "extension");
const IDS = process.argv.slice(2).length ? process.argv.slice(2) : ["dQw4w9WgXcQ", "hTWKbfoikeg", "xz-ZVxRqWlc"];
const GPU = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface", "--no-sandbox", "--autoplay-policy=no-user-gesture-required"];
const log = (m) => console.log(m);

let ctx, ready = false;
async function engineState() {
  const s = ctx.serviceWorkers()[0]; if (!s) return "no-sw";
  return Promise.race([
    s.evaluate(async () => { const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind: "lfm" }, res)); return r?.info?.state || "?"; }).catch(() => "err"),
    new Promise((r) => setTimeout(() => r("timeout"), 8000)),
  ]);
}
for (let a = 1; a <= 4 && !ready; a++) {
  ctx = await chromium.launchPersistentContext(join(HERE, ".profile-probe"), {
    channel: "chromium", headless: false, viewport: { width: 1440, height: 900 },
    args: [...GPU, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 60000 });
  await sw.evaluate((c) => chrome.storage.local.set(c), { enabled: true, blockVideo: true, blockDisplay: true, disabledSites: [], pausedUntil: 0 });
  const t0 = Date.now(); let st = "";
  while (Date.now() - t0 < 100000) { st = await engineState(); if (st === "ready") { ready = true; break; } if (st === "error") break; await new Promise((r) => setTimeout(r, 3000)); }
  log(`launch ${a}: engine ${st}`);
  if (!ready) { await ctx.close().catch(() => {}); await new Promise((r) => setTimeout(r, 2000)); }
}
if (!ready) { log("engine never ready"); await ctx?.close().catch(() => {}); process.exit(1); }

const playerCovered = (pg) => pg.evaluate(() => {
  const v = document.querySelector("video"); const vr = v && v.getBoundingClientRect();
  if (!vr || vr.width < 200) return false;
  for (const o of document.querySelectorAll("[data-minus-overlay]")) {
    const r = o.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx > vr.left && cx < vr.right && cy > vr.top && cy < vr.bottom && r.width > vr.width * 0.5 && r.height > vr.height * 0.5) return true;
  }
  return false;
}).catch(() => false);
const adShowing = (pg) => pg.evaluate(() => !!document.querySelector(".ad-showing, .ytp-ad-player-overlay, .ytp-ad-module, .ytp-ad-text")).catch(() => false);
const trySkip = (pg) => pg.evaluate(() => { const b = document.querySelector(".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button"); if (b) b.click(); }).catch(() => {});

for (const id of IDS) {
  const pg = await ctx.newPage();
  log(`\n=== ${id} ===`);
  try {
    await pg.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await pg.bringToFront();
    await pg.evaluate(() => { for (const b of document.querySelectorAll("button")) { const t = (b.textContent || "").toLowerCase(); if (t.includes("accept") || t.includes("agree") || t.includes("reject all")) { b.click(); break; } } }).catch(() => {});
    await pg.waitForTimeout(2000);
    await pg.evaluate(() => { const v = document.querySelector("video"); if (v) { v.muted = true; v.play().catch(() => {}); } }).catch(() => {});
    let seen = "", ticks = 0, coveredEver = false;
    for (let i = 0; i < 40; i++) { // ~80s
      await trySkip(pg);
      const cov = await playerCovered(pg);
      const ad = await adShowing(pg);
      const vdbg = await pg.evaluate(() => document.documentElement.getAttribute("data-minus-vdbg")).catch(() => null);
      if (cov) coveredEver = true;
      const line = `cov=${cov ? 1 : 0} ad=${ad ? 1 : 0} vdbg=${vdbg}`;
      if (line !== seen) { log(`  [${String(i * 2).padStart(3)}s] ${line}`); seen = line; }
      // once covered and ad no longer showing, keep watching to see if it clears
      if (coveredEver && !ad) ticks++;
      if (ticks > 12) { log(`  -> still covered ${cov ? "YES(stuck)" : "no(recovered)"} 24s after ad ended`); break; }
      await pg.waitForTimeout(2000);
    }
  } catch (e) { log(`  ERR ${String(e).split("\n")[0]}`); }
  finally { await pg.close().catch(() => {}); }
}
await ctx.close().catch(() => {});
log("\ndone");
process.exit(0);
