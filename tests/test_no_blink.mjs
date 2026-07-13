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
      // count hide TRANSITIONS only (old style visible -> now hidden); position
      // updates that merely land during a hide window must not inflate the count
      for (const m of muts) {
        if (m.attributeName !== "style") continue;
        const was = /visibility:\s*hidden/.test(m.oldValue || "");
        const is_ = m.target.style.visibility === "hidden";
        if (!was && is_) out.blinks++;
      }
    });
    for (const c of cards) mo.observe(c, { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) { out.samples++; await new Promise((r) => setTimeout(r, 250)); }
    mo.disconnect();
    return out;
  });
  check("banner card found and observed", res.blinks >= 0, JSON.stringify(res));
  check("banner card NEVER blinks while iframe sampler runs (25s)", res.blinks === 0, `hidden-flips=${res.blinks}`);
  await p.close();

  // Part 2 — a COVERED looping-ad iframe (the wco.tv report): its own card may
  // peek, but only on the event-driven backoff (10s -> 20s -> 40s), never on the
  // old every-tick cadence. Old behavior: ~10-20 flips in 50s. Budget: <=3.
  const p2 = await ctx.newPage();
  await p2.goto("http://127.0.0.1:8919/blink2.html", { waitUntil: "load" });
  // inner frame shows CONTENT for 12s, then the ad break starts (the wco timeline)
  await p2.locator("[data-minus-overlay]").first().waitFor({ state: "visible", timeout: 150000 });
  const res2 = await p2.evaluate(async () => {
    const out = { blinks: 0 };
    const cards = [...document.querySelectorAll("[data-minus-overlay]")];
    const mo = new MutationObserver((muts) => {
      // count hide TRANSITIONS only (old style visible -> now hidden); position
      // updates that merely land during a hide window must not inflate the count
      for (const m of muts) {
        if (m.attributeName !== "style") continue;
        const was = /visibility:\s*hidden/.test(m.oldValue || "");
        const is_ = m.target.style.visibility === "hidden";
        if (!was && is_) out.blinks++;
      }
    });
    for (const c of cards) mo.observe(c, { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
    const t0 = Date.now();
    while (Date.now() - t0 < 55000) await new Promise((r) => setTimeout(r, 250));
    mo.disconnect();
    return out;
  });
  const kind = await p2.evaluate(() => document.querySelector("[data-minus-overlay]")?.dataset.minusKind);
  check("covered via the MOTION path (kind=video — the wco scenario)", kind === "video", `kind=${kind}`);
  check("covered iframe card peeks on backoff only (1-4 flips in 55s)", res2.blinks >= 1 && res2.blinks <= 4, `hidden-flips=${res2.blinks} (old cadence ~10-20; 0 = backoff path never ran)`);
  check("covered iframe stays covered (looping ad not un-blocked)", await p2.evaluate(() => document.querySelectorAll("[data-minus-overlay]").length) >= 1);
  await p2.close();
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]); fail++;
} finally {
  await ctx.close(); server.close();
}
console.log(fail ? `\n${fail} FAILURE(S)` : "\nno-blink regression green");
process.exit(fail ? 1 : 0);
