import { launchWithExtension, waitForEngine } from "./harness.mjs";
const ctx = await launchWithExtension({ requireGpu: true });
await waitForEngine(ctx, 6 * 60 * 1000);
const p = await ctx.newPage();
await p.goto("https://www.wish.com/", { waitUntil: "domcontentloaded", timeout: 40000 });
await p.waitForTimeout(14000);
const info = await p.evaluate(() => {
  const out = [];
  for (const ov of document.querySelectorAll("[data-minus-overlay]")) {
    const b = ov.getBoundingClientRect();
    ov.style.visibility = "hidden";
    const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    ov.style.visibility = "";
    if (!el) { out.push({ under: "none" }); continue; }
    // find the nearest img in/around
    const img = el.tagName === "IMG" ? el : (el.querySelector?.("img") || el.closest?.("*")?.querySelector?.("img"));
    out.push({
      underTag: el.tagName, underCls: String(el.className || "").slice(0, 40),
      imgFound: !!img,
      imgComplete: img ? img.complete : null,
      imgNaturalW: img ? img.naturalWidth : null,
      imgSrc: img ? (img.currentSrc || img.src || "").slice(0, 70) : null,
      ovW: Math.round(b.width), ovH: Math.round(b.height),
    });
  }
  return out;
});
console.log("Nike covered elements:", JSON.stringify(info, null, 2));
await ctx.close();
