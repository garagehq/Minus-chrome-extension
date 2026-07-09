// Prolonged real-world soak of v0.2.1 across video sites. NOT part of npm test.
// Loads the real extension + Iter 21-web (WebGPU), then dwells ~85s on each
// site: dismisses consent, forces playback, and every ~3s samples overlays
// ACROSS ALL FRAMES (all_frames now covers iframe players), recording whether a
// <video>/player gets covered and whether anything looks like a false positive.
// Screenshots at 3 points per site. Watches engine health + console errors the
// whole time.
import { launchWithExtension, waitForEngine, HERE } from "./harness.mjs";
import { mkdirSync } from "fs";
import { join } from "path";

const SHOTS = join(HERE, "screenshots", "soak_v2");
mkdirSync(SHOTS, { recursive: true });
const DWELL_MS = 85000;

const SITES = [
  { name: "weather-video", url: "https://weather.com/video" },       // reliable pre-roll (proven)
  { name: "aljazeera-live", url: "https://www.aljazeera.com/live/" }, // live player (proven)
  { name: "usatoday-video", url: "https://www.usatoday.com/media/latest/videos/" },
  { name: "foxnews-video", url: "https://www.foxnews.com/video" },
  { name: "youtube", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ" },
  { name: "nbcnews-video", url: "https://www.nbcnews.com/video" },
];

// Per-frame: overlays, videos, and whether any overlay overlaps any video in
// that frame (overlay + video share the frame's coordinate space).
async function probe(page) {
  let overlays = 0, players = 0, playerCovered = false, framesActive = 0;
  for (const f of page.frames()) {
    try {
      const r = await f.evaluate(() => {
        const ovs = [...document.querySelectorAll("[data-minus-overlay]")].map((o) => o.getBoundingClientRect());
        // A "player region" is a <video> OR a large iframe (cross-origin players
        // expose no <video> to the parent — a top-frame overlay covers the iframe).
        const regions = [
          ...[...document.querySelectorAll("video")].map((v) => v.getBoundingClientRect()).filter((v) => v.width > 40 && v.height > 40),
          ...[...document.querySelectorAll("iframe")].map((v) => v.getBoundingClientRect()).filter((v) => v.width >= 300 && v.height >= 150),
        ];
        const covers = ovs.some((o) => regions.some((v) => {
          const ix = Math.max(0, Math.min(o.right, v.right) - Math.max(o.left, v.left));
          const iy = Math.max(0, Math.min(o.bottom, v.bottom) - Math.max(o.top, v.top));
          return ix * iy > 0.25 * Math.max(1, v.width * v.height);
        }));
        return { o: ovs.length, v: regions.length, covers };
      });
      overlays += r.o; players += r.v; if (r.covers) playerCovered = true; if (r.o > 0) framesActive++;
    } catch { /* frame navigated/detached */ }
  }
  return { overlays, players, playerCovered, framesActive };
}

async function dismissConsent(page) {
  const re = /^(accept all|accept|i agree|agree|got it|allow all|reject all|no thanks|continue|yes, i'?m happy|consent)$/i;
  for (const frame of page.frames()) {
    try {
      for (const b of await frame.$$("button, [role=button], a")) {
        const t = ((await b.innerText().catch(() => "")) || "").trim();
        if (re.test(t)) { await b.click({ timeout: 1200 }).catch(() => {}); }
      }
    } catch {}
  }
}

async function forcePlay(page) {
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(() => {
        for (const v of document.querySelectorAll("video")) { v.muted = true; v.play?.().catch(() => {}); }
        // click common play-button affordances to start players that need a gesture
        const sel = '[aria-label*="play" i],[title*="play" i],.play,.play-button,.ytp-large-play-button,.vjs-big-play-button,button[class*="play" i]';
        for (const b of document.querySelectorAll(sel)) { try { b.click(); } catch {} }
      });
    } catch {}
  }
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  await page.mouse.click(vp.width / 2, vp.height * 0.4).catch(() => {});
}

async function engineInfo(sw) {
  return sw.evaluate(async () => {
    try {
      const { engineKind = "lfm" } = await chrome.storage.local.get({ engineKind: "lfm" });
      const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind }, res));
      return r?.info || { state: "?" };
    } catch (e) { return { state: "swerr", error: String(e) }; }
  }).catch(() => ({ state: "unreachable" }));
}

const ctx = await launchWithExtension({ requireGpu: true });
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 60000 });
const results = [];

try {
  console.log("loading engine…");
  console.log("engine:", JSON.stringify(await waitForEngine(ctx, 8 * 60 * 1000)));

  for (const site of SITES) {
    console.log(`\n===== ${site.name} =====`);
    const page = await ctx.newPage();
    let consoleErrors = 0;
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR|status of 4|status of 5/.test(m.text())) consoleErrors++; });
    const out = { name: site.name, loaded: false, players: 0, maxOverlays: 0, playerCovered: false, coverTicks: 0, ticks: 0, engineEnd: "", consoleErrors: 0, note: "" };
    try {
      await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 45000 });
      out.loaded = true;
      await page.waitForTimeout(3000);
      await dismissConsent(page);
      await page.waitForTimeout(1500);
      await forcePlay(page);

      const t0 = Date.now();
      let shotIdx = 0;
      const shotAt = [15000, 45000, 78000];
      while (Date.now() - t0 < DWELL_MS) {
        const s = await probe(page);
        out.ticks++;
        out.players = Math.max(out.players, s.players);
        out.maxOverlays = Math.max(out.maxOverlays, s.overlays);
        if (s.playerCovered) { out.playerCovered = true; out.coverTicks++; }
        const elapsed = Date.now() - t0;
        if (shotIdx < shotAt.length && elapsed > shotAt[shotIdx]) {
          await page.screenshot({ path: join(SHOTS, `${site.name}_${shotIdx}.png`) }).catch(() => {});
          shotIdx++;
        }
        if (out.ticks % 6 === 0) await forcePlay(page); // keep it playing through mid-rolls
        await page.waitForTimeout(3000);
      }
      out.consoleErrors = consoleErrors;
      out.engineEnd = (await engineInfo(sw)).state;
    } catch (e) {
      out.note = String(e).split("\n")[0];
    } finally {
      await page.close().catch(() => {});
    }
    console.log(JSON.stringify(out));
    results.push(out);
  }
} finally {
  const finalEngine = await engineInfo(sw);
  await ctx.close();
  console.log("\n===== SUMMARY =====");
  for (const r of results) {
    console.log(`${r.playerCovered ? "COVERED " : "no-cover"} ${r.name.padEnd(16)} players=${r.players} maxOv=${r.maxOverlays} coverTicks=${r.coverTicks}/${r.ticks} engine=${r.engineEnd} errs=${r.consoleErrors} ${r.note}`);
  }
  console.log("final engine state:", JSON.stringify(finalEngine));
}
