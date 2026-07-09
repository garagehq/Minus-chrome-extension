// Verify the WASM fallback path end-to-end: launch Chromium with WebGPU
// DISABLED (so navigator.gpu is gone -> warmUpWebGpu()=false -> device "wasm"),
// load the extension, wait for the engine to reach "ready" on WASM, and run a
// real classify to prove inference works (this is the path users without
// working WebGPU actually run on).
import { chromium } from "playwright";
import { waitForEngine } from "./harness.mjs";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "extension");
const adPng = "data:image/png;base64," + readFileSync(join(HERE, "fixtures", "ad1.png")).toString("base64");

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "minus-wasm-")), {
  channel: "chromium",
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-features=WebGPU,WebGPUDeveloperFeatures,Vulkan", // force navigator.gpu off
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
  ],
});

let failures = 0;
const check = (name, cond, detail) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!cond) failures++; };

try {
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 30000 });
  const gpu = await sw.evaluate(() => typeof navigator.gpu); // SW has no navigator.gpu anyway; offscreen is what matters
  const t0 = Date.now();
  const info = await waitForEngine(ctx, 8 * 60 * 1000);
  check("engine reaches ready with WebGPU disabled", info.state === "ready", JSON.stringify(info));
  check("fell back to Lite/SigLIP2 on WASM (not the WebGPU-only LFM)",
    info.device === "wasm" && /lite|siglip2|B\/16/i.test(info.modelId || ""),
    `device=${info.device} model=${info.modelId} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // Real classify through the offscreen engine — an ad image must score as an ad.
  const res = await sw.evaluate((img) => new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: "minus-offscreen", type: "classify", images: [img] }, resolve);
  }), adPng);
  const p = res?.results?.[0]?.p_ad;
  check("WASM classify: ad image scored as an ad (p_ad >= 0.5)", typeof p === "number" && p >= 0.5, `p_ad=${p} err=${res?.results?.[0]?.error || ""}`);
  console.log("  classify result:", JSON.stringify(res?.results?.[0]));
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]);
  failures++;
} finally {
  await ctx.close();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall green");
process.exit(failures ? 1 : 0);
