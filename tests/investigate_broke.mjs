// Root-cause the soak's "layout-broke" signal: is the Minus overlay causing
// horizontal overflow, or are these just naturally-wide ad pages?
// For each site: measure scrollWidth with overlays present, list every element
// extending past the viewport's right edge (is it a minus overlay?), then remove
// all minus overlays and re-measure.
import { launchWithExtension, waitForEngine } from "./harness.mjs";

const SITES = [
  "https://www.livescience.com/", "https://www.sfgate.com/", "https://www.tomshardware.com/",
  "https://www.bonappetit.com/", "https://arstechnica.com/", "https://9gag.com/",
];
const ctx = await launchWithExtension({ requireGpu: true });
await waitForEngine(ctx, 6 * 60 * 1000);
for (const url of SITES) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(9000); // let overlays appear
    const r = await page.evaluate(() => {
      const iw = window.innerWidth, de = document.documentElement;
      const swBefore = de.scrollWidth;
      const nOverlays = document.querySelectorAll("[data-minus-overlay]").length;
      // widest offenders past the right edge
      const offenders = [];
      for (const el of document.querySelectorAll("body *")) {
        const b = el.getBoundingClientRect();
        if (b.right > iw + 5 && b.width > 20 && b.height > 10) {
          offenders.push({ minus: el.hasAttribute("data-minus-overlay") || !!el.closest("[data-minus-overlay]"), tag: el.tagName.toLowerCase(), cls: (el.className && String(el.className).slice(0, 30)) || "", right: Math.round(b.right), pos: getComputedStyle(el).position });
        }
      }
      offenders.sort((a, b) => b.right - a.right);
      // remove minus overlays, re-measure
      document.querySelectorAll("[data-minus-overlay]").forEach((e) => e.remove());
      const swAfter = de.scrollWidth;
      const minusOffenders = offenders.filter((o) => o.minus);
      return { iw, swBefore, swAfter, nOverlays, ratioBefore: +(swBefore / iw).toFixed(2), ratioAfter: +(swAfter / iw).toFixed(2), minusOffenders: minusOffenders.slice(0, 3), topOffenders: offenders.slice(0, 4) };
    });
    const host = new URL(url).hostname;
    const verdict = r.swBefore > r.swAfter + 5 ? "OVERLAY-CAUSED" : (r.minusOffenders.length ? "overlay-past-edge (no scrollWidth change)" : "natural page width");
    console.log(`\n${host}: innerW=${r.iw} scrollW ${r.swBefore}(${r.ratioBefore}x) -> after-remove ${r.swAfter}(${r.ratioAfter}x) | overlays=${r.nOverlays} | ${verdict}`);
    console.log(`  minus offenders past edge: ${JSON.stringify(r.minusOffenders)}`);
    console.log(`  top offenders: ${JSON.stringify(r.topOffenders)}`);
  } catch (e) { console.log(`${url}: ERR ${String(e).split("\n")[0]}`); }
  await page.close();
}
await ctx.close();
