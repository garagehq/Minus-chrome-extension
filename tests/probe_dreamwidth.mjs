// Why did dreamwidth.org (a loaded page) produce 0 captures? Determine whether
// it's benign (no ad-shaped candidates -> correctly nothing to capture) or a real
// bug (candidates exist but the display scan never captured/classified them).
import { launchWithExtension, waitForEngine } from "./harness.mjs";
const ctx = await launchWithExtension();
const sw = () => ctx.serviceWorkers()[0];
const counters = () => sw().evaluate(() => ({ ok: globalThis.__minusCapOk || 0, cls: globalThis.__minusClsCalls || 0, refused: globalThis.__minusCapRefused || 0 })).catch(() => ({}));
try {
  await waitForEngine(ctx);
  const before = await counters();
  const pg = await ctx.newPage();
  await pg.goto("https://www.dreamwidth.org/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await pg.bringToFront();
  await pg.waitForTimeout(10000);
  // count candidate-shaped elements the display scanner would consider
  const dom = await pg.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const imgs = [...document.images];
    const bigImgs = imgs.filter((i) => { const r = i.getBoundingClientRect(); return r.width >= 120 && r.height >= 60; });
    const iframes = [...document.querySelectorAll("iframe")];
    const AD = /(^|[^a-z])(ad|ads|advert|sponsor|banner|promo|dfp|gpt|taboola|outbrain|doubleclick)([^a-z]|$)/i;
    const adHint = [...document.querySelectorAll("div,section,aside,a")].filter((e) => AD.test(`${e.id} ${e.className}`));
    return { imgs: imgs.length, bigImgs: bigImgs.length, loadedBigImgs: bigImgs.filter((i) => i.complete && i.naturalWidth > 0).length, iframes: iframes.length, adHint: adHint.length, overlays: document.querySelectorAll("[data-minus-overlay]").length, title: document.title.slice(0, 40) };
  });
  await pg.evaluate(() => window.scrollBy(0, 1500)).catch(() => {});
  await pg.waitForTimeout(5000);
  const after = await counters();
  await pg.close().catch(() => {});
  console.log("dreamwidth.org DOM:", JSON.stringify(dom));
  console.log(`counters delta: capOk +${after.ok - before.ok}  clsCalls +${after.cls - before.cls}  refused +${after.refused - before.refused}`);
  const hasCandidates = dom.bigImgs > 0 || dom.iframes > 0 || dom.adHint > 0;
  console.log(hasCandidates
    ? (after.ok - before.ok > 0 ? "VERDICT: candidates existed AND captured — fully fine" : "VERDICT: candidates existed but NO capture — REAL BUG to fix")
    : "VERDICT: no ad-shaped candidates on the page — 0 captures is correct (benign)");
} finally { await ctx.close().catch(() => {}); }
process.exit(0);
