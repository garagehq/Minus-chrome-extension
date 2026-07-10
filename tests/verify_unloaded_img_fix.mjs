// Verify the unloaded-image FP fix: product-tile placeholders (unloaded imgs)
// should no longer be covered on shopping grids, while a real loaded ad still is.
import { launchWithExtension, waitForEngine, HERE } from "./harness.mjs";
import { mkdirSync } from "fs";
import { join } from "path";
const OUT = join(HERE, "screenshots", "verify_fix"); mkdirSync(OUT, { recursive: true });
// {url, label, expect: 'low' (product grid -> ~0 overlays) | 'ad' (real ad -> >=1)}
const SITES = [
  { url: "https://www.nike.com/w?q=sneakers", label: "nike", expect: "low", prevMaxOv: 2 },
  { url: "https://www.wish.com/", label: "wish", expect: "low", prevMaxOv: 4 },
  { url: "https://www.aliexpress.com/wholesale?SearchText=phone+case", label: "aliexpress", expect: "low", prevMaxOv: 9 },
  { url: "https://apnews.com/hub/technology", label: "apnews", expect: "ad", prevMaxOv: 1 },
  { url: "https://variety.com/", label: "variety", expect: "ad", prevMaxOv: 5 },
];
const ctx = await launchWithExtension({ requireGpu: true });
await waitForEngine(ctx, 6 * 60 * 1000);
let fail = 0;
for (const s of SITES) {
  const p = await ctx.newPage();
  let maxOv = 0, finalOv = 0;
  try {
    await p.goto(s.url, { waitUntil: "domcontentloaded", timeout: 40000 });
    await p.waitForTimeout(2500);
    for (const fr of p.frames()) { try { for (const b of await fr.$$("button")) { const t = ((await b.innerText().catch(() => "")) || "").trim(); if (/^(accept all|accept|agree|got it|reject all|continue|close|dismiss)$/i.test(t)) await b.click({ timeout: 700 }).catch(() => {}); } } catch {} }
    for (let i = 0; i < 12; i++) { await p.waitForTimeout(3000); finalOv = await p.evaluate(() => document.querySelectorAll("[data-minus-overlay]").length); maxOv = Math.max(maxOv, finalOv); } // ~36s spans the re-verify settle window
    await p.screenshot({ path: join(OUT, `${s.label}.png`) }).catch(() => {});
  } catch (e) { console.log(`${s.label}: nav err ${String(e).split("\n")[0]}`); }
  await p.close();
  const ok = s.expect === "low" ? finalOv === 0 : finalOv >= 1 || maxOv >= 1;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${s.label.padEnd(11)} settled=${finalOv} (peak=${maxOv}, prev soak=${s.prevMaxOv}, expect ${s.expect === "low" ? "settled 0 product grid" : "≥1 real ad"})`);
}
console.log(fail ? `\n${fail} unexpected` : "\nfix verified: product-grid placeholders no longer covered, real ads still covered");
await ctx.close();
process.exit(fail ? 1 : 0);
