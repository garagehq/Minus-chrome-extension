// Spike: is WebGPU available in this machine's (headless) chromium,
// and what adapter do we get? Tries a few flag combinations.
import { chromium } from "playwright";

const FLAG_SETS = [
  ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
  ["--enable-unsafe-webgpu", "--use-angle=vulkan", "--enable-features=Vulkan"],
  ["--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader"],
  ["--enable-unsafe-webgpu", "--use-angle=swiftshader", "--use-webgpu-adapter=swiftshader"],
];

for (const flags of FLAG_SETS) {
  for (const headless of [true, false]) {
    let browser;
    try {
      browser = await chromium.launch({ headless, args: flags });
      const page = await browser.newPage();
      const info = await page.evaluate(async () => {
        if (!navigator.gpu) return { gpu: false };
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return { gpu: true, adapter: null };
        const ai = adapter.info || {};
        return {
          gpu: true,
          adapter: { vendor: ai.vendor, architecture: ai.architecture, description: ai.description },
          f16: adapter.features.has("shader-f16"),
        };
      });
      console.log(`headless=${headless} flags=[${flags.join(" ")}]`);
      console.log("  ->", JSON.stringify(info));
    } catch (e) {
      console.log(`headless=${headless} flags=[${flags.join(" ")}] -> LAUNCH FAIL: ${String(e).split("\n")[0]}`);
    } finally {
      await browser?.close();
    }
  }
}
