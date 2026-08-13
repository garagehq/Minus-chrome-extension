// Regression for the "no ads blocked under load" death-spiral: minus-v0.1 is
// WebGPU-only (GatherBlockQuantized has no WASM path), so a GPU device lost under
// sustained pressure used to send the engine into an endless rebuild→lose→rebuild
// loop that blocked nothing and never recovered. The fix backs off into a
// "degraded" cooldown, fast-fails classify (so scans reschedule instead of
// thrashing a busy GPU), and rebuilds once the GPU frees up.
//
// This drives the exact failure with a SUSTAINED forced device-loss (every
// classifyOne throws, including the rebuild's warm-up) and asserts:
//   1. under sustained loss classify still RETURNS (bounded, not a hang), with an
//      error result — and the engine reports "degraded", not "loading"/"error".
//   2. a follow-up classify during the cooldown FAST-FAILS (no expensive rebuild
//      thrash) — much quicker than the rebuild attempt that opened the spiral.
//   3. once the pressure relents, the engine RECOVERS on its own to a valid
//      verdict (the death-spiral is broken).
import { launchWithExtension, waitForEngine, serveFixtures } from "./harness.mjs";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
const HERE = join(fileURLToPath(import.meta.url), "..");

const server = await serveFixtures();
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // 0) baseline
  const before = await classify();
  check("baseline classify works (real ad -> high p_ad)",
        before?.ok && before.results?.[0] && !before.results[0].error && before.results[0].p_ad > 0.5,
        JSON.stringify(before?.results?.[0]));

  // 1) SUSTAINED device loss: every classifyOne throws (incl. the rebuild warm-up),
  //    so the engine can never re-ready while pressure is on. This is the spiral.
  await forceFail(9999);
  const t4a = Date.now();
  const spiral = await classify();          // device loss -> rebuild -> warm-up dies -> degraded
  const t4 = Date.now() - t4a;
  const r4 = spiral?.results?.[0];
  check("under sustained loss classify RETURNS (no permanent hang)", !!spiral && t4 < 90000, `${t4}ms`);
  check("under sustained loss the result is an error, not a bogus verdict", !!r4 && (r4.error || r4.p_ad === 0), JSON.stringify(r4));
  const stSpiral = await engState();
  check("engine reports DEGRADED (not stuck loading / hard error)", stSpiral === "degraded", `state=${stSpiral}`);

  // 2) follow-up classify during the cooldown must FAST-FAIL, not thrash a rebuild
  const t5a = Date.now();
  const cooled = await classify();
  const t5 = Date.now() - t5a;
  check("cooldown classify fast-fails (much quicker than the rebuild attempt)", t5 < 3000 && t5 < t4, `fastfail=${t5}ms vs rebuild=${t4}ms`);

  // 3) pressure relents -> engine RECOVERS on its own (death spiral broken)
  await forceFail(0);
  let recovered = null, tries = 0;
  const t6a = Date.now();
  while (Date.now() - t6a < 45000) {
    tries++;
    const r = await classify();
    const rr = r?.results?.[0];
    if (r?.ok && rr && !rr.error && typeof rr.p_ad === "number" && rr.p_ad > 0.5) { recovered = rr; break; }
    await sleep(2500);
  }
  check("engine RECOVERS after pressure relents (valid verdict again)", !!recovered, recovered ? `p_ad=${recovered.p_ad} after ${tries} tries / ${Date.now() - t6a}ms` : `never recovered in ${tries} tries`);
  const stAfter = await engState();
  check("engine back to READY after recovery", stAfter === "ready", `state=${stAfter}`);
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]); fail++;
} finally {
  await ctx.close(); server.close();
}
console.log(fail ? `\n${fail} FAILURE(S)` : "\ngpu death-spiral recovery green");
process.exit(fail ? 1 : 0);
