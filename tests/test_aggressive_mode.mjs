// Aggressive-mode toggle: normally a bare ad creative that is NOT a standard IAB
// size and NOT squarish is left alone (that shape is where editorial photos live,
// so the shape filter protects them). With `blockAggressive` on, the extension
// trusts the model outside ad slots too and covers it — catching native/hidden ads
// at the cost of more editorial-photo false positives.
//
// The fixture (aggressive.html) shows ad1.png at 480x270 (not standard, not square,
// no ad-context). Same page, toggled live, is a clean differential: OFF -> 0 covers,
// ON -> 1 cover, OFF again -> re-derived back to 0. (If the page weren't scannable
// at all, the ON case would also be 0 — so ON=1 proves the differential is real.)
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
  catch (e) {
    console.log(`[test] engine load failed (attempt ${attempt}): ${String(e).split("\n")[0]}`);
    await ctx.close().catch(() => {});
    if (attempt >= 4) { server.close(); throw e; }
    await sleep(8000);
  }
}
try {
  const pg = await ctx.newPage();
  const overlays = () => pg.evaluate(() => document.querySelectorAll('[data-minus-overlay]').length);
  const pollOverlays = async (want, ms) => { const t = Date.now(); let n = 0; while (Date.now() - t < ms) { n = await overlays(); if (n >= want) return n; await sleep(1500); } return n; };

  await pg.goto(`http://127.0.0.1:8919/aggressive.html`);
  await pg.bringToFront();

  // 1) aggressive OFF (default): the bare non-standard/non-square creative is left alone
  await sleep(14000);
  const off1 = await overlays();
  check("normal mode does NOT cover the bare non-standard ad image", off1 === 0, `overlays=${off1}`);

  // 2) turn aggressive ON live -> it should get covered
  await sw.evaluate(() => chrome.storage.local.set({ blockAggressive: true }));
  const on = await pollOverlays(1, 25000);
  check("aggressive mode COVERS the same image", on >= 1, `overlays=${on}`);

  // 3) turn aggressive OFF live -> re-derive removes the aggressive-only cover
  await sw.evaluate(() => chrome.storage.local.set({ blockAggressive: false }));
  await sleep(10000);
  const off2 = await overlays();
  check("toggling OFF re-derives and removes the aggressive-only cover", off2 === 0, `overlays=${off2}`);
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]); fail++;
} finally {
  await ctx.close(); server.close();
}
console.log(fail ? `\n${fail} FAILURE(S)` : "\naggressive-mode green");
process.exit(fail ? 1 : 0);
