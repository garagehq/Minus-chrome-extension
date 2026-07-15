// Headed (Xvfb) spot-check of the FP-fingerprint sites for an iteration
// candidate. Launches a NON-headless chromium with the extension, points
// anonymous submission at a local sink, dwells on each site, and records
// overlay counts + every submitted crop (verdict + p_ad) + a full-window
// screenshot per site. ENGINE env selects the engine (default lfm).
//   DISPLAY=:99 ENGINE=lfm-iter27 node tests/spot_check_headed.mjs
import { chromium } from "playwright";
import { createServer } from "http";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(HERE, "..", "extension");
const ENGINE = process.env.ENGINE || "lfm";
const OUT = join(HERE, "screenshots", `spotcheck_${ENGINE}`);
const PROFILE = join(HERE, ".profile-spotcheck");
mkdirSync(OUT, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const SITES = [
  ["skysports", "https://www.skysports.com/"],
  ["usmagazine", "https://www.usmagazine.com/"],
  ["armorgames", "https://armorgames.com/"],
  ["9gag", "https://9gag.com/"],
];
const PORT = 8792;

const captures = [];
const sink = createServer((req, res) => {
  if (req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { samples = [] } = JSON.parse(body);
        for (const s of samples) {
          const m = String(s.img || "").match(/^data:image\/\w+;base64,(.+)$/s);
          const fn = `${String(captures.length).padStart(3, "0")}_${(s.host || "?").replace(/[^a-z0-9.-]/gi, "_")}_p${Math.round((s.p_ad || 0) * 100)}.png`;
          if (m) writeFileSync(join(OUT, fn), Buffer.from(m[1], "base64"));
          captures.push({ fn, host: s.host, p_ad: s.p_ad, verdict: s.verdict, w: s.w, h: s.h });
        }
      } catch {}
      res.writeHead(200); res.end('{"ok":true}');
    });
  } else { res.writeHead(200); res.end("ok"); }
});
await new Promise((r) => sink.listen(PORT, "127.0.0.1", r));

const GPU_FLAGS = [
  "--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=vulkan",
  "--enable-features=Vulkan", "--disable-vulkan-surface", "--no-sandbox",
];
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "chromium",
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [...GPU_FLAGS, `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 60000 });
await sw.evaluate((cfg) => chrome.storage.local.set(cfg), {
  collectOptIn: true, enabled: true, blockVideo: true, blockDisplay: true, disabledSites: [],
  engineKind: ENGINE, ingestUrl: `http://127.0.0.1:${PORT}/ingest`, uploadCooldownMs: 2000,
});

// wait for engine ready (re-acquire SW each poll; evaluate can hang on dead handles)
const t0 = Date.now();
for (;;) {
  const state = await Promise.race([
    (async () => {
      try {
        const s = ctx.serviceWorkers()[0]; if (!s) return "no-sw";
        return await s.evaluate(async (ek) => {
          const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind: ek }, res));
          return r?.info?.state || "?";
        }, ENGINE);
      } catch { return "err"; }
    })(),
    new Promise((r) => setTimeout(() => r("poll-timeout"), 10000)),
  ]);
  if (state === "ready") break;
  if (Date.now() - t0 > 8 * 60 * 1000) { console.log("ENGINE NEVER READY:", state); process.exit(1); }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(`engine ready (${ENGINE}), headed on DISPLAY=${process.env.DISPLAY}`);

// first-run onboarding tab steals focus; a hidden tab never scans
for (const p of ctx.pages()) {
  if (p.url().includes("onboarding") || p.url().includes("welcome")) await p.close().catch(() => {});
}

const results = [];
for (const [name, url] of SITES) {
  const before = captures.length;
  const page = await ctx.newPage();
  let overlays = -1;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.bringToFront();
    await page.waitForTimeout(50000);
    overlays = await page.evaluate(() => document.querySelectorAll(".minus-overlay, [data-minus-overlay]").length);
    await page.screenshot({ path: join(OUT, `page_${name}.png`) });
  } catch (e) { console.log(`${name} FAIL: ${String(e).split("\n")[0]}`); }
  const crops = captures.slice(before).map((c) => `${c.fn} p=${(c.p_ad ?? 0).toFixed(2)}`);
  console.log(`${name}: overlays=${overlays} crops=${captures.length - before}${crops.length ? "\n    " + crops.join("\n    ") : ""}`);
  results.push({ name, overlays, crops });
  await page.close().catch(() => {});
}
writeFileSync(join(OUT, "results.json"), JSON.stringify({ engine: ENGINE, results, captures }, null, 1));
await ctx.close();
sink.close();
console.log(`done -> ${OUT}`);
