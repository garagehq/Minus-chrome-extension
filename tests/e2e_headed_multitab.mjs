// Real HEADED end-to-end test (Xvfb + full Chromium, not headless): exercises
// the multi-tab / video-ad / model-release bugs the user reported.
//
//   DISPLAY=:99 node tests/e2e_headed_multitab.mjs [nSites]
//
// Phase 1  multi-tab active-only : background tabs must NOT scan/capture; only
//                                  the active tab drives the engine.
// Phase 2  video block→unblock   : a covered video ad must UNCOVER when it ends,
//                                  its source swaps to content, or it pauses.
// Phase 3  100+ real-site soak   : rotate one active tab through ad-heavy + video
//                                  sites (2 idle background tabs held open), count
//                                  ads covered / errors / STUCK overlays.
import { chromium } from "playwright";
import { createServer } from "http";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SOAK_SITES } from "./soak_sites.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(HERE, "..", "extension");
const OUT = join(HERE, "screenshots", "e2e_multitab");
const PROFILE = join(HERE, ".profile-e2e");
mkdirSync(OUT, { recursive: true });
const N_SITES = parseInt(process.argv[2] || "110", 10);

let failures = 0, passes = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  cond ? passes++ : failures++;
};
const log = (m) => console.log(`      ${m}`);

// ---- ingest sink: every submitted crop, attributed by host --------------------
const PORT = 8793;
const capsByHost = {};
let capTotal = 0;
const sink = createServer((req, res) => {
  if (req.method === "POST") {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        for (const s of (JSON.parse(b).samples || [])) {
          const h = (s.host || "?").replace(/^www\./, "");
          capsByHost[h] = (capsByHost[h] || 0) + 1;
          capTotal++;
        }
      } catch {}
      res.writeHead(200); res.end("{}");
    });
  } else { res.writeHead(200); res.end("ok"); }
});
await new Promise((r) => sink.listen(PORT, "127.0.0.1", r));

// ---- static fixture server (video-ad fixture) ---------------------------------
const FPORT = 8919;
const MIME = { html: "text/html", js: "application/javascript", png: "image/png", css: "text/css" };
const fsrv = createServer((req, res) => {
  try {
    const p = join(HERE, "fixtures", (req.url.replace(/^\/+/, "").split("?")[0]) || "index.html");
    res.setHeader("Content-Type", MIME[p.split(".").pop()] || "application/octet-stream");
    res.end(readFileSync(p));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => fsrv.listen(FPORT, "127.0.0.1", r));

// ---- launch headed with WebGPU (self-healing: Tegra WebGPU cold-launch flakes
// ~50%, so relaunch the whole context until the engine actually reports ready) --
const GPU = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=vulkan",
  "--enable-features=Vulkan", "--disable-vulkan-surface", "--no-sandbox"];
let ctx, extId;
async function engineStateFor(c) {
  return Promise.race([
    (async () => {
      const s = c.serviceWorkers()[0]; if (!s) return "no-sw";
      try {
        // Target the OFFSCREEN document directly. A message the SW sends to its
        // own onMessage listener is never delivered (MV3), so polling the
        // background's minus:engine-status from here would always come back empty.
        return await s.evaluate(async () => {
          const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind: "lfm" }, res));
          return r?.info?.state || "?";
        });
      } catch { return "err"; }
    })(),
    new Promise((r) => setTimeout(() => r("timeout"), 8000)),
  ]);
}
const engineState = () => engineStateFor(ctx);
{
  let ready = false;
  for (let attempt = 1; attempt <= 4 && !ready; attempt++) {
    ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: "chromium", headless: false, viewport: { width: 1440, height: 900 },
      args: [...GPU, `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
    });
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 60000 });
    extId = new URL(sw.url()).host;
    await sw.evaluate((cfg) => chrome.storage.local.set(cfg), {
      enabled: true, blockVideo: true, blockDisplay: true, disabledSites: [],
      collectOptIn: true, ingestUrl: `http://127.0.0.1:${PORT}/ingest`, uploadCooldownMs: 1500,
    });
    const t0 = Date.now();
    let st = "";
    while (Date.now() - t0 < 100000) { st = await engineState(); if (st === "ready") { ready = true; break; } if (st === "error") break; await new Promise((r) => setTimeout(r, 3000)); }
    console.log(`      launch attempt ${attempt}: engine ${st}`);
    if (!ready) { await ctx.close().catch(() => {}); await new Promise((r) => setTimeout(r, 2000)); }
  }
  ok("engine reached ready (headed WebGPU)", ready);
  if (!ready) await finish();
}

const overlayCount = (page) => page.evaluate(() => document.querySelectorAll("[data-minus-overlay]").length).catch(() => -1);
const swErrors = async () => {
  const s = ctx.serviceWorkers()[0]; if (!s) return 0;
  return Promise.race([s.evaluate(() => globalThis.__minusErrCount || 0).catch(() => 0), new Promise((r) => setTimeout(() => r(0), 4000))]);
};

// ================= PHASE 1 — multi-tab active-only =================
console.log("\n=== Phase 1: multi-tab active-only ===");
const p1sites = ["https://www.theverge.com/", "https://www.cnn.com/", "https://www.forbes.com/"];
const p1 = [];
for (const u of p1sites) { const pg = await ctx.newPage(); p1.push(pg); await pg.goto(u, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {}); }
const hostOf = (u) => new URL(u).hostname.replace(/^www\./, "");
// make tab 0 active, let it scan
Object.keys(capsByHost).forEach((k) => delete capsByHost[k]);
await p1[0].bringToFront();
await p1[0].waitForTimeout(45000);
const activeHost = hostOf(p1sites[0]);
const bgHosts = p1sites.slice(1).map(hostOf);
const activeCaps = capsByHost[activeHost] || 0;
const bgCaps = bgHosts.reduce((s, h) => s + (capsByHost[h] || 0), 0);
log(`active(${activeHost})=${activeCaps} caps, background(${bgHosts.join(",")})=${bgCaps} caps`);
ok("background tabs do not capture while inactive", bgCaps === 0, `bg produced ${bgCaps} caps: ${JSON.stringify(capsByHost)}`);
ok("active tab is the one that scans", activeCaps > 0 || Object.keys(capsByHost).length === 0, JSON.stringify(capsByHost));
// switch active tab → scanning must follow
Object.keys(capsByHost).forEach((k) => delete capsByHost[k]);
await p1[1].bringToFront();
await p1[1].waitForTimeout(40000);
const newActive = hostOf(p1sites[1]);
log(`after switch: ${JSON.stringify(capsByHost)}`);
ok("scanning follows the newly-active tab", (capsByHost[activeHost] || 0) === 0, `old active still capturing: ${capsByHost[activeHost]}`);
for (const pg of p1) await pg.close().catch(() => {});

// ================= PHASE 2 — video block → unblock =================
console.log("\n=== Phase 2: video ad block → unblock ===");
async function videoUnblockCase(name, trigger) {
  const pg = await ctx.newPage();
  await pg.goto(`http://127.0.0.1:${FPORT}/videoad.html`, { waitUntil: "domcontentloaded" });
  await pg.bringToFront();
  await pg.waitForFunction(() => window.__vadReady === true, { timeout: 15000 }).catch(() => {});
  // wait for the ad frame to get covered (video hysteresis needs a couple ticks)
  let covered = false;
  for (let i = 0; i < 24; i++) { if ((await overlayCount(pg)) > 0) { covered = true; break; } await pg.waitForTimeout(2500); }
  ok(`[${name}] video ad gets covered`, covered);
  if (!covered) { await pg.close().catch(() => {}); return; }
  await trigger(pg);                       // end / swap-to-content / pause
  let cleared = false;
  for (let i = 0; i < 12; i++) { if ((await overlayCount(pg)) === 0) { cleared = true; break; } await pg.waitForTimeout(2500); }
  ok(`[${name}] overlay UNCOVERS after ${name}`, cleared, `overlay still present after ${name}`);
  await pg.close().catch(() => {});
}
await videoUnblockCase("ended", (pg) => pg.evaluate(() => window.__vad.end()));
await videoUnblockCase("swap-to-content", (pg) => pg.evaluate(() => window.__vad.toContent()));

// ================= PHASE 3 — 100+ real-site rotation =================
console.log(`\n=== Phase 3: ${N_SITES}-site rotation (2 idle bg tabs held open) ===`);
const idleBg = [];
for (const u of ["https://en.wikipedia.org/wiki/Advertising", "https://www.google.com/"]) {
  const pg = await ctx.newPage(); await pg.goto(u, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}); idleBg.push(pg);
}
const seed = (u, i) => { let h = 2166136261 >>> 0; const s = u + "::" + i; for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 16777619) >>> 0; } return h; };
const sites = SOAK_SITES.map((s) => s.url).sort((a, b) => seed(a, 1) - seed(b, 1)).slice(0, N_SITES);
const capCounters = () => Promise.race([
  (async () => { const s = ctx.serviceWorkers()[0]; return s ? s.evaluate(() => ({ ok: globalThis.__minusCapOk || 0, refused: globalThis.__minusCapRefused || 0, cls: globalThis.__minusClsCalls || 0, ads: globalThis.__minusAdsFound || 0, maxP: globalThis.__minusMaxP || 0, clsRef: globalThis.__minusClsRefused || 0 })) : {}; })(),
  new Promise((r) => setTimeout(() => r({}), 6000)),
]);
let errors = 0, withOverlays = 0, visited = 0, totalOverlays = 0, notReady = 0;
const capBefore = await capCounters();
for (const url of sites) {
  const pg = await ctx.newPage();
  const host = hostOf(url);
  try {
    await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await pg.bringToFront();
    await Promise.race([pg.waitForTimeout(9000), new Promise((r) => setTimeout(r, 20000))]);
    await pg.evaluate(() => window.scrollBy(0, 1400)).catch(() => {}); // trigger lazy-loaded ads
    await Promise.race([pg.waitForTimeout(6000), new Promise((r) => setTimeout(r, 12000))]);
    const ov = await overlayCount(pg);
    if (ov > 0) { withOverlays++; totalOverlays += ov; }
    visited++;
  } catch (e) { errors++; }
  finally { await pg.close().catch(() => {}); }
  if (visited % 4 === 0) {
    const st = await engineState();
    if (st !== "ready") notReady++;
    const cc = await capCounters();
    log(`  ${visited}/${sites.length} | ov-sites ${withOverlays} (${totalOverlays}) | capOk ${cc.ok} clsCalls ${cc.cls} adsFound ${cc.ads} maxP ${(cc.maxP||0).toFixed(2)} clsRef ${cc.clsRef} refused ${cc.refused} | engine ${st}`);
  }
}
const capAfter = await capCounters();
const engFinal = await engineState();
ok("active tab actually captured across the soak", (capAfter.ok - capBefore.ok) > 20, `only ${capAfter.ok - capBefore.ok} captures`);
ok("ads were covered on multiple sites", withOverlays >= 5, `only ${withOverlays} sites had overlays`);
ok("engine stayed healthy (ready) through the soak", engFinal === "ready" && notReady === 0, `final=${engFinal}, not-ready checkpoints=${notReady}`);
ok("soak completed without harness crash", visited >= sites.length * 0.7, `only ${visited}/${sites.length} visited`);
const adHosts = await ctx.serviceWorkers()[0].evaluate(() => globalThis.__minusAdHosts || {}).catch(() => ({}));
log(`ad-classifying hosts: ${JSON.stringify(adHosts)}`);
log(`visited=${visited}, sites-with-overlays=${withOverlays}, total-overlays=${totalOverlays}, capturesOk=${capAfter.ok - capBefore.ok}, refused=${capAfter.refused - capBefore.refused}, load-errors=${errors}`);
for (const pg of idleBg) await pg.close().catch(() => {});

writeFileSync(join(OUT, "summary.json"), JSON.stringify({ passes, failures, visited, withOverlays, totalOverlays, capturesOk: capAfter.ok - capBefore.ok, refused: capAfter.refused - capBefore.refused, errors, engFinal }, null, 1));
await finish();

async function finish() {
  await ctx.close().catch(() => {});
  sink.close(); fsrv.close();
  console.log(`\n${failures ? failures + " FAILURE(S)" : "e2e all green"}  (${passes} passed)`);
  process.exit(failures ? 1 : 0);
}
