// Elaborate head-to-head: BOTH engines × BOTH ad types on controlled fixtures.
//   Engine A = LFM Iter 21-web on WebGPU (default path).
//   Engine B = SigLIP2 Lite (fp32) on WASM (WebGPU disabled -> auto-fallback).
//   Ad types = a static DISPLAY ad (index.html #ad-img) and a VIDEO ad break
//              (video.html: 20s program / 20s AD / 20s program).
// Reports a coverage matrix + engine identity + per-classify latency signal.
import { chromium } from "playwright";
import { launchWithExtension, serveFixtures, waitForEngine, EXT_DIR } from "./harness.mjs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const server = await serveFixtures();
const results = [];
const overlays = (p) => p.evaluate(() => document.querySelectorAll("[data-minus-overlay]").length);

async function runEngine(name, ctx, note) {
  const out = { name, note, engine: "", display: false, video: false, videoT: null };
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 30000 });
  const info = await waitForEngine(ctx, 8 * 60 * 1000);
  out.engine = `${info.modelId} / ${info.device}`;

  // DISPLAY: index.html has one ad image; wait up to 2.5 min (WASM is slow).
  const d = await ctx.newPage();
  await d.goto("http://127.0.0.1:8919/", { waitUntil: "load" });
  await d.locator("[data-minus-overlay]").first().waitFor({ state: "visible", timeout: 150000 }).catch(() => {});
  out.display = (await overlays(d)) >= 1;
  await d.close();

  // VIDEO: cover during the 20–40s ad break; poll generously.
  const v = await ctx.newPage();
  await v.goto("http://127.0.0.1:8919/video.html", { waitUntil: "load" });
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const t = await v.evaluate(() => document.getElementById("player")?.currentTime ?? 0);
    if (t > 18 && t < 58 && (await overlays(v)) > 0) { out.video = true; out.videoT = +t.toFixed(1); break; }
    if (t >= 58) break;
    await v.waitForTimeout(1500);
  }
  await v.close();
  results.push(out);
  console.log(JSON.stringify(out));
}

try {
  // A) LFM on WebGPU
  {
    const ctx = await launchWithExtension({ requireGpu: true });
    await ctx.evaluateHandle?.(() => {}).catch(() => {});
    await runEngine("LFM / WebGPU", ctx, "default");
    await ctx.close();
  }
  // B) Lite SigLIP2 on WASM (WebGPU disabled -> fallback)
  {
    const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "minus-2e-")), {
      channel: "chromium", headless: true,
      args: ["--no-sandbox", "--disable-features=WebGPU,WebGPUDeveloperFeatures,Vulkan",
        `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
    });
    await runEngine("Lite / WASM", ctx, "webgpu disabled");
    await ctx.close();
  }
} finally {
  server.close();
  console.log("\n===== ENGINE × AD-TYPE MATRIX =====");
  console.log("engine              | model / device                                  | display ad | video ad");
  for (const r of results) {
    console.log(`${r.name.padEnd(19)} | ${(r.engine).padEnd(47)} | ${(r.display ? "COVERED" : "  no   ").padEnd(10)} | ${r.video ? `COVERED @${r.videoT}s` : "  no"}`);
  }
}
