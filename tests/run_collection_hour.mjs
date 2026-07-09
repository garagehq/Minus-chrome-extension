// Real-world opt-in collection run: browse ad-heavy sites for ~1 hour with
// collection ON, so blocked ads get queued -> uploaded -> land in the HF
// dataset. Uses the aggressive lfm-web engine for richer ad capture and a
// short cooldown so uploads flow within the run.
import { launchWithExtension, waitForEngine, HERE } from "./harness.mjs";
import { appendFileSync } from "fs";
import { join } from "path";

const LOG = join(HERE, "..", "collection_hour.log");
const log = (m) => { const s = `${new Date().toISOString()} ${m}`; console.log(s); try { appendFileSync(LOG, s + "\n"); } catch {} };

const RUN_MS = 60 * 60 * 1000;      // 1-hour live soak (Iter 21-web default)
const DWELL_MS = 35 * 1000;          // per page
const SITES = [
  "https://www.nbcnews.com/", "https://www.foxnews.com/", "https://nypost.com/",
  "https://www.forbes.com/", "https://people.com/", "https://www.tmz.com/",
  "https://www.usmagazine.com/", "https://www.eonline.com/", "https://www.dailymail.co.uk/ushome/index.html",
  "https://www.cbssports.com/", "https://bleacherreport.com/", "https://www.si.com/",
  "https://www.allrecipes.com/", "https://www.delish.com/", "https://www.thespruce.com/",
  "https://www.healthline.com/", "https://www.webmd.com/", "https://www.investopedia.com/",
  "https://www.businessinsider.com/", "https://www.thedailybeast.com/", "https://www.buzzfeed.com/",
  "https://www.cnet.com/", "https://www.tomsguide.com/", "https://www.androidcentral.com/",
  "https://www.motortrend.com/", "https://www.hotcars.com/", "https://www.cbr.com/",
  // broadened mix: video, shopping, social, SPA, infinite-scroll, EU consent, reference
  "https://www.youtube.com/", "https://www.youtube.com/results?search_query=news",
  "https://www.amazon.com/s?k=headphones", "https://www.ebay.com/b/Laptops/175672",
  "https://www.walmart.com/search?q=coffee+maker", "https://www.reddit.com/r/technology/",
  "https://en.wikipedia.org/wiki/Cat", "https://en.wikipedia.org/wiki/Impressionism",
  "https://www.theguardian.com/us", "https://www.bbc.com/news", "https://www.bild.de/",
  "https://www.elmundo.es/", "https://www.lemonde.fr/", "https://www.espn.com/",
  "https://www.weather.com/", "https://www.accuweather.com/", "https://www.imdb.com/",
  "https://www.etsy.com/search?q=mug", "https://www.pinterest.com/search/pins/?q=recipes",
];

const ctx = await launchWithExtension();
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 60000 });

// opt in + aggressive engine + short cooldown so uploads land within the hour
await sw.evaluate(() => chrome.storage.local.set({
  collectOptIn: true, engineKind: "lfm", uploadCooldownMs: 60 * 1000,
}));
log("collection ON, engine=lfm(iter21web), cooldown=60s; waiting for engine...");
const info = await waitForEngine(ctx);
log(`engine ready: ${info.modelId} on ${info.device}`);

async function queueStats() {
  try {
    return await sw.evaluate(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open("minus-samples", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onupgradeneeded = () => r.result.createObjectStore("queue", { keyPath: "key" }); });
      return await new Promise((res) => { const rq = db.transaction("queue", "readonly").objectStore("queue").getAll(); rq.onsuccess = () => res(rq.result.length); });
    });
  } catch { return -1; }
}

const t0 = Date.now();
let i = 0, blocked = 0;
while (Date.now() - t0 < RUN_MS) {
  const url = SITES[i % SITES.length]; i++;
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
    // scroll to trigger lazy ads, dwell so the scanner classifies
    for (let s = 0; s < 4; s++) {
      await page.evaluate((y) => window.scrollTo(0, y), (s + 1) * 1200).catch(() => {});
      await page.waitForTimeout(DWELL_MS / 4);
    }
    const overlays = await page.locator("[data-minus-overlay]").count().catch(() => 0);
    blocked += overlays;
  } catch (e) {
    log(`  nav skip ${url.slice(8, 40)}: ${String(e).split("\n")[0].slice(0, 60)}`);
  } finally {
    await page.close().catch(() => {});
  }
  // periodically flush uploads + report queue depth
  if (i % 3 === 0) {
    await sw.evaluate(() => uploadDueSamples()).catch(() => {});
    log(`site ${i} (${url.slice(8, 32)}): overlays-so-far=${blocked}, queue=${await queueStats()}`);
  }
}

// final flush
await sw.evaluate(() => uploadDueSamples()).catch(() => {});
await new Promise((r) => setTimeout(r, 8000));
log(`DONE: visited ${i} pages, ~${blocked} overlays total, final queue=${await queueStats()}`);
await ctx.close();
