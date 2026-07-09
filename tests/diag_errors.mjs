// Fast diagnostic: isolate errors/warnings that originate in OUR extension
// (content.js running in every frame under all_frames, offscreen, background)
// vs the noise the sites throw themselves. Prints them so we can fix real bugs.
import { launchWithExtension, waitForEngine } from "./harness.mjs";

const SITES = [
  "https://www.cbsnews.com/video/",
  "https://weather.com/video",
  "https://www.aljazeera.com/live/",
];

const ctx = await launchWithExtension({ requireGpu: true });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 60000 });
const extId = new URL(sw.url()).host;

const ours = new Map(); // dedup: text -> {count, url}
function record(kind, text, url) {
  const isOurs = (url && url.includes(extId)) || /\[minus\]|content\.js|offscreen\.js|engine-lib/.test(text);
  if (!isOurs) return;
  const key = (kind + " " + text).slice(0, 240);
  const e = ours.get(key) || { count: 0, url };
  e.count++; ours.set(key, e);
}

try {
  console.log("engine:", JSON.stringify(await waitForEngine(ctx, 8 * 60 * 1000)));
  for (const url of SITES) {
    console.log("\n--- " + url);
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") record(m.type(), m.text(), m.location()?.url); });
    page.on("pageerror", (e) => record("pageerror", String(e), ""));
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(35000); // let all_frames spin up across the site's iframes
    } catch (e) { console.log("  nav err:", String(e).split("\n")[0]); }
    await page.close().catch(() => {});
  }
} finally {
  await ctx.close();
}

console.log("\n===== OUR extension errors/warnings (deduped) =====");
if (!ours.size) console.log("(none)");
for (const [text, e] of [...ours.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`x${e.count}  ${text}`);
}
