// Focused overlay-interaction UX probe (with launch retry for the Tegra WebGPU
// cold-flake): tests the ✕ reveal and ⚑ report discoverability + behavior.
import { chromium } from "playwright";
import { serveFixtures } from "./harness.mjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "extension");
const OUT = join(HERE, "screenshots", "ux");
const GPU = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface", "--no-sandbox"];
const OBS = (s) => console.log("OBS  " + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = await serveFixtures();
let ctx, sw, ready = false;
for (let a = 1; a <= 4 && !ready; a++) {
  ctx = await chromium.launchPersistentContext(join(HERE, ".profile-uxo"), { channel: "chromium", headless: false, viewport: { width: 1280, height: 900 }, args: [...GPU, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 60000 });
  await sw.evaluate((c) => chrome.storage.local.set(c), { enabled: true, blockDisplay: true, blockVideo: false, collectOptIn: true, blockAction: "flashcards", blockLang: "es" });
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) { const st = await sw.evaluate(async () => { const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind: "lfm" }, res)); return r?.info?.state; }).catch(() => "?"); if (st === "ready") { ready = true; break; } if (st === "error") break; await sleep(3000); }
  OBS(`launch ${a}: engine ready=${ready}`);
  if (!ready) { await ctx.close().catch(() => {}); await sleep(1500); }
}
if (!ready) { OBS("engine never ready"); await ctx.close().catch(() => {}); server.close(); process.exit(1); }
try {
  const pg = await ctx.newPage();
  await pg.goto("http://127.0.0.1:8919/"); await pg.bringToFront();
  await pg.waitForSelector("[data-minus-overlay]", { timeout: 30000 }).catch(() => {});
  const n = (await pg.$$("[data-minus-overlay]")).length;
  OBS(`fixture → ${n} overlay(s)`);
  await pg.screenshot({ path: join(OUT, "overlay_01_covered.png") }).catch(() => {});
  const atRest = await pg.evaluate(() => {
    const x = document.querySelector(".minus-x"), r = document.querySelector(".minus-report");
    const op = (el) => el ? getComputedStyle(el).opacity : "none";
    return { xExists: !!x, xOpacity: op(x), reportExists: !!r, reportOpacity: op(r) };
  });
  OBS(`AT REST: ✕ exists=${atRest.xExists} opacity=${atRest.xOpacity}  |  ⚑ report exists=${atRest.reportExists} opacity=${atRest.reportOpacity}`);
  OBS(`  → ${atRest.xOpacity === "0" ? "✕ is INVISIBLE until hover (mouse-only discoverability)" : "✕ visible at rest"}`);
  await pg.hover("[data-minus-overlay]").catch(() => {});
  await sleep(500);
  await pg.screenshot({ path: join(OUT, "overlay_02_hover.png") }).catch(() => {});
  const onHover = await pg.evaluate(() => { const x = document.querySelector(".minus-x"); return x ? getComputedStyle(x).opacity : "none"; });
  OBS(`ON HOVER: ✕ opacity=${onHover}`);
  // click ✕ → reveal ad, note no undo
  const b = (await pg.$$("[data-minus-overlay]")).length;
  await pg.click(".minus-x", { force: true }).catch(() => {});
  await sleep(600);
  OBS(`clicked ✕ → overlays ${b} → ${(await pg.$$("[data-minus-overlay]")).length}; is there any 're-block / undo' affordance after revealing? (inspecting page for a restore control)`);
  const restore = await pg.evaluate(() => !!document.querySelector("[data-minus-restore],[data-minus-undo],.minus-undo"));
  OBS(`  restore/undo control present = ${restore}`);
  await pg.screenshot({ path: join(OUT, "overlay_03_revealed.png") }).catch(() => {});
} finally { await ctx.close().catch(() => {}); server.close(); }
process.exit(0);
