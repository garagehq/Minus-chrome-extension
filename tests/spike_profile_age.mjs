import { chromium } from "playwright";
import { rmSync } from "fs";
const FLAGS = ["--no-sandbox","--enable-unsafe-webgpu","--ignore-gpu-blocklist","--use-angle=vulkan","--enable-features=Vulkan","--disable-vulkan-surface","--disable-gpu-shader-disk-cache"];
async function probe(profile) {
  const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, args: FLAGS });
  const page = await ctx.newPage();
  await page.goto("https://example.com");
  const r = await page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter();
    return a ? (a.info?.vendor || "?") : "null";
  });
  await ctx.close();
  return r;
}
rmSync("/home/ubuntu/.cache/minus-page-test", { recursive: true, force: true });
console.log("fresh profile, run 1:", await probe("/home/ubuntu/.cache/minus-page-test"));
console.log("same profile,  run 2:", await probe("/home/ubuntu/.cache/minus-page-test"));
console.log("same profile,  run 3:", await probe("/home/ubuntu/.cache/minus-page-test"));
