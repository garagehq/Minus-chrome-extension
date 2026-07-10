// Long "iteration test" breadth soak (~230 sites) with anonymous submission ON,
// pointed at a LOCAL sink so every flagged crop is saved for false-positive
// review.  node tests/iteration_soak.mjs <iterNum> <minutes>
// Both video sites (autoplay/ad-break path) and regular/content/shopping sites
// (static display-scan path). Tracks OUR errors, crashes, engine state, per-site
// coverage + layout-breakage, and captures every submitted crop + metadata.
import { launchWithExtension, waitForEngine, HERE } from "./harness.mjs";
import { SOAK_SITES } from "./soak_sites.mjs";
import { createServer } from "http";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const ITER = process.argv[2] || "1";
const RUN_MS = (parseFloat(process.argv[3] || "110")) * 60 * 1000;
const DWELL_VIDEO = 30000, DWELL_REG = 15000;
const PORT = 8791;

const OUT = join(HERE, "screenshots", `iter${ITER}`);
const CAP = join(OUT, "captures");
mkdirSync(CAP, { recursive: true });

// ---- local ingest sink: save every submitted crop + metadata ----
const captures = [];
let capIdx = 0;
const sink = createServer((req, res) => {
  if (req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { samples = [] } = JSON.parse(body);
        for (const s of samples) {
          const m = String(s.img || "").match(/^data:image\/\w+;base64,(.+)$/s);
          if (!m) continue;
          const host = (s.host || "unknown").replace(/[^a-z0-9.-]/gi, "_").slice(0, 40);
          const fn = `${String(capIdx).padStart(4, "0")}_${host}_${s.verdict}_p${Math.round((s.p_ad || 0) * 100)}.png`;
          writeFileSync(join(CAP, fn), Buffer.from(m[1], "base64"));
          captures.push({ fn, host: s.host, p_ad: s.p_ad, verdict: s.verdict, w: s.w, h: s.h, engine: s.engine });
          capIdx++;
        }
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}');
    });
  } else { res.writeHead(200); res.end("ok"); }
});
await new Promise((r) => sink.listen(PORT, "127.0.0.1", r));

// unique id per site (hostnames can collide) + deterministic per-iteration
// shuffle so every category (incl. the FP-stress image sites appended at the
// end) is interleaved throughout the run rather than clustered.
const seedKey = (url) => { let h = 2166136261 >>> 0; const str = url + "::" + ITER; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; };
const SITES = SOAK_SITES.map((s, i) => ({ ...s, id: `${s.name}#${i}` })).sort((a, b) => seedKey(a.url) - seedKey(b.url));

const ctx = await launchWithExtension({ requireGpu: true });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 60000 });
const extId = new URL(sw.url()).host;
await sw.evaluate((cfg) => chrome.storage.local.set(cfg), {
  collectOptIn: true, enabled: true, blockVideo: true, blockDisplay: true, disabledSites: [],
  ingestUrl: `http://127.0.0.1:${PORT}/ingest`, uploadCooldownMs: 3000,
});

const ourErrors = [];
const agg = {};
for (const s of SITES) agg[s.id] = { name: s.name, z: !!s.z, v: !!s.v, runs: 0, maxOv: 0, players: 0, covered: 0, fpFlag: 0, errs: 0, crashes: 0, broke: 0, loaded: 0 };

async function engineState() {
  return sw.evaluate(async () => {
    try { const { engineKind = "lfm" } = await chrome.storage.local.get({ engineKind: "lfm" });
      const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind }, res));
      return r?.info?.state || "?"; } catch { return "swerr"; }
  }).catch(() => "unreachable");
}
async function probe(page) {
  let ov = 0, players = 0, covered = false, broke = false;
  for (const f of page.frames()) {
    try {
      const r = await f.evaluate(() => {
        const os = [...document.querySelectorAll("[data-minus-overlay]")].map((o) => o.getBoundingClientRect());
        const reg = [...[...document.querySelectorAll("video")].map((v) => v.getBoundingClientRect()).filter((v) => v.width > 40 && v.height > 40),
          ...[...document.querySelectorAll("iframe")].map((v) => v.getBoundingClientRect()).filter((v) => v.width >= 300 && v.height >= 150)];
        const cov = os.some((o) => reg.some((v) => { const ix = Math.max(0, Math.min(o.right, v.right) - Math.max(o.left, v.left)); const iy = Math.max(0, Math.min(o.bottom, v.bottom) - Math.max(o.top, v.top)); return ix * iy > 0.25 * Math.max(1, v.width * v.height); }));
        return { o: os.length, v: reg.length, cov };
      });
      ov += r.o; players += r.v; if (r.cov) covered = true;
    } catch {}
  }
  // layout-breakage is a MAIN-FRAME property only — measuring per-frame falsely
  // flags normal internal overflow inside ad iframes (Iter 1 root-cause).
  try { broke = await page.mainFrame().evaluate(() => document.documentElement.scrollWidth > window.innerWidth * 1.4); } catch {}
  return { ov, players, covered, broke };
}
async function dismiss(page) { const re = /^(accept all|accept|i agree|agree|got it|allow all|reject all|no thanks|continue|close|ok)$/i; for (const fr of page.frames()) { try { for (const b of await fr.$$("button,[role=button]")) { const t = ((await b.innerText().catch(() => "")) || "").trim(); if (re.test(t)) await b.click({ timeout: 700 }).catch(() => {}); } } catch {} } }
async function play(page) { for (const fr of page.frames()) { try { await fr.evaluate(() => { for (const v of document.querySelectorAll("video")) { v.muted = true; v.play?.().catch(() => {}); } for (const b of document.querySelectorAll('.ytp-large-play-button,.vjs-big-play-button,[aria-label*="play" i]')) { try { b.click(); } catch {} } }); } catch {} } await page.mouse.click(640, 320).catch(() => {}); }

const t0 = Date.now();
let cycle = 0, visits = 0;
console.log(`iter${ITER} breadth soak (${(RUN_MS / 60000).toFixed(0)} min, ${SITES.length} sites); engine=${JSON.stringify(await waitForEngine(ctx, 8 * 60 * 1000))}`);
while (Date.now() - t0 < RUN_MS) {
  cycle++;
  for (const site of SITES) {
    if (Date.now() - t0 >= RUN_MS) break;
    const a = agg[site.id]; a.runs++; visits++;
    const page = await ctx.newPage();
    page.on("crash", () => { a.crashes++; });
    page.on("console", (m) => { const loc = m.location()?.url || ""; if ((m.type() === "error" || m.type() === "warning") && loc.includes(extId)) { a.errs++; if (ourErrors.length < 120) ourErrors.push({ site: site.name, text: m.text().slice(0, 180) }); } });
    page.on("pageerror", (e) => { const s = String(e); if (/content\.js|offscreen\.js|background\.js|models_catalog|popup\.js/.test(s)) { a.errs++; if (ourErrors.length < 120) ourErrors.push({ site: site.name, text: s.slice(0, 180) }); } });
    try {
      await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      a.loaded++;
      await page.waitForTimeout(2000); await dismiss(page); if (site.v) await play(page);
      let maxOv = 0, players = 0, covered = false, broke = false;
      const end = Date.now() + (site.v ? DWELL_VIDEO : DWELL_REG);
      while (Date.now() < end && Date.now() - t0 < RUN_MS) { const p = await probe(page); maxOv = Math.max(maxOv, p.ov); players = Math.max(players, p.players); if (p.covered) covered = true; if (p.broke) broke = true; if (site.v) await play(page); await page.waitForTimeout(site.v ? 3000 : 2500); }
      a.maxOv = Math.max(a.maxOv, maxOv); a.players = Math.max(a.players, players); if (covered) a.covered++; if (broke) a.broke++;
      if (site.z && maxOv > 0) a.fpFlag++;
      if (maxOv > 0 || broke) await page.screenshot({ path: join(OUT, `${site.name}_c${cycle}.png`) }).catch(() => {});
    } catch {}
    await page.close().catch(() => {});
    if (visits % 10 === 0 || site.v) console.log(`[+${Math.round((Date.now() - t0) / 60000)}m c${cycle} v${visits}] ${site.name.padEnd(20)} ov=${a.maxOv} cov=${a.covered}/${a.runs} caps=${captures.length} errs=${ourErrors.length} engine=${await engineState()}`);
  }
}

await new Promise((r) => setTimeout(r, 10000)); // let the last upload alarm flush
writeFileSync(join(OUT, "captures_manifest.json"), JSON.stringify(captures, null, 2));
const loaded = Object.values(agg).filter((a) => a.loaded > 0).length;
const totErrs = Object.values(agg).reduce((n, a) => n + a.errs, 0), totCrash = Object.values(agg).reduce((n, a) => n + a.crashes, 0);
const totBroke = Object.values(agg).reduce((n, a) => n + a.broke, 0), totCov = Object.values(agg).reduce((n, a) => n + a.covered, 0);
const fpFlags = Object.values(agg).filter((a) => a.z && a.fpFlag > 0);
console.log(`\n===== ITER ${ITER} SUMMARY (${Math.round((Date.now() - t0) / 60000)} min, ${cycle} cycles, ${visits} visits) =====`);
console.log(`final engine: ${await engineState()} | sites loaded: ${loaded}/${SITES.length} | covered-visits: ${totCov} | captured crops: ${captures.length}`);
console.log(`OUR errors: ${totErrs} | crashes: ${totCrash} | layout-broke visits: ${totBroke}`);
console.log(`clean-control FP flags: ${fpFlags.length ? fpFlags.map((a) => `${a.name}(${a.fpFlag})`).join(", ") : "none"}`);
console.log(`captures dir: ${CAP}`);
if (ourErrors.length) { console.log("\n-- our error samples --"); for (const e of ourErrors.slice(0, 40)) console.log(`  [${e.site}] ${e.text}`); }
console.log("\n-- sites with overlays (candidates: real-ad or FP, review crops) --");
for (const a of Object.values(agg).filter((x) => x.maxOv > 0).sort((x, y) => y.maxOv - x.maxOv)) console.log(`  ${a.name.padEnd(22)} maxOv=${a.maxOv} covered=${a.covered}/${a.runs}${a.z ? "  <clean-control!>" : ""}${a.broke ? "  BROKE" : ""}`);
await ctx.close(); sink.close();
