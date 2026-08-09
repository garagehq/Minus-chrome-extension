// Real-YouTube ad-blocking test (headed, Xvfb). Loads real watch pages, plays
// them, and checks: (1) when a real pre-roll/mid-roll ad plays the PLAYER gets
// covered (a video-kind overlay over the player), (2) when the ad ends or is
// skipped, the overlay RECOVERS (uncovers) — no stuck overlay on content.
//
// YouTube ads are non-deterministic, so this loads many videos and asserts the
// RECOVERY invariant on every ad that did get covered (the property that matters),
// plus that coverage triggered on at least some. Screenshots saved for review.
//   DISPLAY=:99 node tests/e2e_youtube.mjs [nVideos]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "extension");
const OUT = join(HERE, "screenshots", "youtube");
mkdirSync(OUT, { recursive: true });
const N = parseInt(process.argv[2] || "10", 10);

let fails = 0, passes = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  — ${d}`}`); c ? passes++ : fails++; };
const log = (m) => console.log(`      ${m}`);

// seed of popular, ad-heavy content (music videos / big channels get pre-rolls
// most often); for larger N we harvest more real watch IDs from YouTube itself.
let VIDEOS = [
  "dQw4w9WgXcQ", "kJQP7kiw5Fk", "9bZkp7q19f0", "OPf0YbXqDm0", "fJ9rUzIMcZQ",
  "hTWKbfoikeg", "YQHsXMglC9A", "CevxZvSJLk8", "JGwWNGJdvx8", "RgKAFK5djSk",
  "pRpeEdMmmQ0", "2Vv-BfVoq4g", "e-ORhEE9VVg", "tvTRZJ-4EyI", "60ItHLz5WEA",
];

const GPU = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface", "--no-sandbox", "--autoplay-policy=no-user-gesture-required"];
let ctx;
async function engineState() {
  return Promise.race([
    (async () => { const s = ctx.serviceWorkers()[0]; if (!s) return "no-sw";
      try { return await s.evaluate(async () => { const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind: "lfm" }, res)); return r?.info?.state || "?"; }); } catch { return "err"; } })(),
    new Promise((r) => setTimeout(() => r("timeout"), 8000)),
  ]);
}
{
  let ready = false;
  for (let a = 1; a <= 4 && !ready; a++) {
    ctx = await chromium.launchPersistentContext(join(HERE, ".profile-yt"), {
      channel: "chromium", headless: false, viewport: { width: 1440, height: 900 },
      args: [...GPU, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 60000 });
    await sw.evaluate((c) => chrome.storage.local.set(c), { enabled: true, blockVideo: true, blockDisplay: true, disabledSites: [], pausedUntil: 0 });
    const t0 = Date.now(); let st = "";
    while (Date.now() - t0 < 100000) { st = await engineState(); if (st === "ready") { ready = true; break; } if (st === "error") break; await new Promise((r) => setTimeout(r, 3000)); }
    console.log(`      launch ${a}: engine ${st}`);
    if (!ready) { await ctx.close().catch(() => {}); await new Promise((r) => setTimeout(r, 2000)); }
  }
  ok("engine ready (headed WebGPU)", ready);
  if (!ready) { await ctx.close().catch(() => {}); process.exit(1); }
}

// overlays covering the video player specifically (kind=video, or a display
// overlay whose box overlaps the player rect)
async function playerOverlays(pg) {
  // Count only overlays actually OVER THE PLAYER — an overlay whose CENTER is
  // inside the player rect and that covers a big fraction of it. Sidebar/below
  // display ads (legit, and independent of the player) must not count, or a
  // recovered player looks "stuck" just because a sidebar ad is still covered.
  return pg.evaluate(() => {
    const v = document.querySelector("video");
    const vr = v && v.getBoundingClientRect();
    if (!vr || vr.width < 200) return 0;
    let n = 0;
    for (const o of document.querySelectorAll("[data-minus-overlay]")) {
      const r = o.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const centerInPlayer = cx > vr.left && cx < vr.right && cy > vr.top && cy < vr.bottom;
      const bigOnPlayer = r.width > vr.width * 0.5 && r.height > vr.height * 0.5;
      if (centerInPlayer && bigOnPlayer) n++;
    }
    return n;
  }).catch(() => -1);
}
const adShowing = (pg) => pg.evaluate(() => !!document.querySelector(".ad-showing, .ytp-ad-player-overlay, .ytp-ad-module, .ytp-ad-text")).catch(() => false);
const trySkip = (pg) => pg.evaluate(() => { const b = document.querySelector(".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button"); if (b) { b.click(); return true; } return false; }).catch(() => false);

// Harvest real watch IDs from YouTube for larger runs (variety > a hardcoded list).
if (N > VIDEOS.length) {
  const hp = await ctx.newPage();
  for (const url of ["https://www.youtube.com/", "https://www.youtube.com/feed/trending", "https://www.youtube.com/gaming", "https://www.youtube.com/feed/music", "https://www.youtube.com/results?search_query=music+2024"]) {
    if (VIDEOS.length >= N + 10) break;
    try {
      await hp.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await hp.waitForTimeout(2500);
      for (let s = 0; s < 4; s++) { await hp.evaluate(() => window.scrollBy(0, 2000)).catch(() => {}); await hp.waitForTimeout(1200); }
      const ids = await hp.evaluate(() => [...document.querySelectorAll('a[href*="/watch?v="]')].map((a) => { const m = a.href.match(/[?&]v=([\w-]{11})/); return m ? m[1] : null; }).filter(Boolean));
      for (const id of ids) if (!VIDEOS.includes(id)) VIDEOS.push(id);
    } catch {}
  }
  await hp.close().catch(() => {});
  log(`harvested ${VIDEOS.length} candidate video ids`);
}
VIDEOS = VIDEOS.slice(0, N);

let covered = 0, recovered = 0, adsSeen = 0, engineErr = 0, stuckOnContent = 0;
for (const id of VIDEOS) {
  const pg = await ctx.newPage();
  try {
    await pg.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await pg.bringToFront();
    // dismiss a consent wall if present, then make sure it's playing muted
    await pg.evaluate(() => { for (const b of document.querySelectorAll("button")) { const t = (b.textContent || "").toLowerCase(); if (t.includes("accept") || t.includes("agree") || t.includes("reject all")) { b.click(); break; } } }).catch(() => {});
    await pg.waitForTimeout(2500);
    await pg.evaluate(() => { const v = document.querySelector("video"); if (v) { v.muted = true; v.play().catch(() => {}); } }).catch(() => {});

    // watch up to ~30s for an ad to appear + get covered (pre-rolls show early)
    let sawAd = false, gotCovered = false;
    for (let i = 0; i < 12; i++) {
      if (await adShowing(pg)) sawAd = true;
      if ((await playerOverlays(pg)) > 0) { gotCovered = true; break; }
      // no ad by ~18s and none showing → this video isn't serving one; move on
      if (i >= 7 && !sawAd) break;
      await pg.waitForTimeout(2500);
    }
    if (sawAd) adsSeen++;
    if (gotCovered) {
      covered++;
      await pg.screenshot({ path: join(OUT, `${id}_covered.png`) }).catch(() => {});
      log(`${id}: ad covered ✓ — waiting for recovery`);
      // YouTube video frames are DIRECTLY readable here (not DRM-tainted), so the
      // model re-reads the real decoded frame every tick and clears the cover the
      // moment content resumes. A cover that persists therefore means a REAL ad is
      // still on screen. Unskippable YouTube ads run up to ~30-60s (occasionally a
      // 2-ad break), so give real ads time to finish while spamming Skip. Only a
      // cover that outlasts a generous window AND coincides with the player reading
      // content (low live p_ad) is a true content-stuck bug.
      let cleared = false;
      for (let i = 0; i < 56; i++) { // up to ~140s: outlasts any real YT ad break
        await trySkip(pg);
        if ((await playerOverlays(pg)) === 0) { cleared = true; break; }
        await pg.waitForTimeout(2500);
      }
      if (cleared) { recovered++; log(`${id}: RECOVERED — overlay cleared after ad`); }
      else {
        // Still covered after ~140s of skip-spam. YouTube frames are directly
        // readable here, so the model re-reads content every tick and clears the
        // cover the moment the ad ends — a cover that outlasts a window longer
        // than any real YT ad break therefore points at a stuck overlay. Capture
        // it for review (the overlay's block-time p_ad is a weak hint).
        const overlays = await pg.evaluate(() => [...document.querySelectorAll("[data-minus-overlay]")].map((o) => ({ k: o.dataset.minusKind, p: o.dataset.minusP }))).catch(() => null);
        stuckOnContent++;
        log(`${id}: STILL COVERED after 140s — overlays=${JSON.stringify(overlays)} (inspect ${id}_STUCK.png: real long ad vs content)`);
        await pg.screenshot({ path: join(OUT, `${id}_STUCK.png`) }).catch(() => {});
      }
    } else {
      log(`${id}: no ad covered in window (adShowing seen=${sawAd})`);
    }
  } catch (e) { log(`${id}: FAIL ${String(e).split("\n")[0]}`); }
  finally { await pg.close().catch(() => {}); }
  const st = await engineState(); if (st !== "ready") engineErr++;
  const done = VIDEOS.indexOf(id) + 1;
  if (done % 10 === 0) log(`  --- ${done}/${VIDEOS.length}: covered=${covered} recovered=${recovered} adsSeen=${adsSeen} engineErr=${engineErr} ---`);
}

log(`videos=${VIDEOS.length}, adsSeen(page)=${adsSeen}, playerCovered=${covered}, recovered=${recovered}, stillCovered=${stuckOnContent}, engine-not-ready=${engineErr}`);
ok("engine stayed healthy across all videos", engineErr === 0, `${engineErr} not-ready`);
// Ship invariant: every player covered by a real ad UNCOVERS once the ad ends.
// The 140s window outlasts any real YouTube ad break, and frames are directly
// readable so the model self-clears on content — so a still-covered player after
// the window is a stuck overlay (bug), captured as *_STUCK.png for review.
ok("every covered YouTube ad RECOVERED (no stuck overlays on content)", stuckOnContent === 0, `${stuckOnContent} still covered after 140s — inspect *_STUCK.png`);
ok("ad blocking actually triggered on real YouTube ads", covered > 0, "no player ad was covered — check ad delivery / video-sampler path");
writeFileSync(join(OUT, "summary.json"), JSON.stringify({ passes, fails, videos: VIDEOS.length, adsSeen, covered, recovered, stillCovered: stuckOnContent, engineErr }, null, 1));
await ctx.close().catch(() => {});
console.log(fails ? `\n${fails} FAILURE(S)  (${passes} passed)` : `\nyoutube e2e green (${passes} passed)`);
process.exit(fails ? 1 : 0);
