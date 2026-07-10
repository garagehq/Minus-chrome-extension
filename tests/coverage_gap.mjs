// Investigate ad-heavy sites that showed ov=0 in the soak: are there visible
// ad-sized iframes/images left uncovered (real gap), or did no ads load headless?
import { launchWithExtension, waitForEngine, HERE } from "./harness.mjs";
import { mkdirSync } from "fs";
import { join } from "path";
const OUT = join(HERE, "screenshots", "coverage_gap"); mkdirSync(OUT, { recursive: true });

const SITES = [
  "https://minecraft.fandom.com/wiki/Minecraft_Wiki", "https://www.calculator.net/",
  "https://genius.com/", "https://www.crazygames.com/", "https://en.softonic.com/",
  "https://www.coolmathgames.com/",
];
const ctx = await launchWithExtension({ requireGpu: true });
await waitForEngine(ctx, 6 * 60 * 1000);
for (const url of SITES) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);
    // dismiss consent
    for (const fr of page.frames()) { try { for (const b of await fr.$$("button,[role=button]")) { const t = ((await b.innerText().catch(() => "")) || "").trim(); if (/^(accept all|accept|agree|i agree|got it|allow all|reject all|continue|ok|close)$/i.test(t)) await b.click({ timeout: 700 }).catch(() => {}); } } catch {} }
    await page.waitForTimeout(11000);
    const r = await page.evaluate(() => {
      const adSizes = (w, h) => [[728, 90], [970, 250], [300, 250], [336, 280], [300, 600], [160, 600], [320, 50], [468, 60], [970, 90], [250, 250]].some(([aw, ah]) => Math.abs(w - aw) <= 8 && Math.abs(h - ah) <= 8);
      const iframes = [...document.querySelectorAll("iframe")].map((f) => { const b = f.getBoundingClientRect(); let host = ""; try { host = new URL(f.src, location.href).hostname; } catch {} return { w: Math.round(b.width), h: Math.round(b.height), host, adSize: adSizes(Math.round(b.width), Math.round(b.height)), adHost: /doubleclick|googlesyndication|adsystem|amazon-adsystem|adnxs|criteo|pubmatic|rubicon|taboola|outbrain|adsafeprotected|3lift|sharethrough|indexww|ad\./.test(host) };
      }).filter((x) => x.w >= 100 && x.h >= 40);
      const adIframes = iframes.filter((x) => x.adSize || x.adHost);
      const overlays = document.querySelectorAll("[data-minus-overlay]").length;
      return { totalIframes: iframes.length, adIframes, overlays };
    });
    const host = new URL(url).hostname;
    console.log(`\n${host}: overlays=${r.overlays} | iframes(≥100x40)=${r.totalIframes} | AD iframes=${r.adIframes.length}`);
    for (const a of r.adIframes.slice(0, 8)) console.log(`   ${a.w}x${a.h} ${a.adSize ? "[std-size]" : ""}${a.adHost ? "[ad-host]" : ""} ${a.host}`);
    await page.screenshot({ path: join(OUT, `${host}.png`) }).catch(() => {});
  } catch (e) { console.log(`${url}: ERR ${String(e).split("\n")[0]}`); }
  await page.close();
}
await ctx.close();
