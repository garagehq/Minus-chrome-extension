// Is it the extension flags, or the engine warm-up racing the probe?
import { chromium } from "playwright";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { rmSync } from "fs";
const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "extension");
const GPU_FLAGS = ["--no-sandbox","--enable-unsafe-webgpu","--ignore-gpu-blocklist","--use-angle=vulkan","--enable-features=Vulkan","--disable-vulkan-surface","--disable-gpu-shader-disk-cache"];
async function probe(args, profile) {
  rmSync(profile, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, args });
  const page = await ctx.newPage();
  await page.goto("https://example.com");
  const r = await page.evaluate(async () => {
    if (!navigator.gpu) return "no navigator.gpu";
    const a = await navigator.gpu.requestAdapter();
    return a ? `${a.info?.vendor}/${a.info?.architecture}` : "null adapter";
  });
  await ctx.close();
  return r;
}
for (let i = 0; i < 3; i++)
  console.log("no-ext   :", await probe(GPU_FLAGS, "/tmp/minus-p1"));
for (let i = 0; i < 3; i++)
  console.log("with-ext :", await probe([...GPU_FLAGS, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`], "/tmp/minus-p2"));
