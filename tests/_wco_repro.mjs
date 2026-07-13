import { launchWithExtension, waitForEngine } from "./harness.mjs";
const ctx = await launchWithExtension({ requireGpu: true });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 30000 });
await sw.evaluate(() => chrome.storage.local.set({ engineKind: "lfm", enabled: true, blockVideo: true, blockDisplay: true, disabledSites: [], collectOptIn: false }));
console.log("engine:", JSON.stringify(await waitForEngine(ctx, 8 * 60 * 1000)));
const p = await ctx.newPage();
await p.goto("https://wco.tv/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(e => console.log("nav:", String(e).split("\n")[0]));
await p.waitForTimeout(4000);
console.log("title:", await p.title().catch(()=>"?"));
// instrument: track overlay add/remove events with timestamps, kind, and covered-region geometry
await p.evaluate(() => {
  window.__ovEvents = [];
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) if (n.nodeType===1 && n.hasAttribute?.("data-minus-overlay")) {
        const r = n.getBoundingClientRect();
        window.__ovEvents.push({ t: Date.now(), ev: "ADD", kind: n.dataset.minusKind, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) });
      }
      for (const n of m.removedNodes) if (n.nodeType===1 && n.hasAttribute?.("data-minus-overlay")) {
        window.__ovEvents.push({ t: Date.now(), ev: "REMOVE", kind: n.dataset.minusKind });
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
});
// also inventory the ad iframes present
const frames = await p.evaluate(() => [...document.querySelectorAll("iframe")].map(f => { const r=f.getBoundingClientRect(); return { src:(f.src||"").slice(0,80), w:Math.round(r.width), h:Math.round(r.height) }; }).filter(f => f.w>50 && f.h>30));
console.log("iframes:", JSON.stringify(frames, null, 1));
await p.waitForTimeout(90000);   // watch 90s for oscillation
const ev = await p.evaluate(() => window.__ovEvents);
console.log("overlay events over 90s:", ev.length);
let t0 = ev[0]?.t;
for (const e of ev) console.log(`  +${((e.t-t0)/1000).toFixed(1)}s ${e.ev} ${e.kind||""} ${e.w?e.w+"x"+e.h+" @"+e.x+","+e.y:""}`);
await ctx.close();
