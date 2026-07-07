// E2E: the minus-device behavior on streams — a 60s video with a 20s ad
// break in the middle (20s program / 20s ad / 20s program). The overlay
// must appear during the ad break and clear after it, driven by periodic
// sampling + 2-verdict hysteresis.
import { launchWithExtension, serveFixtures, waitForEngine, HERE } from "./harness.mjs";
import { mkdirSync } from "fs";
import { join } from "path";

const AD_START = 20, AD_END = 40; // seconds in stream.webm

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
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:8919/video.html", { waitUntil: "load" });

  // record (videoTime, overlayVisible) once a second until the video ends
  const timeline = [];
  let shotDuringAd = false;
  for (;;) {
    const s = await page.evaluate(() => ({
      t: document.getElementById("player").currentTime,
      ended: document.getElementById("player").ended,
      overlay: !!document.querySelector("[data-minus-overlay]"),
    }));
    timeline.push(s);
    if (s.overlay && s.t > AD_START && s.t < AD_END && !shotDuringAd) {
      shotDuringAd = true;
      await page.screenshot({ path: join(HERE, "screenshots", "video_ad_blocked.png") });
    }
    if (s.ended || s.t >= 59.5) break;
    await page.waitForTimeout(1000);
  }

  const overlaidAt = timeline.filter((s) => s.overlay).map((s) => s.t);
  const clean = (lo, hi) => timeline.filter((s) => s.t >= lo && s.t < hi).every((s) => !s.overlay);

  // Generous windows: sampling every 2.5s + 2-vote hysteresis needs ~5-8s to flip.
  check("no overlay during opening program (t < 18)", clean(0, 18));
  check("overlay appears during ad break", overlaidAt.some((t) => t > AD_START && t < AD_END + 2));
  check("overlay clears after ad break (t > 52)", clean(52, 60));
  console.log("overlay active at t =", overlaidAt.map((t) => t.toFixed(0)).join(", ") || "(never)");
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]);
  failures++;
} finally {
  await ctx.close();
  server.close();
}
console.log(failures ? `\n${failures} failure(s)` : "\nall green");
process.exit(failures ? 1 : 0);
