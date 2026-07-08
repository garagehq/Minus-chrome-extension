// Performance + soak profile (#62): model load time, per-classification
// latency, memory footprint, and a multi-page soak to catch overlay/memory
// leaks. Uses the default safe engine (Iter 14) on WebGPU.
import { launchWithExtension, serveFixtures, waitForEngine, HERE } from "./harness.mjs";
import { writeFileSync } from "fs";
import { join } from "path";

const server = await serveFixtures();
const ctx = await launchWithExtension();
const report = {};

async function swMem(sw) {
  return sw.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0)).catch(() => 0);
}

try {
  const [sw] = ctx.serviceWorkers();

  // --- load time (cold, model already downloaded/cached)
  const t0 = Date.now();
  const info = await waitForEngine(ctx);
  report.model_load_ms = Date.now() - t0;
  report.device = info.device;
  report.model = info.modelId;

  // --- per-classification latency via direct offscreen classify
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:8919/", { waitUntil: "load" });
  await page.locator("[data-minus-overlay]").first().waitFor({ state: "visible", timeout: 120000 });
  // read the ms the offscreen reported for a batch
  const lat = await sw.evaluate(async () => {
    const b64 = await fetch("http://127.0.0.1:8919/ad1.png").then(r => r.blob())
      .then(b => new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }));
    const t = performance.now();
    const r = await new Promise(res => chrome.runtime.sendMessage(
      { target: "minus-offscreen", type: "classify", images: [b64] }, res));
    return { wall: Math.round(performance.now() - t), reported: r?.results?.[0]?.ms };
  });
  report.classify_latency_ms = lat;
  await page.close();

  // --- soak: navigate several pages, watch overlay leaks + heap growth
  const soakUrls = [
    "http://127.0.0.1:8919/", "http://127.0.0.1:8919/scroll.html",
    "http://127.0.0.1:8919/dynamic.html", "http://127.0.0.1:8919/adframe.html",
    "http://127.0.0.1:8919/shadow.html",
  ];
  const heap0 = await swMem(sw);
  let maxLeakedOverlays = 0;
  for (let round = 0; round < 3; round++) {
    for (const url of soakUrls) {
      const p = await ctx.newPage();
      await p.goto(url, { waitUntil: "load" }).catch(() => {});
      await p.waitForTimeout(2500);
      await p.close(); // closing must not leave orphan overlays anywhere
    }
    // after closing all soak pages, a fresh page should start clean
    const check = await ctx.newPage();
    await check.goto("about:blank");
    const leaked = await check.evaluate(() => document.querySelectorAll("[data-minus-overlay]").length);
    maxLeakedOverlays = Math.max(maxLeakedOverlays, leaked);
    await check.close();
  }
  const heap1 = await swMem(sw);
  report.soak = {
    pages_visited: soakUrls.length * 3,
    max_leaked_overlays_on_blank: maxLeakedOverlays,
    sw_heap_growth_mb: heap0 ? +(((heap1 - heap0) / 1e6).toFixed(1)) : "n/a",
  };

  report.verdict = {
    loads_in_reasonable_time: report.model_load_ms < 60000,
    no_overlay_leak: maxLeakedOverlays === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  writeFileSync(join(HERE, "..", "docs_perf_soak.json"), JSON.stringify(report, null, 2));
  const pass = report.verdict.loads_in_reasonable_time && report.verdict.no_overlay_leak;
  console.log(pass ? "PASS  perf/soak" : "FAIL  perf/soak");
  process.exitCode = pass ? 0 : 1;
} catch (e) {
  console.log("FAIL (exception)", String(e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await ctx.close();
  server.close();
}
