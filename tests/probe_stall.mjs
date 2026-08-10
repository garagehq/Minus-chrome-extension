// Verify the soak's capture-stall flags are benign (dead/slow sites) rather than
// a real capture wedge: load each flagged live site as the ACTIVE tab and read
// the background capOk counter before/after. A positive delta means the extension
// captured+scanned the page fine, so the stall was a dead-window artifact.
import { launchWithExtension, waitForEngine } from "./harness.mjs";

const SITES = ["https://www.petsmart.com/", "https://www.jakartapost.com/", "https://www.afp.com/en", "https://www.monster.com/", "https://www.dreamwidth.org/"];
const ctx = await launchWithExtension();
const sw = () => ctx.serviceWorkers()[0];
const capOk = () => sw().evaluate(() => globalThis.__minusCapOk || 0).catch(() => -1);
try {
  await waitForEngine(ctx);
  console.log("site                              loaded  capOk_delta  verdict");
  for (const url of SITES) {
    const before = await capOk();
    const pg = await ctx.newPage();
    let loaded = false;
    try {
      const resp = await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      loaded = !!resp && resp.status() < 400;
      await pg.bringToFront();
      await pg.waitForTimeout(9000);
      await pg.evaluate(() => window.scrollBy(0, 1200)).catch(() => {});
      await pg.waitForTimeout(4000);
    } catch (e) { loaded = false; }
    const delta = (await capOk()) - before;
    await pg.close().catch(() => {});
    const host = new URL(url).host.replace(/^www\./, "");
    const verdict = delta > 0 ? "OK (extension captured)" : (loaded ? "NO CAPTURE on a loaded page — investigate" : "site did not load (benign)");
    console.log(`${host.padEnd(32)}  ${String(loaded).padEnd(6)}  ${String(delta).padStart(10)}   ${verdict}`);
  }
} finally { await ctx.close().catch(() => {}); }
process.exit(0);
