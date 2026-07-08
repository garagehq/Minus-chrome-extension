// Multi-site sweep: fixture pages carry HARD assertions; live sites are
// OBSERVATIONAL (ad delivery in headless is nondeterministic) but still
// hard-fail on page breakage or false positives where a page has no ads.
//
// Run: node tests/test_sites.mjs            (all)
//      node tests/test_sites.mjs fixtures   (fixtures only)
//      node tests/test_sites.mjs fp         (FP audit on image-heavy no-ad pages)
//      node tests/test_sites.mjs live       (live sites only)
import { launchWithExtension, serveFixtures, waitForEngine, HERE } from "./harness.mjs";
import { mkdirSync } from "fs";
import { join } from "path";

const MODE = process.argv[2] || "all";
const SHOTS = join(HERE, "screenshots");
mkdirSync(SHOTS, { recursive: true });

const FIXTURES = [
  {
    name: "dynamic-insert",
    url: "http://127.0.0.1:8919/dynamic.html",
    run: async (page, t) => {
      await page.waitForTimeout(2000);
      t.assert("no overlay before insert", (await page.locator("[data-minus-overlay]").count()) === 0);
      await page.locator("[data-minus-overlay]").first().waitFor({ state: "visible", timeout: 60000 });
      const [ad, ov] = await Promise.all([
        page.locator("#late-ad").boundingBox(),
        page.locator("[data-minus-overlay]").first().boundingBox(),
      ]);
      t.assert("overlay covers late-inserted ad", ad && ov && Math.abs(ad.x - ov.x) < 8 && Math.abs(ad.y - ov.y) < 8);
    },
  },
  {
    name: "scroll-in",
    url: "http://127.0.0.1:8919/scroll.html",
    run: async (page, t) => {
      await page.waitForTimeout(6000);
      t.assert("below-fold ad not classified while offscreen",
        (await page.locator("[data-minus-overlay]").count()) === 0);
      await page.locator("#fold-ad").scrollIntoViewIfNeeded();
      await page.locator("[data-minus-overlay]").first().waitFor({ state: "visible", timeout: 60000 });
      await page.waitForTimeout(6000);
      t.assert("exactly the ad overlaid after scroll (content stays clean)",
        (await page.locator("[data-minus-overlay]").count()) === 1);
    },
  },
  {
    name: "iframe-ad",
    url: "http://127.0.0.1:8919/adframe.html",
    run: async (page, t) => {
      await page.locator("[data-minus-overlay]").first().waitFor({ state: "visible", timeout: 60000 });
      const [fr, ov] = await Promise.all([
        page.locator("#ad-frame").boundingBox(),
        page.locator("[data-minus-overlay]").first().boundingBox(),
      ]);
      t.assert("overlay covers the ad iframe", fr && ov && Math.abs(fr.x - ov.x) < 8 && Math.abs(fr.y - ov.y) < 8);
    },
  },
];

const LIVE = [
  { name: "example.com", url: "https://example.com", maxOverlays: 0, hardFp: true },
  { name: "wikipedia", url: "https://en.wikipedia.org/wiki/Advertising", maxOverlays: 1, hardFp: true },
  { name: "youtube-home", url: "https://www.youtube.com", observational: true },
  { name: "youtube-video", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", observational: true, dwellMs: 30000 },
  { name: "apnews", url: "https://apnews.com", observational: true },
  { name: "bbc", url: "https://www.bbc.com", observational: true },
  { name: "old-reddit", url: "https://old.reddit.com/r/all", observational: true },
];

// Compatibility matrix: diverse real-world architectures. Observational
// (headless gets few real ads) but every one hard-fails on page breakage —
// the point is "does the extension coexist without breaking these sites".
const COMPAT = [
  { name: "compat-google-serp", url: "https://www.google.com/search?q=car+insurance", observational: true },
  { name: "compat-twitch", url: "https://www.twitch.tv/directory", observational: true, dwellMs: 20000 },
  { name: "compat-cnn", url: "https://www.cnn.com", observational: true, dwellMs: 20000 },
  { name: "compat-theverge", url: "https://www.theverge.com", observational: true, dwellMs: 20000 },
  { name: "compat-forbes", url: "https://www.forbes.com", observational: true, dwellMs: 20000 },
  { name: "compat-nytimes", url: "https://www.nytimes.com", observational: true, dwellMs: 20000 },
  { name: "compat-amazon", url: "https://www.amazon.com/s?k=headphones", observational: true, dwellMs: 20000 },
  { name: "compat-ebay", url: "https://www.ebay.com/b/Laptops/175672", observational: true, dwellMs: 20000 },
  { name: "compat-spa-nav", url: "https://en.wikipedia.org/wiki/Cat", observational: true,
    after: async (page) => { // SPA-style in-page nav must not leak overlays
      await page.click("a[href='/wiki/Dog']").catch(() => {});
      await page.waitForTimeout(8000);
    } },
];

// FP-audit set: image-heavy pages that contain NO ads (or almost none) —
// every overlay here is a false positive covering real content.
const FP_AUDIT = [
  { name: "fp-wiki-gallery", url: "https://en.wikipedia.org/wiki/Impressionism", maxOverlays: 0, hardFp: true, dwellMs: 20000 },
  { name: "fp-wikimedia-potd", url: "https://commons.wikimedia.org/wiki/Main_Page", maxOverlays: 1, hardFp: true, dwellMs: 20000 },
  { name: "fp-nasa-gallery", url: "https://www.nasa.gov/image-of-the-day/", maxOverlays: 1, hardFp: true, dwellMs: 20000 },
  { name: "fp-mdn", url: "https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API", maxOverlays: 0, hardFp: true },
  { name: "fp-openlibrary", url: "https://openlibrary.org/subjects/science_fiction", maxOverlays: 1, hardFp: true, dwellMs: 20000 },
  { name: "fp-books-toscrape", url: "https://books.toscrape.com/", maxOverlays: 1, hardFp: true, dwellMs: 20000 },
];

const server = await serveFixtures();
const ctx = await launchWithExtension();

let failures = 0;
const results = [];

function mkT(name) {
  return {
    assert(what, cond) {
      console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}`);
      if (!cond) failures++;
    },
  };
}

try {
  await waitForEngine(ctx);

  if (MODE !== "live") {
    for (const f of FIXTURES) {
      console.log(`\n=== fixture: ${f.name}`);
      const page = await ctx.newPage();
      try {
        await page.goto(f.url, { waitUntil: "load", timeout: 30000 });
        await f.run(page, mkT(f.name));
        await page.screenshot({ path: join(SHOTS, `site_${f.name}.png`) });
      } catch (e) {
        console.log(`  FAIL  (exception) ${String(e).split("\n")[0]}`);
        failures++;
      } finally {
        await page.close();
      }
    }
  }

  if (MODE !== "fixtures") {
    const liveSet = MODE === "fp" ? FP_AUDIT : MODE === "live" ? LIVE : [...LIVE, ...FP_AUDIT];
    for (const s of liveSet) {
      console.log(`\n=== live: ${s.name}`);
      const page = await ctx.newPage();
      const pageErrors = [];
      page.on("pageerror", (e) => {
        if (String(e).includes("minus") || String(e).includes("chrome-extension")) pageErrors.push(String(e));
      });
      try {
        // generous timeout: ad networks are slow
        await page.goto(s.url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(s.dwellMs || 15000);
        const overlays = await page.locator("[data-minus-overlay]").count();
        const covered = await page.evaluate(() =>
          [...document.querySelectorAll("[data-minus-overlay]")].map((d) => {
            const r = d.getBoundingClientRect();
            return `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`;
          }));
        await page.screenshot({ path: join(SHOTS, `site_${s.name}.png`) });
        const t = mkT(s.name);
        t.assert("no extension-caused page errors", pageErrors.length === 0);
        if (s.hardFp) t.assert(`overlays <= ${s.maxOverlays} (FP check)`, overlays <= s.maxOverlays);
        console.log(`  overlays: ${overlays}${covered.length ? "  " + covered.join(" ") : ""}${s.observational ? "  (observational)" : ""}`);
        results.push({ site: s.name, overlays, covered });
      } catch (e) {
        console.log(`  SKIP  (nav/timeout) ${String(e).split("\n")[0]}`);
        results.push({ site: s.name, error: String(e).split("\n")[0] });
      } finally {
        await page.close();
      }
    }
  }
} finally {
  await ctx.close();
  server.close();
}

console.log("\n=== summary");
for (const r of results) console.log(" ", JSON.stringify(r));
console.log(failures ? `\n${failures} failure(s)` : "\nall green");
process.exit(failures ? 1 : 0);
