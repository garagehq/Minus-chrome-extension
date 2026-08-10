// Harvest a large, diverse pool of real registrable domains for the soak test.
// Crawls link-rich aggregators (Techmeme, Hacker News, Reddit, Wikipedia lists,
// news readers) and reduces every outbound link to its eTLD+1, deduped. Merges
// the curated SOAK_SITES first (guaranteed ad-heavy sites), then writes a cached,
// reproducible pool to tests/site_pool_1k.json. No extension / no WebGPU needed.
//   DISPLAY=:99 node tests/build_site_pool.mjs [targetCount]
import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SOAK_SITES } from "./soak_sites.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = parseInt(process.argv[2] || "1050", 10);

const TWO_LABEL_TLD = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "or.jp", "ne.jp", "com.au", "net.au",
  "co.nz", "co.in", "com.br", "co.za", "com.mx", "co.kr", "com.tr", "com.sg", "com.hk",
  "com.tw", "com.cn", "com.ua", "co.il", "com.ar", "com.my", "co.id", "com.ph",
]);
function registrable(host) {
  host = host.toLowerCase().replace(/^www\d?\./, "");
  const p = host.split(".");
  if (p.length <= 2) return host;
  const last2 = p.slice(-2).join(".");
  return TWO_LABEL_TLD.has(last2) ? p.slice(-3).join(".") : last2;
}
const BAD = /(^|\.)(gstatic|googleapis|googletagmanager|doubleclick|googlesyndication|cloudfront|akamaihd|fbcdn|licdn|twimg|ytimg|gravatar|wp\.com|w\.org|schema\.org|archive\.org|gmpg\.org)$/;
const isPlausible = (d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && /\.[a-z]{2,10}$/.test(d) && !/\d+\.\d+\.\d+/.test(d) && !BAD.test(d) && d.length <= 40;

const SEEDS = [
  "https://en.wikipedia.org/wiki/List_of_most_visited_websites",
  "https://en.wikipedia.org/wiki/Lists_of_websites",
  "https://www.techmeme.com/", "https://www.techmeme.com/river",
  "https://mediagazer.com/", "https://memeorandum.com/",
  "https://news.ycombinator.com/news?p=1", "https://news.ycombinator.com/news?p=2",
  "https://news.ycombinator.com/news?p=3", "https://news.ycombinator.com/news?p=4",
  "https://news.ycombinator.com/best", "https://news.ycombinator.com/active",
  "https://old.reddit.com/r/popular/", "https://old.reddit.com/r/all/",
  "https://old.reddit.com/r/technology/", "https://old.reddit.com/r/worldnews/",
  "https://old.reddit.com/r/news/", "https://old.reddit.com/r/business/",
  "https://lite.cnn.com/", "https://text.npr.org/", "https://lobste.rs/",
  "https://slashdot.org/", "https://digg.com/", "https://github.com/trending",
];

const domains = new Map(); // reg -> sample href host
const add = (d) => { if (isPlausible(d) && !domains.has(d)) domains.set(d, d); };
// curated first (guaranteed ad-heavy, reliable)
for (const s of SOAK_SITES) { try { add(registrable(new URL(s.url).hostname)); } catch {} }
console.log(`seeded ${domains.size} from curated SOAK_SITES`);

const ctx = await chromium.launchPersistentContext(join(HERE, ".profile-harvest"), {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 900 }, args: ["--no-sandbox"],
});
for (const seed of SEEDS) {
  if (domains.size >= TARGET) break;
  const pg = await ctx.newPage();
  try {
    await pg.goto(seed, { waitUntil: "domcontentloaded", timeout: 30000 });
    await pg.waitForTimeout(1500);
    for (let s = 0; s < 3; s++) { await pg.evaluate(() => window.scrollBy(0, 3000)).catch(() => {}); await pg.waitForTimeout(500); }
    const hosts = await pg.evaluate(() =>
      [...document.querySelectorAll('a[href^="http"]')].map((a) => { try { return new URL(a.href).hostname; } catch { return ""; } }).filter(Boolean));
    let before = domains.size;
    for (const h of hosts) add(registrable(h));
    console.log(`  ${seed.slice(0, 48).padEnd(48)} +${domains.size - before}  (total ${domains.size})`);
  } catch (e) { console.log(`  ${seed.slice(0, 48)} ERR ${String(e).split("\n")[0]}`); }
  finally { await pg.close().catch(() => {}); }
}
await ctx.close().catch(() => {});

const pool = [...domains.keys()].map((d) => ({ name: d, url: `https://${d}/` }));
writeFileSync(join(HERE, "site_pool_1k.json"), JSON.stringify(pool, null, 0));
console.log(`\nwrote tests/site_pool_1k.json with ${pool.length} distinct domains`);
process.exit(0);
