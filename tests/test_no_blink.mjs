// Regression for the wco.tv "blinking ads" bug: the iframe motion sampler's
// clean captures used to hide EVERY overlay card (~up to 1s, every ~2.5s tick).
// Fix = targeted hide: only cards overlapping the sampled regions may blink.
// This asserts a display-blocked banner card stays rock-solid while a large
// ANIMATED cross-origin iframe keeps the sampler busy.
import { launchWithExtension, waitForEngine, serveFixtures } from "./harness.mjs";

const server = await serveFixtures();
const ctx = await launchWithExtension({ requireGpu: true });
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };
try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 30000 });
  await sw.evaluate(() => chrome.storage.local.set({ enabled: true, blockVideo: true, blockDisplay: true, disabledSites: [], collectOptIn: false }));
  await waitForEngine(ctx, 8 * 60 * 1000);
  const p = await ctx.newPage();
  await p.goto("http://127.0.0.1:8919/blink.html", { waitUntil: "load" });
  // wait for the banner card
  await p.locator("[data-minus-overlay]").first().waitFor({ state: "visible", timeout: 120000 });
  // watch visibility flips on ALL overlay cards for 25s (~10 sampler ticks)
  const res = await p.evaluate(async () => {
    const out = { blinks: 0, samples: 0 };
    const banner = document.getElementById("ad-img").getBoundingClientRect();
    const cards = [...document.querySelectorAll("[data-minus-overlay]")].filter((d) => {
      const r = d.getBoundingClientRect();
      return Math.abs(r.top - banner.top) < 40 && Math.abs(r.left - banner.left) < 40; // the banner's card
    });
    if (!cards.length) return { blinks: -1, samples: 0 };
    const mo = new MutationObserver((muts) => {
      for (const m of muts) if (m.attributeName === "style" && m.target.style.visibility === "hidden") out.blinks++;
    });
    for (const c of cards) mo.observe(c, { attributes: true, attributeFilter: ["style"] });
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) { out.samples++; await new Promise((r) => setTimeout(r, 250)); }
    mo.disconnect();
    return out;
  });
  check("banner card found and observed", res.blinks >= 0, JSON.stringify(res));
  check("banner card NEVER blinks while iframe sampler runs (25s)", res.blinks === 0, `hidden-flips=${res.blinks}`);
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]); fail++;
} finally {
  await ctx.close(); server.close();
}
console.log(fail ? `\n${fail} FAILURE(S)` : "\nno-blink regression green");
process.exit(fail ? 1 : 0);
