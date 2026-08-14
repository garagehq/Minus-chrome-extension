// Regression for the soak finding (2026-08-14): v0.4.9 could not recover from a
// REAL WebGPU device loss in place — the lost device never returns inside the same
// offscreen document, so backoff degrades forever. v0.4.10 fix: when the engine is
// continuously "degraded" past a threshold, it signals background, which RECREATES
// the offscreen document (a fresh one gets a new GPU context).
//
// Deterministic test of the recreation MECHANISM: force a SUSTAINED failure
// (test-force-fail, every classifyOne throws — including every rebuild's warm-up).
// Under that force, in-place rebuild can NEVER succeed (warm-up always throws while
// the counter is >0). So the ONLY way the engine can return to "ready" with a valid
// verdict is if the offscreen document was RECREATED (a fresh document resets the
// force counter to 0 — exactly mirroring a fresh GPU context after a real loss).
// Thus: recovery here PROVES the doc-recreation path fired.
import { launchWithExtension, waitForEngine, serveFixtures } from "./harness.mjs";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
const HERE = join(fileURLToPath(import.meta.url), "..");

const server = await serveFixtures();
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ctx, sw, extId;
for (let attempt = 1; ; attempt++) {
  ctx = await launchWithExtension({ requireGpu: true });
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 30000 });
  extId = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ engineKind: "lfm", enabled: true }));
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
  await pg.goto(`chrome-extension://${extId}/popup.html`);
  const adDataUrl = "data:image/png;base64," + readFileSync(join(HERE, "fixtures", "ad1.png")).toString("base64");
  const classify = () => pg.evaluate((img) =>
    new Promise((res) => chrome.runtime.sendMessage({ type: "minus:classify", images: [img] }, res)), adDataUrl);
  const forceFail = (n) => pg.evaluate((n) =>
    new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "test-force-fail", n }, res)), n);
  const engState = () => sw.evaluate(async () => {
    const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind: "lfm" }, res));
    return r?.info?.state;
  });

  const before = await classify();
  check("baseline classify works (real ad -> high p_ad)",
        before?.ok && before.results?.[0] && !before.results[0].error && before.results[0].p_ad > 0.5,
        JSON.stringify(before?.results?.[0]));

  // SUSTAINED failure: every classifyOne throws the device-loss error, forever.
  // In-place rebuild can't clear this — only recreating the document can.
  await forceFail(999999);
  const spiral = await classify();     // -> device loss -> rebuild warm-up fails -> degraded
  check("goes degraded under sustained loss", (await engState()) === "degraded", `state after first fail`);
  check("classify returns an error (not a bogus verdict) while degraded", !!spiral?.results?.[0]?.error || spiral?.ok === false, JSON.stringify(spiral?.results?.[0] || spiral));

  // Drive heartbeats (classify + status) and wait for the auto-recreation to bring
  // the engine back. Recovery is only possible via document recreation.
  const t0 = Date.now();
  let recovered = null, recoveredAt = 0, sawDegraded = 0;
  while (Date.now() - t0 < 90000) {
    const st = await engState();
    if (st === "degraded") sawDegraded++;
    const r = await classify();
    const rr = r?.results?.[0];
    if (r?.ok && rr && !rr.error && typeof rr.p_ad === "number" && rr.p_ad > 0.5) { recovered = rr; recoveredAt = Date.now() - t0; break; }
    await sleep(2500);
  }
  check("engine RECOVERS under SUSTAINED loss (only possible via doc recreation)", !!recovered,
        recovered ? `p_ad=${recovered.p_ad} at ${recoveredAt}ms, sawDegraded=${sawDegraded}` : `never recovered (sawDegraded=${sawDegraded})`);
  // recreation waits for the ~25s stuck threshold before firing — recovery should
  // NOT be near-instant (that would mean in-place retry, which is impossible here).
  check("recovery waited for the stuck threshold (>15s, i.e. not in-place)", !recovered || recoveredAt > 15000, `recoveredAt=${recoveredAt}ms`);
  check("engine back to READY after recreation", (await engState()) === "ready", `state=${await engState()}`);

  // a subsequent classify keeps working on the fresh document
  const later = await classify();
  check("subsequent classify works on the recreated engine", later?.ok && later.results?.[0] && !later.results[0].error && later.results[0].p_ad > 0.5, JSON.stringify(later?.results?.[0]));
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]); fail++;
} finally {
  await ctx.close(); server.close();
}
console.log(fail ? `\n${fail} FAILURE(S)` : "\nengine-recreate recovery green");
process.exit(fail ? 1 : 0);
