// Iteration 3 — functional / interaction stress. Hunts bugs the FP/coverage
// soaks can't: stale-overlay leaks when an ad's DOM node is removed (SPA route
// change), overlay drift on scroll, live toggle + per-site-disable correctness,
// and stability under rapid tab churn.
import { launchWithExtension, waitForEngine, serveFixtures } from "./harness.mjs";

const server = await serveFixtures();
const ctx = await launchWithExtension({ requireGpu: true });
let fail = 0;
const check = (name, cond, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!cond) fail++; };
const overlays = (p) => p.evaluate(() => document.querySelectorAll("[data-minus-overlay]").length);
const engineState = async (sw) => sw.evaluate(async () => { try { const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind: "lfm" }, res)); return r?.info?.state; } catch { return "err"; } }).catch(() => "unreachable");

try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 30000 });
  await sw.evaluate(() => chrome.storage.local.set({ enabled: true, blockVideo: true, blockDisplay: true, disabledSites: [], collectOptIn: false }));
  await waitForEngine(ctx, 6 * 60 * 1000);

  // A) STALE-OVERLAY LEAK: cover a display ad, remove its DOM node, expect the overlay to be cleaned up.
  {
    const p = await ctx.newPage();
    await p.goto("http://127.0.0.1:8919/", { waitUntil: "load" });
    await p.locator("[data-minus-overlay]").first().waitFor({ state: "visible", timeout: 120000 }).catch(() => {});
    const before = await overlays(p);
    check("display ad covered (setup)", before >= 1, `overlays=${before}`);
    await p.evaluate(() => document.getElementById("ad-img")?.remove());
    await p.waitForTimeout(3500);
    const after = await overlays(p);
    check("overlay cleaned up when ad DOM node removed (no SPA leak)", after === 0, `overlays after remove=${after}`);
    await p.close();
  }

  // B) SCROLL-TRACKING: overlay must stay aligned with its ad after scrolling.
  {
    const p = await ctx.newPage();
    await p.goto("http://127.0.0.1:8919/", { waitUntil: "load" });
    await p.locator("[data-minus-overlay]").first().waitFor({ state: "visible", timeout: 120000 }).catch(() => {});
    await p.waitForTimeout(1500);
    const drift = await p.evaluate(async () => {
      const measure = () => { const ad = document.getElementById("ad-img")?.getBoundingClientRect(); const ov = document.querySelector("[data-minus-overlay]")?.getBoundingClientRect(); if (!ad || !ov) return null; return Math.abs(ad.top - ov.top) + Math.abs(ad.left - ov.left); };
      const d0 = measure();
      window.scrollBy(0, 400); await new Promise((r) => setTimeout(r, 900));
      const d1 = measure();
      window.scrollTo(0, 0); await new Promise((r) => setTimeout(r, 900));
      const d2 = measure();
      return { d0, d1, d2 };
    });
    check("overlay tracks ad on scroll (drift < 12px)", drift && drift.d1 != null && drift.d1 < 12 && drift.d2 < 12, JSON.stringify(drift));
    await p.close();
  }

  // C) PER-SITE DISABLE (live site): apnews reliably serves a Schwab native ad.
  {
    const AD = "https://apnews.com/hub/technology";
    await sw.evaluate(() => chrome.storage.local.set({ disabledSites: [] }));
    const p1 = await ctx.newPage(); await p1.goto(AD, { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
    await p1.locator("[data-minus-overlay]").first().waitFor({ state: "visible", timeout: 90000 }).catch(() => {});
    const on = await overlays(p1); await p1.close();
    await sw.evaluate(() => chrome.storage.local.set({ disabledSites: ["apnews.com"] }));
    const p2 = await ctx.newPage(); await p2.goto(AD, { waitUntil: "domcontentloaded", timeout: 40000 }).catch(() => {});
    await p2.waitForTimeout(12000);
    const off = await overlays(p2); await p2.close();
    await sw.evaluate(() => chrome.storage.local.set({ disabledSites: [] }));
    check("per-site disable: ads covered when enabled", on >= 1, `overlays=${on}`);
    check("per-site disable: 0 overlays when site disabled", off === 0, `overlays=${off}`);
  }

  // D) LIVE TOGGLE: blockDisplay off should clear display overlays without reload.
  {
    const p = await ctx.newPage();
    await p.goto("http://127.0.0.1:8919/", { waitUntil: "load" });
    await p.locator("[data-minus-overlay]").first().waitFor({ state: "visible", timeout: 120000 }).catch(() => {});
    const on = await overlays(p);
    await sw.evaluate(() => chrome.storage.local.set({ blockDisplay: false }));
    await p.waitForTimeout(2500);
    const off = await overlays(p);
    await sw.evaluate(() => chrome.storage.local.set({ blockDisplay: true }));
    check("live toggle: display overlays clear when blockDisplay=false", on >= 1 && off === 0, `on=${on} off=${off}`);
    await p.close();
  }

  // E) RAPID CHURN: open/close 25 pages fast; engine stays ready, no crash.
  {
    let crashed = 0;
    for (let i = 0; i < 25; i++) {
      const p = await ctx.newPage();
      p.on("crash", () => crashed++);
      await p.goto("http://127.0.0.1:8919/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      await p.waitForTimeout(300 + (i % 3) * 200);
      await p.close().catch(() => {});
    }
    const st = await engineState(sw);
    check("rapid churn (25 pages): no crashes", crashed === 0, `crashes=${crashed}`);
    check("rapid churn: engine still ready after", st === "ready", `engine=${st}`);
  }
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]); fail++;
} finally {
  await ctx.close(); server.close();
}
console.log(fail ? `\n${fail} FAILURE(S)` : "\nall functional checks green");
process.exit(fail ? 1 : 0);
