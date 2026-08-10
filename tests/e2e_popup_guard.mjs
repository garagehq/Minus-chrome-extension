// E2E for the popup guard (the mangafreak-class miss): a non-link click that
// spawns a full-page ad tab gets a cover with Close/Show; a REAL link opening a
// plain article tab is left alone. Deterministic local fixtures, real engine.
import { chromium } from "playwright";
import { serveFixtures } from "./harness.mjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "extension");
const GPU = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface", "--no-sandbox"];
let fails = 0, passes = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  — ${d}`}`); c ? passes++ : fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await serveFixtures();
let ctx, sw, ready = false;
for (let a = 1; a <= 4 && !ready; a++) {
  ctx = await chromium.launchPersistentContext(join(HERE, ".profile-popupguard"), { channel: "chromium", headless: false, viewport: { width: 1280, height: 900 }, args: [...GPU, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 60000 });
  await sw.evaluate((c) => chrome.storage.local.set(c), { enabled: true, blockDisplay: true, blockVideo: true, blockPopups: true, blockAction: "flashcards", blockLang: "es", disabledSites: [], pausedUntil: 0 });
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) { const st = await sw.evaluate(async () => { const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind: "lfm" }, res)); return r?.info?.state; }).catch(() => "?"); if (st === "ready") { ready = true; break; } if (st === "error") break; await sleep(3000); }
  console.log(`      launch ${a}: engine ready=${ready}`);
  if (!ready) { await ctx.close().catch(() => {}); await sleep(1500); }
}
ok("engine ready (headed WebGPU)", ready);
if (!ready) { await ctx.close().catch(() => {}); server.close(); process.exit(1); }

// NOTE the popup guard requires the popup tab to be cross-domain from its
// opener. The fixture server is 127.0.0.1; open the OPENER via localhost so
// the spawned 127.0.0.1 ad tab counts as a different host.
const OPENER = "http://localhost:8919/popup_opener.html";

async function triggerPopup(pg) {
  const newTab = ctx.waitForEvent("page", { timeout: 8000 });
  await pg.click("#reader");
  const tab = await newTab;
  await tab.waitForLoadState("domcontentloaded").catch(() => {});
  await tab.bringToFront(); // popunder judged on focus; also makes capture legal
  return tab;
}

try {
  // ---------- hijack-click popup gets covered ----------
  let pg = await ctx.newPage();
  await pg.goto(OPENER, { waitUntil: "domcontentloaded" });
  await pg.bringToFront();
  await sleep(1500);
  const adTab = await triggerPopup(pg);
  let covered = false;
  for (let i = 0; i < 15 && !covered; i++) { covered = !!(await adTab.$("[data-minus-popup]")); if (!covered) await sleep(1000); }
  ok("hijack-click ad tab gets the popup cover", covered, "no [data-minus-popup] within 15s");
  if (covered) {
    ok("cover names the verdict", /looks like an ad \(\d+%\)/.test(await adTab.textContent("[data-minus-popup]")));
    // Show page → cover removed, tab stays
    await adTab.click(".minus-popup-secondary");
    await sleep(500);
    ok("'Show page' removes the cover and keeps the tab", !(await adTab.$("[data-minus-popup]")) && !adTab.isClosed());
    ok("cover does NOT come back after 'Show page'", await (async () => { await sleep(2500); return !(await adTab.$("[data-minus-popup]")); })());
  }
  await adTab.close().catch(() => {});
  await pg.close().catch(() => {});

  // ---------- Close tab actually closes ----------
  pg = await ctx.newPage();
  await pg.goto(OPENER, { waitUntil: "domcontentloaded" });
  await pg.bringToFront(); await sleep(1200);
  const adTab2 = await triggerPopup(pg);
  let covered2 = false;
  for (let i = 0; i < 15 && !covered2; i++) { covered2 = !!(await adTab2.$("[data-minus-popup]")); if (!covered2) await sleep(1000); }
  if (covered2) {
    await adTab2.click(".minus-popup-btn:not(.minus-popup-secondary)");
    await sleep(1500);
    ok("'Close tab' closes the popup tab", adTab2.isClosed(), "tab still open");
  } else ok("'Close tab' closes the popup tab", false, "cover never appeared on second popup");
  await pg.close().catch(() => {});

  // ---------- negative control: real link -> plain article, untouched ----------
  pg = await ctx.newPage();
  await pg.goto(OPENER, { waitUntil: "domcontentloaded" });
  await pg.bringToFront(); await sleep(1200);
  const artPromise = ctx.waitForEvent("page", { timeout: 8000 });
  await pg.click("#realLink");
  const artTab = await artPromise;
  await artTab.waitForLoadState("domcontentloaded").catch(() => {});
  await artTab.bringToFront();
  await sleep(6000);
  ok("real-link article tab is NEVER covered", !(await artTab.$("[data-minus-popup]")), "guard fired on a legitimate link");
  await artTab.close().catch(() => {});
  await pg.close().catch(() => {});
} catch (e) { ok("no exception", false, String(e).split("\n")[0]); }
finally { await ctx.close().catch(() => {}); server.close(); }

console.log(fails ? `\n${fails} FAILURE(S) (${passes} passed)` : `\npopup-guard e2e green (${passes} passed)`);
process.exit(fails ? 1 : 0);
