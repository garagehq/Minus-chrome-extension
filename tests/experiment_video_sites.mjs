// Exploratory (NOT part of npm test): load the real extension + Iter 21-web
// model with WebGPU, then see how the video-ad path behaves on real sites.
// Baseline first (the controlled fixture, deterministic), then real video
// sites: dismiss consent, force playback, sample overlays for a window, and
// record whether the <video> player itself gets covered by a flashcard.
import { launchWithExtension, serveFixtures, waitForEngine, HERE } from "./harness.mjs";
import { mkdirSync } from "fs";
import { join } from "path";

const SHOTS = join(HERE, "screenshots", "video_sites");
mkdirSync(SHOTS, { recursive: true });

// A flashcard overlapping a <video> means the model flagged the frame as an ad.
async function probe(page) {
  return page.evaluate(() => {
    const ovs = [...document.querySelectorAll("[data-minus-overlay]")];
    const vids = [...document.querySelectorAll("video")].map((v) => v.getBoundingClientRect());
    const overlapsVideo = ovs.some((o) => {
      const r = o.getBoundingClientRect();
      return vids.some((v) => {
        const ix = Math.max(0, Math.min(r.right, v.right) - Math.max(r.left, v.left));
        const iy = Math.max(0, Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top));
        return ix * iy > 0.25 * Math.max(1, v.width * v.height); // >25% of the player
      });
    });
    return { overlays: ovs.length, videos: vids.length, videoCovered: overlapsVideo };
  });
}

async function dismissConsent(page) {
  // Best-effort: click a common consent/allow button in the page or any iframe.
  const re = /^(accept all|accept|i agree|agree|got it|allow all|reject all|no thanks|continue)$/i;
  for (const frame of page.frames()) {
    try {
      const btns = await frame.$$("button, [role=button], a");
      for (const b of btns) {
        const t = ((await b.innerText().catch(() => "")) || "").trim();
        if (re.test(t)) { await b.click({ timeout: 1500 }).catch(() => {}); return t; }
      }
    } catch {}
  }
  return null;
}

async function forcePlay(page) {
  await page.evaluate(() => {
    for (const v of document.querySelectorAll("video")) { v.muted = true; v.play?.().catch(() => {}); }
  }).catch(() => {});
  // A center click starts players that need a gesture.
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  await page.mouse.click(vp.width / 2, vp.height / 2).catch(() => {});
  await page.evaluate(() => { for (const v of document.querySelectorAll("video")) v.play?.().catch(() => {}); }).catch(() => {});
}

async function runSite(ctx, { name, url, windowMs = 45000 }) {
  const page = await ctx.newPage();
  const out = { name, url, loaded: false, videos: 0, maxOverlays: 0, videoCovered: false, note: "" };
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    out.loaded = true;
    await page.waitForTimeout(2500);
    out.consent = await dismissConsent(page);
    await page.waitForTimeout(1500);
    await forcePlay(page);

    const t0 = Date.now();
    let firstCoverShot = false;
    while (Date.now() - t0 < windowMs) {
      const s = await probe(page).catch(() => null);
      if (s) {
        out.videos = Math.max(out.videos, s.videos);
        out.maxOverlays = Math.max(out.maxOverlays, s.overlays);
        if (s.videoCovered) {
          out.videoCovered = true;
          if (!firstCoverShot) { firstCoverShot = true; await page.screenshot({ path: join(SHOTS, `${name}_covered.png`) }).catch(() => {}); }
        }
      }
      await page.waitForTimeout(2000);
    }
    await page.screenshot({ path: join(SHOTS, `${name}_final.png`), fullPage: false }).catch(() => {});
  } catch (e) {
    out.note = String(e).split("\n")[0];
  } finally {
    await page.close().catch(() => {});
  }
  return out;
}

const results = [];

const server = await serveFixtures();
const ctx = await launchWithExtension({ requireGpu: true });
try {
  console.log("loading engine (local Iter 21-web)...");
  const engine = await waitForEngine(ctx, 8 * 60 * 1000);
  console.log("engine ready:", JSON.stringify(engine));

  // --- Baseline: controlled fixture (20s program / 20s ad / 20s program) ------
  {
    const page = await ctx.newPage();
    await page.goto("http://127.0.0.1:8919/video.html", { waitUntil: "load" });
    let covered = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 48000) {
      const s = await probe(page);
      const vt = await page.evaluate(() => document.getElementById("player").currentTime);
      if (s.videoCovered && !covered) { covered = true; await page.screenshot({ path: join(SHOTS, "fixture_ad_covered.png") }); }
      if (vt >= 45) break;
      await page.waitForTimeout(1500);
    }
    results.push({ name: "LOCAL FIXTURE (baseline)", url: "video.html", videoCovered: covered, note: covered ? "ad break covered ✓" : "NOT covered" });
    await page.close();
  }

  // --- Real video sites -------------------------------------------------------
  const SITES = [
    { name: "dailymotion", url: "https://www.dailymotion.com/video/x8opxvz" }, // HTML5, pre-roll ads (non-DRM)
    { name: "aljazeera-live", url: "https://www.aljazeera.com/live/" },        // autoplay live video
    { name: "youtube", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ" },   // DRM — expect black frames
  ];
  for (const site of SITES) {
    console.log(`\n--- ${site.name} ---`);
    const r = await runSite(ctx, site);
    console.log(JSON.stringify(r));
    results.push(r);
  }
} finally {
  await ctx.close();
  server.close();
}

console.log("\n===== SUMMARY =====");
for (const r of results) {
  console.log(`${r.videoCovered ? "COVERED " : "no-cover"}  ${r.name.padEnd(26)} videos=${r.videos ?? "-"} maxOverlays=${r.maxOverlays ?? "-"} ${r.consent ? "consent:" + r.consent + " " : ""}${r.note || ""}`);
}
