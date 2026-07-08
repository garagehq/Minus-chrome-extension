// Edge cases: shadow-DOM ad slots, high-DPR crop alignment, per-site disable.
import { launchWithExtension, serveFixtures, waitForEngine, HERE } from "./harness.mjs";
import { mkdirSync } from "fs";
import { join } from "path";

const server = await serveFixtures();
const ctx = await launchWithExtension();
mkdirSync(join(HERE, "screenshots"), { recursive: true });

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
};

try {
  await waitForEngine(ctx);
  const [sw] = ctx.serviceWorkers();

  // --- shadow DOM: ad inside an open shadow root gets found and covered
  {
    const page = await ctx.newPage();
    await page.goto("http://127.0.0.1:8919/shadow.html", { waitUntil: "load" });
    const overlay = page.locator("[data-minus-overlay]");
    await overlay.first().waitFor({ state: "visible", timeout: 180000 });
    const [ad, ov] = await Promise.all([
      page.evaluate(() => {
        const r = document.getElementById("host").shadowRoot
          .getElementById("shadow-ad").getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
      overlay.first().boundingBox(),
    ]);
    check("shadow-DOM ad found and covered",
      Math.abs(ad.x - ov.x) < 8 && Math.abs(ad.y - ov.y) < 8 &&
      Math.abs(ad.width - ov.width) < 16);
    await page.screenshot({ path: join(HERE, "screenshots", "edge_shadow.png") });
    await page.close();
  }

  // --- high-DPR: emulate deviceScaleFactor 2 via CDP, crop must still align
  {
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 800, deviceScaleFactor: 2, mobile: false,
    });
    await page.goto("http://127.0.0.1:8919/", { waitUntil: "load" });
    const overlay = page.locator("[data-minus-overlay]");
    await overlay.first().waitFor({ state: "visible", timeout: 180000 });
    await page.waitForTimeout(6000);
    const n = await overlay.count();
    const [ad, ov] = await Promise.all([
      page.locator("#ad-img").boundingBox(),
      overlay.first().boundingBox(),
    ]);
    check("DPR=2: exactly one overlay, aligned on the ad",
      n === 1 && Math.abs(ad.x - ov.x) < 8 && Math.abs(ad.y - ov.y) < 8);
    await page.close();
  }

  // --- per-site disable: host in disabledSites => no overlays at all
  {
    await sw.evaluate(() => chrome.storage.local.set({ disabledSites: ["127.0.0.1"] }));
    const page = await ctx.newPage();
    await page.goto("http://127.0.0.1:8919/", { waitUntil: "load" });
    await page.waitForTimeout(12000);
    check("per-site disable: no overlays on disabled host",
      (await page.locator("[data-minus-overlay]").count()) === 0);
    await sw.evaluate(() => chrome.storage.local.set({ disabledSites: [] }));
    await page.close();
  }
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]);
  failures++;
} finally {
  await ctx.close();
  server.close();
}
console.log(failures ? `\n${failures} failure(s)` : "\nall green");
process.exit(failures ? 1 : 0);
