import { chromium } from "playwright";
import { rmSync } from "fs";
rmSync("/tmp/minus-p3", { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext("/tmp/minus-p3", {
  channel: "chromium", headless: true,
  args: ["--no-sandbox","--enable-unsafe-webgpu","--ignore-gpu-blocklist","--use-angle=vulkan","--enable-features=Vulkan","--disable-vulkan-surface","--disable-gpu-shader-disk-cache","--enable-logging=stderr","--v=1"],
});
const page = await ctx.newPage();
await page.goto("https://example.com");
const r = await page.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter();
  return a ? `${a.info?.vendor}` : "null";
});
console.log("adapter:", r);
await ctx.close();
