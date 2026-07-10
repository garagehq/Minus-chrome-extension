// ~50-minute stability + behavior soak on ONE long-lived browser/engine.
// Cycles a diverse site set many times, watching for: OUR extension errors,
// page crashes, engine degradation, and false positives (shopping/control pages
// should stay uncovered). Writes rolling progress + a final summary to stdout.
import { launchWithExtension, waitForEngine, HERE } from "./harness.mjs";
import { mkdirSync } from "fs";
import { join } from "path";

const SHOTS = join(HERE, "screenshots", "soak_hour");
mkdirSync(SHOTS, { recursive: true });
const RUN_MS = 48 * 60 * 1000;
const DWELL_MS = 38000;

const SITES = [
  { name: "example", url: "https://example.com/", expectZero: true },
  { name: "apnews", url: "https://apnews.com/hub/technology" },
  { name: "forbes", url: "https://www.forbes.com/" },
  { name: "theverge", url: "https://www.theverge.com/" },
  { name: "usatoday-vid", url: "https://www.usatoday.com/media/latest/videos/", video: true },
  { name: "weather-vid", url: "https://weather.com/video", video: true },
  { name: "aljazeera", url: "https://www.aljazeera.com/live/", video: true },
  { name: "youtube", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", video: true },
  { name: "amazon", url: "https://www.amazon.com/s?k=headphones", fpCheck: true },
  { name: "ebay", url: "https://www.ebay.com/sch/i.html?_nkw=laptop", fpCheck: true },
  { name: "reddit", url: "https://old.reddit.com/" },
];

const ctx = await launchWithExtension({ requireGpu: true });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 60000 });
const extId = new URL(sw.url()).host;

const ourErrors = []; // {site, text}
const agg = {}; for (const s of SITES) agg[s.name] = { runs: 0, maxOverlays: 0, players: 0, covered: 0, fpHits: 0, crashes: 0, errs: 0 };

async function engineState() {
  return sw.evaluate(async () => {
    try {
      const { engineKind = "lfm" } = await chrome.storage.local.get({ engineKind: "lfm" });
      const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind }, res));
      return r?.info?.state || "?";
    } catch { return "swerr"; }
  }).catch(() => "unreachable");
}

async function probe(page) {
  let overlays = 0, players = 0, covered = false;
  for (const f of page.frames()) {
    try {
      const r = await f.evaluate(() => {
        const ovs = [...document.querySelectorAll("[data-minus-overlay]")].map((o) => o.getBoundingClientRect());
        const reg = [
          ...[...document.querySelectorAll("video")].map((v) => v.getBoundingClientRect()).filter((v) => v.width > 40 && v.height > 40),
          ...[...document.querySelectorAll("iframe")].map((v) => v.getBoundingClientRect()).filter((v) => v.width >= 300 && v.height >= 150),
        ];
        const cov = ovs.some((o) => reg.some((v) => {
          const ix = Math.max(0, Math.min(o.right, v.right) - Math.max(o.left, v.left));
          const iy = Math.max(0, Math.min(o.bottom, v.bottom) - Math.max(o.top, v.top));
          return ix * iy > 0.25 * Math.max(1, v.width * v.height);
        }));
        return { o: ovs.length, v: reg.length, cov };
      });
      overlays += r.o; players += r.v; if (r.cov) covered = true;
    } catch {}
  }
  return { overlays, players, covered };
}

async function dismiss(page) {
  const re = /^(accept all|accept|i agree|agree|got it|allow all|reject all|no thanks|continue)$/i;
  for (const fr of page.frames()) { try { for (const b of await fr.$$("button,[role=button],a")) { const t = ((await b.innerText().catch(() => "")) || "").trim(); if (re.test(t)) await b.click({ timeout: 1000 }).catch(() => {}); } } catch {} }
}
async function play(page) {
  for (const fr of page.frames()) { try { await fr.evaluate(() => { for (const v of document.querySelectorAll("video")) { v.muted = true; v.play?.().catch(() => {}); } for (const b of document.querySelectorAll('.ytp-large-play-button,.vjs-big-play-button,[aria-label*="play" i]')) { try { b.click(); } catch {} } }); } catch {} }
  await page.mouse.click((page.viewportSize()?.width || 1280) / 2, (page.viewportSize()?.height || 800) * 0.4).catch(() => {});
}

const t0 = Date.now();
let cycle = 0;
console.log(`soak start; engine=${JSON.stringify(await waitForEngine(ctx, 8 * 60 * 1000))}`);
while (Date.now() - t0 < RUN_MS) {
  cycle++;
  for (const site of SITES) {
    if (Date.now() - t0 >= RUN_MS) break;
    const a = agg[site.name]; a.runs++;
    const page = await ctx.newPage();
    let errs = 0, crashed = false;
    page.on("crash", () => { crashed = true; });
    page.on("console", (m) => {
      const loc = m.location()?.url || "";
      if ((m.type() === "error" || m.type() === "warning") && loc.includes(extId)) { errs++; if (ourErrors.length < 60) ourErrors.push({ site: site.name, text: m.text().slice(0, 200) }); }
    });
    page.on("pageerror", (e) => { const s = String(e); if (/content\.js|offscreen\.js|minus/.test(s)) { errs++; if (ourErrors.length < 60) ourErrors.push({ site: site.name, text: s.slice(0, 200) }); } });
    try {
      await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForTimeout(2500); await dismiss(page); if (site.video) await play(page);
      let maxOv = 0, players = 0, covered = false;
      const dwellEnd = Date.now() + DWELL_MS;
      while (Date.now() < dwellEnd && Date.now() - t0 < RUN_MS) {
        const p = await probe(page); maxOv = Math.max(maxOv, p.overlays); players = Math.max(players, p.players); if (p.covered) covered = true;
        if (site.video) await play(page);
        await page.waitForTimeout(3000);
      }
      a.maxOverlays = Math.max(a.maxOverlays, maxOv); a.players = Math.max(a.players, players); if (covered) a.covered++;
      if ((site.fpCheck || site.expectZero) && maxOv > 0) a.fpHits++;
      if (cycle <= 2 || maxOv > 0) await page.screenshot({ path: join(SHOTS, `${site.name}_c${cycle}.png`) }).catch(() => {});
    } catch (e) { /* nav/site error */ }
    a.errs += errs; if (crashed) a.crashes++;
    await page.close().catch(() => {});
    console.log(`[+${Math.round((Date.now() - t0) / 60000)}m c${cycle}] ${site.name.padEnd(12)} ov=${a.maxOverlays} players=${a.players} cov=${a.covered}/${a.runs} fp=${a.fpHits} errs=${a.errs} crash=${a.crashes} engine=${await engineState()}`);
  }
}

console.log("\n===== SOAK SUMMARY (" + Math.round((Date.now() - t0) / 60000) + " min, " + cycle + " cycles) =====");
console.log("final engine:", await engineState());
for (const s of SITES) { const a = agg[s.name]; console.log(`${s.name.padEnd(13)} runs=${a.runs} maxOv=${a.maxOverlays} players=${a.players} covered=${a.covered} ${s.fpCheck || s.expectZero ? `FP_HITS=${a.fpHits}` : ""} errs=${a.errs} crashes=${a.crashes}`); }
console.log(`\nTOTAL our-extension errors: ${ourErrors.length}`);
for (const e of ourErrors.slice(0, 30)) console.log(`  [${e.site}] ${e.text}`);
await ctx.close();
