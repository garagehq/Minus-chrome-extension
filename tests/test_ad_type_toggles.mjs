// Verifies (a) display/non-video ad blocking still works, and (b) the new
// Video/Display popup toggles actually gate each path in content.js.
// Fixtures: index.html (a static display ad #ad-img) and video.html (a stream
// with a 20s ad break).
import { launchWithExtension, serveFixtures, waitForEngine } from "./harness.mjs";

const server = await serveFixtures();
const ctx = await launchWithExtension();
let failures = 0;
const check = (name, cond, detail) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!cond) failures++; };

const set = (sw, v) => sw.evaluate((v) => chrome.storage.local.set(v), v);
const overlayCount = (page) => page.evaluate(() => document.querySelectorAll("[data-minus-overlay]").length);

try {
  await waitForEngine(ctx);
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 20000 });

  // --- A: display ads blocked by default (the "does non-video still work" check)
  await set(sw, { blockDisplay: true, blockVideo: true });
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:8919/", { waitUntil: "load" });
  await page.locator("[data-minus-overlay]").first().waitFor({ state: "visible", timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(4000);
  check("display ad IS covered by default", (await overlayCount(page)) >= 1, `overlays=${await overlayCount(page)}`);
  await page.close();

  // --- B: Display toggle OFF -> the same page shows no overlay
  await set(sw, { blockDisplay: false, blockVideo: true });
  const page2 = await ctx.newPage();
  await page2.goto("http://127.0.0.1:8919/", { waitUntil: "load" });
  await page2.waitForTimeout(15000); // give it several scan cycles
  check("Display toggle OFF -> display ad NOT covered", (await overlayCount(page2)) === 0, `overlays=${await overlayCount(page2)}`);
  await page2.close();

  // --- C: Video toggle OFF -> the ad-break video is not covered
  await set(sw, { blockDisplay: true, blockVideo: false });
  const page3 = await ctx.newPage();
  await page3.goto("http://127.0.0.1:8919/video.html", { waitUntil: "load" });
  let coveredDuringAd = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 50000) {
    const t = await page3.evaluate(() => document.getElementById("player")?.currentTime ?? 0);
    if (t > 20 && t < 42 && (await overlayCount(page3)) > 0) coveredDuringAd = true;
    if (t >= 46) break;
    await page3.waitForTimeout(1500);
  }
  check("Video toggle OFF -> video ad NOT covered", coveredDuringAd === false);
  await page3.close();
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]);
  failures++;
} finally {
  await ctx.close();
  server.close();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall green");
process.exit(failures ? 1 : 0);
