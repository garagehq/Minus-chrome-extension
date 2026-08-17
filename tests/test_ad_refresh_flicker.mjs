// Regression for "all ads still showing" on churny ad-dense pages (thesurfersview):
// ad slots refresh — the covered element detaches — the overlay was torn down and
// re-cover needed a slow re-classify, so covers flickered off and never kept up.
// Fix: a document-position ad-slot memory re-covers a refreshed creative instantly
// (no re-classify), and a grace-hold keeps the cover in place during the swap so it
// never flashes uncovered.
//
// This fixture covers an ad, then swaps its creative element repeatedly (== an ad
// refresh) while sampling the overlay count every 40ms. Asserts: (1) the cover NEVER
// drops to 0 across the swaps (no flicker), and (2) re-cover does NOT re-classify
// (the classify counter barely moves — proving the region cache, not the slow path).
import { launchWithExtension, waitForEngine, serveFixtures } from "./harness.mjs";

const server = await serveFixtures();
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ctx, sw, extId;
for (let attempt = 1; ; attempt++) {
  ctx = await launchWithExtension({ requireGpu: true });
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 30000 });
  extId = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ engineKind: "lfm", enabled: true, blockDisplay: true, blockVideo: false, blockPopups: false, blockAggressive: false, disabledSites: [], pausedUntil: 0 }));
  try { await waitForEngine(ctx, 8 * 60 * 1000); break; }
  catch (e) { console.log(`[test] engine load failed (attempt ${attempt}): ${String(e).split("\n")[0]}`); await ctx.close().catch(() => {}); if (attempt >= 4) { server.close(); throw e; } await sleep(8000); }
}
try {
  const pg = await ctx.newPage();
  const overlays = () => pg.evaluate(() => document.querySelectorAll('[data-minus-overlay]').length);
  const clsCount = () => sw.evaluate(() => globalThis.__minusClsImgs || 0);
  await pg.goto(`http://127.0.0.1:8919/refreshad.html`);
  await pg.bringToFront();

  // 1) initial cover
  let covered = 0; const t0 = Date.now();
  while (Date.now() - t0 < 25000) { if ((covered = await overlays()) >= 1) break; await sleep(500); }
  check("ad gets covered initially", covered >= 1, `overlays=${covered}`);

  // 2) refresh the creative repeatedly; sample overlays finely for a flash-to-0
  const clsBefore = await clsCount();
  let minDuringSwaps = 99;
  for (let s = 0; s < 4; s++) {
    await pg.evaluate(() => window.swapRefresh());          // detach + re-insert creative
    const t = Date.now();
    while (Date.now() - t < 1600) { const n = await overlays(); if (n < minDuringSwaps) minDuringSwaps = n; await sleep(40); }
  }
  const clsAfter = await clsCount();
  const finalOv = await overlays();

  check("cover NEVER flashes uncovered across refreshes (no flicker)", minDuringSwaps >= 1, `min overlays during 4 swaps = ${minDuringSwaps}`);
  check("still covered after refreshes", finalOv >= 1, `overlays=${finalOv}`);
  check("re-cover uses the region cache, not re-classification", (clsAfter - clsBefore) <= 2, `classifications during 4 swaps = ${clsAfter - clsBefore} (region cache => ~0)`);
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]); fail++;
} finally {
  await ctx.close(); server.close();
}
console.log(fail ? `\n${fail} FAILURE(S)` : "\nad-refresh flicker green");
process.exit(fail ? 1 : 0);
