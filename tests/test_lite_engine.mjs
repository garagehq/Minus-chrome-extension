// Quick check: the 'lite' engine (ViT-B-16 ONNX) loads and classifies.
import { launchWithExtension, serveFixtures, waitForEngine } from "./harness.mjs";
const server = await serveFixtures();
const ctx = await launchWithExtension();
let fail = 0;
try {
  const [sw] = ctx.serviceWorkers();
  await sw.evaluate(() => chrome.storage.local.set({ engineKind: "lite" }));
  const info = await waitForEngine(ctx);
  console.log("engine:", JSON.stringify(info));
  const ok = info.modelId === "siglip2-b16-384-lite" && info.state === "ready";
  console.log(ok ? "PASS  lite engine loaded" : "FAIL  lite engine");
  if (!ok) fail++;
  // classify the ad fixture on a page
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:8919/", { waitUntil: "load" });
  const overlay = page.locator("[data-minus-overlay]");
  await overlay.first().waitFor({ state: "visible", timeout: 120000 });
  console.log("PASS  lite engine overlaid the ad");
} catch (e) {
  console.log("FAIL (exception)", String(e).split("\n")[0]); fail++;
} finally { await ctx.close(); server.close(); }
console.log(fail ? `${fail} failure(s)` : "all green");
process.exit(fail ? 1 : 0);
