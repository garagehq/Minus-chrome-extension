// "Block ads (all sites)" OFF must fully unload the model: the offscreen
// document (which holds the ~1-2GB engine) is closed, status reports "off"
// without resurrecting it, classify refuses, and re-enabling brings it back.
import { launchWithExtension } from "./harness.mjs";

const ctx = await launchWithExtension({ requireGpu: false });
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };
try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 30000 });
  const extId = new URL(sw.url()).host;
  const pg = await ctx.newPage();
  await pg.goto(`chrome-extension://${extId}/popup.html`);

  const hasOffscreen = () => sw.evaluate(async () => {
    const cs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return cs.length > 0;
  });
  const until = async (fn, want, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if ((await fn()) === want) return true; await new Promise((r) => setTimeout(r, 400)); }
    return false;
  };

  await sw.evaluate(() => chrome.storage.local.set({ enabled: true }));
  check("offscreen document exists while enabled", await until(hasOffscreen, true), "");

  // toggle OFF -> document (and the engine in it) must go away
  await sw.evaluate(() => chrome.storage.local.set({ enabled: false }));
  check("offscreen document CLOSED when blocking disabled", await until(hasOffscreen, false), "");

  // status must report off WITHOUT recreating the document (popup polls this)
  const st = await pg.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ type: "minus:engine-status" }, res)));
  check('engine-status reports "off" while disabled', st?.info?.state === "off", JSON.stringify(st?.info));
  await new Promise((r) => setTimeout(r, 1200));
  check("status poll did NOT resurrect the document", (await hasOffscreen()) === false);

  // classify must refuse (a racing tab can't reload the model)
  const cl = await pg.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ type: "minus:classify", images: ["data:image/png;base64,xx"] }, res)));
  check("classify refused while disabled", cl?.ok === false, JSON.stringify(cl));
  check("classify did NOT resurrect the document", (await hasOffscreen()) === false);

  // toggle back ON -> document returns (engine warms lazily)
  await sw.evaluate(() => chrome.storage.local.set({ enabled: true }));
  check("offscreen document RECREATED on re-enable", await until(hasOffscreen, true), "");
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]); fail++;
} finally {
  await ctx.close();
}
console.log(fail ? `\n${fail} FAILURE(S)` : "\nunload-on-disable green");
process.exit(fail ? 1 : 0);
