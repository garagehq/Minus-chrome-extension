// Direct engine probe: bypass the content script entirely.
import { launchWithExtension, serveFixtures, waitForEngine, HERE } from "./harness.mjs";
import { readFileSync } from "fs";
import { join } from "path";
const server = await serveFixtures();
const ctx = await launchWithExtension();
try {
  console.log("engine:", JSON.stringify(await waitForEngine(ctx)));
  const [sw] = ctx.serviceWorkers();
  const b64 = "data:image/png;base64," + readFileSync(join(HERE, "fixtures", "ad1.png")).toString("base64");
  const r = await sw.evaluate(async (img) => {
    return await new Promise((res) => chrome.runtime.sendMessage(
      { target: "minus-offscreen", type: "classify", images: [img] }, res));
  }, b64);
  console.log("direct classify:", JSON.stringify(r).slice(0, 400));

  // now check the content-script path on the fixture page
  const page = await ctx.newPage();
  page.on("console", (m) => console.log("[page]", m.text().slice(0, 200)));
  await page.goto("http://127.0.0.1:8919/");
  await page.waitForTimeout(15000);
  const state = await page.evaluate(() => ({
    overlays: document.querySelectorAll("[data-minus-overlay]").length,
    imgs: document.images.length,
  }));
  console.log("page state:", JSON.stringify(state));
} finally {
  await ctx.close();
  server.close();
}
