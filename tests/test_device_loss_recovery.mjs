// Deterministic regression for the "no ads blocked" report: a WebGPU device
// loss ("A valid external Instance reference no longer exists") used to leave
// the engine a permanent corpse (retry hit the same dead device). Now the
// offscreen engine detects that error class and REBUILDS on a fresh device.
// Forces the exact error once, asserts the batch still returns a valid verdict.
import { launchWithExtension, waitForEngine, serveFixtures } from "./harness.mjs";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
const HERE = join(fileURLToPath(import.meta.url), "..");

const server = await serveFixtures();
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };
// self-heal the Tegra offscreen-WebGPU cold flake: relaunch until the engine loads
let ctx, sw, extId;
for (let attempt = 1; ; attempt++) {
  ctx = await launchWithExtension({ requireGpu: true });
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 30000 });
  extId = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ engineKind: "lfm" }));
  try { await waitForEngine(ctx, 8 * 60 * 1000); break; }
  catch (e) {
    console.log(`[test] engine load failed (attempt ${attempt}): ${String(e).split("\n")[0]}`);
    await ctx.close().catch(() => {});
    if (attempt >= 4) { server.close(); throw e; }
    await new Promise((r) => setTimeout(r, 8000));
  }
}
try {

  // drive classify from an EXTENSION PAGE (page -> background -> offscreen), the
  // real content.js path — the SW cannot message itself.
  const pg = await ctx.newPage();
  await pg.goto(`chrome-extension://${extId}/popup.html`);
  const adDataUrl = "data:image/png;base64," + readFileSync(join(HERE, "fixtures", "ad1.png")).toString("base64");
  const classify = () => pg.evaluate((img) =>
    new Promise((res) => chrome.runtime.sendMessage({ type: "minus:classify", images: [img] }, res)), adDataUrl);
  const forceFail = (n) => pg.evaluate((n) =>
    new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "test-force-fail", n }, res)), n);

  const before = await classify();
  check("baseline classify works (real ad -> high p_ad)", before?.ok && before.results?.[0] && !before.results[0].error && before.results[0].p_ad > 0.5,
        JSON.stringify(before?.results?.[0]));

  // force the NEXT classifyOne to throw the exact device-loss error
  await forceFail(1);

  const t0 = Date.now();
  const after = await classify();          // first call throws -> rebuild -> retry succeeds
  const recoverMs = Date.now() - t0;
  const r0 = after?.results?.[0];
  check("classify RECOVERS after a device-loss error (valid verdict, not error)", after?.ok && r0 && !r0.error && typeof r0.p_ad === "number",
        JSON.stringify(r0) + ` (${recoverMs}ms)`);
  check("recovered verdict still correct (real ad -> high p_ad)", r0 && !r0.error && r0.p_ad > 0.5, `p_ad=${r0?.p_ad}`);

  // engine reports healthy again
  const stAfter = await sw.evaluate(async () => { const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind: "lfm" }, res)); return r?.info?.state; });
  check("engine back to ready after recovery", stAfter === "ready", `state=${stAfter}`);

  // a subsequent normal classify keeps working
  const later = await classify();
  check("subsequent classify still works", later?.ok && later.results?.[0] && !later.results[0].error, JSON.stringify(later?.results?.[0]));
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]); fail++;
} finally {
  await ctx.close(); server.close();
}
console.log(fail ? `\n${fail} FAILURE(S)` : "\ndevice-loss recovery green");
process.exit(fail ? 1 : 0);
