// E2E for the all_frames iframe video work:
//   #1 same-origin embedded player  -> the in-frame content script covers the
//      <video> during the ad break (overlay appears INSIDE the iframe).
//   #2 cross-origin iframe, tainted stream (inner script can't read it) -> the
//      top-frame motion sampler covers the iframe during the ad break.
// stream.webm timeline: 20s program / 20s AD / 20s program.
import { launchWithExtension, serveFixtures, waitForEngine, HERE } from "./harness.mjs";
import { mkdirSync } from "fs";
import { join } from "path";

const AD_LO = 18, AD_HI = 46;
const server = await serveFixtures();
const ctx = await launchWithExtension();
mkdirSync(join(HERE, "screenshots"), { recursive: true });

let failures = 0;
const check = (name, cond, detail) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!cond) failures++; };

// Poll for ~55s; return {covered, coveredT} where covered means the target
// frame showed a minus overlay while the stream was in its ad window.
async function watch(page, url, getVideoFrame, getOverlayCount, shot) {
  await page.goto(url, { waitUntil: "load" });
  let covered = false, coveredT = null, sawProgram = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 58000) {
    const vf = getVideoFrame();
    const t = vf ? await vf.evaluate(() => (document.querySelector("video")?.currentTime ?? 0)).catch(() => 0) : 0;
    const n = await getOverlayCount().catch(() => 0);
    if (n > 0 && t > AD_LO && t < AD_HI) { if (!covered) { covered = true; coveredT = t; await page.screenshot({ path: join(HERE, "screenshots", shot) }).catch(() => {}); } }
    if (n === 0 && t > 50) sawProgram = true; // cleared after the ad
    if (t >= 55) break;
    await page.waitForTimeout(1500);
  }
  return { covered, coveredT, sawProgram };
}

const childFrame = (page, needle) => page.frames().find((f) => f !== page.mainFrame() && f.url().includes(needle));

try {
  console.log("loading engine…");
  console.log("engine:", JSON.stringify(await waitForEngine(ctx, 8 * 60 * 1000)));

  // --- #1 same-origin embedded player ---------------------------------------
  {
    const page = await ctx.newPage();
    const r = await watch(
      page,
      "http://127.0.0.1:8919/iframe_video.html",
      () => childFrame(page, "video.html"),
      async () => { const f = childFrame(page, "video.html"); return f ? f.evaluate(() => document.querySelectorAll("[data-minus-overlay]").length) : 0; },
      "iframe_same_origin_covered.png",
    );
    check("#1 same-origin: in-frame overlay covers the player during the ad", r.covered, `t=${r.coveredT?.toFixed?.(1)}`);
    await page.close();
  }

  // --- #2 cross-origin iframe, tainted stream -------------------------------
  {
    const page = await ctx.newPage();
    const r = await watch(
      page,
      "http://127.0.0.1:8919/iframe_xorigin.html",
      () => childFrame(page, "video_remote.html"),
      async () => page.mainFrame().evaluate(() => document.querySelectorAll("[data-minus-overlay]").length),
      "iframe_cross_origin_covered.png",
    );
    check("#2 cross-origin: top-frame sampler covers the iframe during the ad", r.covered, `t=${r.coveredT?.toFixed?.(1)}`);
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
