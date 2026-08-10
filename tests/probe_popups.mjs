// Evidence probe for popup-style ads a page throws at the user (reported miss:
// aggressive reader sites). Loads a URL with the extension, clicks to trigger
// the site's popup/popunder listeners, then inventories (a) new tabs
// (popunders), (b) large fixed/high-z overlay elements (in-page popups) with
// the details the candidate filter would see (tag, class, size, img/iframe
// descendants), (c) Minus overlays present. Screenshots everything.
//   DISPLAY=:99 node tests/probe_popups.mjs [url]
import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "extension");
const OUT = join(HERE, "screenshots", "popups");
mkdirSync(OUT, { recursive: true });
const GPU = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface", "--no-sandbox"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(m);

let ctx, sw, ready = false;
for (let a = 1; a <= 4 && !ready; a++) {
  ctx = await chromium.launchPersistentContext(join(HERE, ".profile-popups"), { channel: "chromium", headless: false, viewport: { width: 1440, height: 900 }, args: [...GPU, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 60000 });
  await sw.evaluate((c) => chrome.storage.local.set(c), { enabled: true, blockDisplay: true, blockVideo: true, blockAction: "flashcards", blockLang: "es", disabledSites: [], pausedUntil: 0, threshold: 0.5 });
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) { const st = await sw.evaluate(async () => { const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind: "lfm" }, res)); return r?.info?.state; }).catch(() => "?"); if (st === "ready") { ready = true; break; } if (st === "error") break; await sleep(3000); }
  log(`launch ${a}: ready=${ready}`);
  if (!ready) { await ctx.close().catch(() => {}); await sleep(1500); }
}
if (!ready) process.exit(1);

const pagesBefore = ctx.pages().length;
const newPages = [];
ctx.on("page", (p) => newPages.push(p));

const pg = await ctx.newPage();
try {
  const URL_ = process.argv[2];
  if (!URL_) { log("usage: node tests/probe_popups.mjs <url of a popup-heavy page>"); process.exit(2); }
  await pg.goto(URL_, { waitUntil: "domcontentloaded", timeout: 45000 });
  await pg.bringToFront();
  await sleep(8000);
  await pg.screenshot({ path: join(OUT, "01_loaded.png") }).catch(() => {});

  // inventory BEFORE clicking
  const inv = (tag) => pg.evaluate((label) => {
    const out = { label, overlays: document.querySelectorAll("[data-minus-overlay]").length, bigOverlayEls: [], iframes: [], imgs: 0 };
    out.imgs = document.images.length;
    for (const f of document.querySelectorAll("iframe")) {
      const r = f.getBoundingClientRect();
      if (r.width > 50 && r.height > 50) out.iframes.push({ src: (f.src || "").slice(0, 80), w: Math.round(r.width), h: Math.round(r.height) });
    }
    for (const el of document.querySelectorAll("div,a,section,ins")) {
      const st = getComputedStyle(el);
      if ((st.position === "fixed" || st.position === "absolute") && +st.zIndex >= 1000) {
        const r = el.getBoundingClientRect();
        if (r.width >= 250 && r.height >= 200) out.bigOverlayEls.push({
          tag: el.tagName, cls: `${el.id} ${el.className}`.slice(0, 70), w: Math.round(r.width), h: Math.round(r.height),
          z: st.zIndex, hasImg: !!el.querySelector("img"), hasIframe: !!el.querySelector("iframe"),
          bg: st.backgroundImage !== "none",
        });
      }
    }
    return out;
  }, tag);
  log("BEFORE CLICK: " + JSON.stringify(await inv("before"), null, 1));

  // click the reader area — shady sites bind popup/popunder to first clicks
  for (let i = 0; i < 3; i++) {
    await pg.mouse.click(720, 450).catch(() => {});
    await sleep(2500);
  }
  await sleep(6000);
  await pg.screenshot({ path: join(OUT, "02_after_clicks.png") }).catch(() => {});
  log("AFTER CLICK: " + JSON.stringify(await inv("after"), null, 1));

  // popunder tabs?
  log(`new tabs opened by the site: ${newPages.length}`);
  for (const [i, p] of newPages.entries()) {
    try {
      await p.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
      log(`  tab${i}: url=${p.url().slice(0, 100)}`);
      await p.bringToFront(); await sleep(6000);
      const o = await p.evaluate(() => document.querySelectorAll("[data-minus-overlay]").length).catch(() => -1);
      const guard = await p.evaluate(() => !!document.querySelector("[data-minus-popup]")).catch(() => false);
      log(`  tab${i}: minus overlays=${o} popupGuardCover=${guard}`);
      await p.screenshot({ path: join(OUT, `03_popup_tab${i}.png`) }).catch(() => {});
    } catch {}
  }
  // give the sampler another beat on the main page, then final state
  await pg.bringToFront(); await sleep(6000);
  const verdicts = await sw.evaluate(() => globalThis.__minusPopupVerdicts || []).catch(() => []);
  const trace = await sw.evaluate(() => globalThis.__minusPopupTrace || []).catch(() => []);
  log("POPUP GUARD TRACE: " + JSON.stringify(trace));
  log("POPUP GUARD VERDICTS: " + JSON.stringify(verdicts));
  const fin = await inv("final");
  log("FINAL: " + JSON.stringify(fin, null, 1));
  await pg.screenshot({ path: join(OUT, "04_final.png") }).catch(() => {});
} catch (e) { log("ERR " + String(e).split("\n")[0]); }
finally { await ctx.close().catch(() => {}); }
process.exit(0);
