// Toolbar badge + icon-state regression on the loaded extension. Guards:
//  - initActionStyle() set the brand-blue badge background
//  - setIcon accepts the packaged red icon set in the MV3 worker
//  - paintAction() shows the count while blocking and clears it at zero
import { launchWithExtension } from "./harness.mjs";

const ctx = await launchWithExtension({ requireGpu: false });
let failures = 0;
const check = (name, cond, detail) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!cond) failures++; };

try {
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  const page = await ctx.newPage();
  await page.goto("data:text/html,<title>t</title><h1>hi</h1>");

  const tabId = await sw.evaluate(async () => {
    const t = (await chrome.tabs.query({})).find((t) => t.url && t.url.startsWith("data:"));
    return t ? t.id : null;
  });
  check("found the content tab", tabId != null, `tabId=${tabId}`);

  const bg = await sw.evaluate((id) => chrome.action.getBadgeBackgroundColor({ tabId: id }), tabId);
  check("badge background is brand blue [59,130,246,255]", JSON.stringify(bg) === JSON.stringify([59, 130, 246, 255]), JSON.stringify(bg));

  const iconErr = await sw.evaluate(async (id) => {
    try {
      await chrome.action.setIcon({ tabId: id, path: { 16: "icons/m-red-16.png", 32: "icons/m-red-32.png", 48: "icons/m-red-48.png", 128: "icons/m-red-128.png" } });
      return null;
    } catch (e) { return String(e); }
  }, tabId);
  check("setIcon accepts red icon set (no throw)", iconErr === null, iconErr || "ok");

  const b3 = await sw.evaluate(async (id) => { await paintAction(id, 3); return chrome.action.getBadgeText({ tabId: id }); }, tabId);
  check('paintAction(3) shows "3" badge', b3 === "3", `badge="${b3}"`);

  const b0 = await sw.evaluate(async (id) => { await paintAction(id, 0); return chrome.action.getBadgeText({ tabId: id }); }, tabId);
  check("paintAction(0) clears the badge", b0 === "", `badge="${b0}"`);
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]);
  failures++;
} finally {
  await ctx.close();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall green");
process.exit(failures ? 1 : 0);
