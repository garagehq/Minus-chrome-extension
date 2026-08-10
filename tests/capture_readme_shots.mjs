// Capture README screenshots: overlays on REAL sites + the popup / options /
// review surfaces. Writes to docs/screenshots/ (committed to the repo).
import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "extension");
const OUT = join(HERE, "..", "docs", "screenshots");
mkdirSync(OUT, { recursive: true });
const GPU = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface", "--no-sandbox"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

// ad-heavy sites that produced overlays in the 1000-site soak
const SITES = [
  "https://www.tomshardware.com/", "https://www.cnet.com/", "https://www.pcmag.com/",
  "https://www.theverge.com/", "https://www.forbes.com/", "https://nypost.com/",
  "https://www.digitaltrends.com/", "https://www.androidauthority.com/",
  "https://www.techradar.com/", "https://www.gamespot.com/", "https://www.ign.com/",
  "https://www.livescience.com/",
];

let ctx, sw, ready = false;
for (let a = 1; a <= 4 && !ready; a++) {
  ctx = await chromium.launchPersistentContext(join(HERE, ".profile-shots"), { channel: "chromium", headless: false, viewport: { width: 1440, height: 900 }, args: [...GPU, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 60000 });
  await sw.evaluate((c) => chrome.storage.local.set(c), { enabled: true, blockDisplay: true, blockVideo: true, blockAction: "flashcards", blockLang: "es", collectOptIn: false, disabledSites: [], pausedUntil: 0, threshold: 0.5, engineKind: "lfm" });
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) { const st = await sw.evaluate(async () => { const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind: "lfm" }, res)); return r?.info?.state; }).catch(() => "?"); if (st === "ready") { ready = true; break; } if (st === "error") break; await sleep(3000); }
  log(`launch ${a}: ready=${ready}`);
  if (!ready) { await ctx.close().catch(() => {}); await sleep(1500); }
}
if (!ready) { log("engine never ready"); process.exit(1); }
const extId = new URL(sw.url()).host;

// ---- overlays on real sites ----
let got = 0;
for (const url of SITES) {
  if (got >= 4) break;
  const pg = await ctx.newPage();
  const host = new URL(url).host.replace(/^www\./, "").replace(/\./g, "_");
  try {
    await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await pg.bringToFront();
    await pg.waitForTimeout(9000);
    await pg.evaluate(() => window.scrollBy(0, 900)).catch(() => {});
    await pg.waitForTimeout(6000);
    // find an overlay and scroll it into a nice spot
    const ov = await pg.evaluate(() => {
      const o = document.querySelector("[data-minus-overlay]");
      if (!o) return 0;
      o.scrollIntoView({ block: "center" });
      return document.querySelectorAll("[data-minus-overlay]").length;
    });
    await pg.waitForTimeout(1500);
    if (ov > 0) {
      await pg.screenshot({ path: join(OUT, `site_${host}.png`) });
      log(`  ✓ ${host}: ${ov} overlay(s) — captured`);
      got++;
    } else log(`  – ${host}: no overlays`);
  } catch (e) { log(`  x ${host}: ${String(e).split("\n")[0]}`); }
  finally { await pg.close().catch(() => {}); }
}
log(`real-site captures: ${got}`);

// ---- popup (narrow viewport so it renders like the real popup) ----
{
  const pg = await ctx.newPage();
  await pg.setViewportSize({ width: 330, height: 860 });
  await pg.goto(`chrome-extension://${extId}/popup.html`);
  await pg.waitForTimeout(2500);
  await pg.screenshot({ path: join(OUT, "popup.png") });
  await pg.close(); log("  ✓ popup");
}
// ---- options ----
{
  const pg = await ctx.newPage();
  await pg.setViewportSize({ width: 1100, height: 1400 });
  await pg.goto(`chrome-extension://${extId}/options.html`);
  await pg.waitForTimeout(2000);
  await pg.screenshot({ path: join(OUT, "options.png"), fullPage: false });
  await pg.close(); log("  ✓ options");
}
// ---- review (seeded) ----
{
  const now = Date.now();
  await sw.evaluate((cards) => chrome.storage.local.set({ minusLearn: { v: 1, cards } }), {
    "es::la pantalla": { l: "es", w: "la pantalla", en: "the screen", ex: "La pantalla está libre de anuncios.", reps: 2, ivl: 3, due: now - 1000, first: now - 86400000 * 4, seen: 6 },
    "es::aprender": { l: "es", w: "aprender", en: "to learn", ex: "Prefiero aprender español que ver anuncios.", reps: 1, ivl: 1, due: now - 500, first: now - 86400000 * 2, seen: 3 },
    "el::η λέξη": { l: "el", w: "η λέξη", en: "the word", ex: "Μία λέξη την ημέρα είναι αρκετή.", reps: 0, ivl: 0, due: now, first: now, seen: 1 },
    "es::el conocimiento": { l: "es", w: "el conocimiento", en: "knowledge", ex: "El conocimiento vale más que un descuento.", reps: 5, ivl: 25, due: now + 86400000 * 20, first: now - 86400000 * 30, seen: 9 },
  });
  const pg = await ctx.newPage();
  await pg.setViewportSize({ width: 900, height: 760 });
  await pg.goto(`chrome-extension://${extId}/review.html`);
  await pg.waitForTimeout(1200);
  await pg.screenshot({ path: join(OUT, "review_front.png") });
  await pg.click("#showBtn"); await pg.waitForTimeout(400);
  await pg.screenshot({ path: join(OUT, "review_revealed.png") });
  await pg.close(); log("  ✓ review x2");
}
await ctx.close().catch(() => {});
log("done → docs/screenshots/");
process.exit(0);
