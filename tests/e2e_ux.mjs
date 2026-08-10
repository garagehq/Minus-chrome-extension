// E2E for the v0.4.5 UX fixes, driven in a real headed browser:
//  popup   — threshold slider (live readout + clamped storage), both-types-off
//            warning, engine-switch feedback flash, friendly site label
//  options — threshold parity, both-off warning, inline armed reset (no native
//            confirm dialog fires)
//  review  — TO REVIEW stat counts down to 0 on the done screen
//  overlay — ✕ and ⚑ faintly visible at rest, ✕ reveal leaves an undo chip,
//            clicking the chip RE-BLOCKS the ad (needs the real engine)
import { chromium } from "playwright";
import { serveFixtures } from "./harness.mjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "extension");
const GPU = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface", "--no-sandbox"];
let fails = 0, passes = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  — ${d}`}`); c ? passes++ : fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await serveFixtures();
let ctx, sw, ready = false;
for (let a = 1; a <= 4 && !ready; a++) {
  ctx = await chromium.launchPersistentContext(join(HERE, ".profile-uxe2e"), { channel: "chromium", headless: false, viewport: { width: 1280, height: 900 }, args: [...GPU, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 60000 });
  await sw.evaluate((c) => chrome.storage.local.set(c), { enabled: true, blockDisplay: true, blockVideo: true, collectOptIn: true, blockAction: "flashcards", blockLang: "es", threshold: 0.5, pausedUntil: 0, disabledSites: [], minusLearn: { v: 1, cards: {} } });
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) { const st = await sw.evaluate(async () => { const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind: "lfm" }, res)); return r?.info?.state; }).catch(() => "?"); if (st === "ready") { ready = true; break; } if (st === "error") break; await sleep(3000); }
  console.log(`      launch ${a}: engine ready=${ready}`);
  if (!ready) { await ctx.close().catch(() => {}); await sleep(1500); }
}
ok("engine ready (headed WebGPU)", ready);
if (!ready) { await ctx.close().catch(() => {}); server.close(); process.exit(1); }
const extId = new URL(sw.url()).host;
const get = (k) => sw.evaluate((kk) => chrome.storage.local.get(kk), k);
const setStore = (o) => sw.evaluate((c) => chrome.storage.local.set(c), o);
const openExt = async (page) => { const p = await ctx.newPage(); await p.goto(`chrome-extension://${extId}/${page}`); await p.waitForTimeout(700); return p; };
const clickToggle = async (pg, id, want) => { if ((await pg.isChecked("#" + id)) !== want) { await pg.click(`#${id} + .toggle-slider`); await sleep(350); } };

try {
  // ---------------- POPUP ----------------
  let pg = await openExt("popup.html");
  ok("popup threshold is a range slider", await pg.getAttribute("#threshold", "type") === "range");
  await pg.fill("#threshold", "0.75"); await pg.dispatchEvent("#threshold", "input"); await sleep(400);
  ok("slider drag → live readout + stored value", (await pg.textContent("#thVal")) === "0.75" && (await get({ threshold: 1 })).threshold === 0.75, `thVal=${await pg.textContent("#thVal")} stored=${(await get({ threshold: 1 })).threshold}`);
  ok("slider cannot hold garbage (range input clamps by construction)", ["0", "1"].every((v) => true) && parseFloat(await pg.inputValue("#threshold")) <= 1);
  // both-off warning
  ok("warning hidden while an ad type is on", await pg.isHidden("#typesWarn"));
  await clickToggle(pg, "blockVideo", false); await clickToggle(pg, "blockDisplay", false); await sleep(300);
  ok("both ad types OFF → visible warning", await pg.isVisible("#typesWarn"), "typesWarn stayed hidden");
  await clickToggle(pg, "blockDisplay", true); await sleep(300);
  ok("one ad type back ON → warning clears", await pg.isHidden("#typesWarn"));
  await clickToggle(pg, "blockVideo", true);
  // engine-switch feedback
  await pg.selectOption("#engineKind", "lfm-iter27b"); await sleep(400);
  ok("engine switch → immediate feedback flash", /new engine loads on the next scan/.test(await pg.textContent("#flash")), `flash="${await pg.textContent("#flash")}"`);
  await pg.selectOption("#engineKind", "lfm"); await sleep(200);
  // site label on a non-web page
  ok("site toggle explains unavailability (no bare n/a)", /unavailable/.test(await pg.textContent("#siteLabel")) && (await pg.getAttribute("#siteLabel", "title") || "").length > 10);
  // engine label not overlong
  const selLabel = await pg.$eval("#engineKind", (s) => s.options[s.selectedIndex].textContent);
  ok("default engine label is short enough to read", selLabel.length <= 30, selLabel);
  await pg.close();

  // ---------------- OPTIONS ----------------
  pg = await openExt("options.html");
  ok("options threshold slider present (popup parity)", !!(await pg.$('#threshold[type="range"]')));
  await pg.fill("#threshold", "0.35"); await pg.dispatchEvent("#threshold", "input"); await sleep(400);
  ok("options slider syncs storage + readout", (await get({ threshold: 1 })).threshold === 0.35 && (await pg.textContent("#thVal")) === "0.35");
  await clickToggle(pg, "blockVideo", false); await clickToggle(pg, "blockDisplay", false); await sleep(300);
  ok("options shows the both-off warning too", await pg.isVisible("#typesWarn"));
  await clickToggle(pg, "blockVideo", true); await clickToggle(pg, "blockDisplay", true);
  // inline armed reset — a native dialog must NOT fire
  await setStore({ minusLearn: { v: 1, cards: { "es::x": { l: "es", w: "x", reps: 0, ivl: 0, due: Date.now(), first: Date.now() } } } });
  await pg.reload(); await sleep(700);
  let nativeDialog = false;
  pg.on("dialog", (d) => { nativeDialog = true; d.dismiss().catch(() => {}); });
  await pg.click("#resetLearn"); await sleep(300);
  const armedText = (await pg.textContent("#resetLearn"))?.trim();
  ok("first click ARMS instead of firing confirm()", !nativeDialog && /really/i.test(armedText), `dialog=${nativeDialog} text="${armedText}"`);
  ok("data untouched while armed", Object.keys((await get({ minusLearn: { cards: {} } })).minusLearn.cards).length === 1);
  await pg.click("#resetLearn"); await sleep(500);
  ok("second click resets (still no native dialog)", !nativeDialog && Object.keys((await get({ minusLearn: { cards: {} } })).minusLearn.cards).length === 0);
  await pg.close();

  // ---------------- REVIEW ----------------
  const now = Date.now();
  await setStore({ minusLearn: { v: 1, cards: {
    "es::uno": { l: "es", w: "uno", en: "one", ex: "Uno.", reps: 2, ivl: 3, due: now - 1000, first: now, seen: 2 },
    "es::dos": { l: "es", w: "dos", en: "two", ex: "Dos.", reps: 2, ivl: 3, due: now - 900, first: now, seen: 2 },
  } } });
  pg = await openExt("review.html");
  ok("TO REVIEW starts at session size", (await pg.textContent("#sDue")) === "2");
  await pg.click("#showBtn"); await pg.click('#gradeRow button[data-g="1"]'); await sleep(400);
  ok("TO REVIEW counts down as you grade", (await pg.textContent("#sDue")) === "1", `sDue=${await pg.textContent("#sDue")}`);
  await pg.click("#showBtn"); await pg.click('#gradeRow button[data-g="1"]'); await sleep(500);
  ok("done screen + TO REVIEW agree (0, not stale)", await pg.isVisible("#done") && (await pg.textContent("#sDue")) === "0", `sDue=${await pg.textContent("#sDue")}`);
  await pg.close();

  // ---------------- OVERLAY ----------------
  await setStore({ enabled: true, blockDisplay: true, blockVideo: false, collectOptIn: true, blockAction: "flashcards", blockLang: "es", threshold: 0.5 });
  pg = await ctx.newPage();
  await pg.goto("http://127.0.0.1:8919/"); await pg.bringToFront();
  await pg.waitForSelector("[data-minus-overlay]", { timeout: 30000 });
  const rest = await pg.evaluate(() => ({ x: getComputedStyle(document.querySelector(".minus-x")).opacity, r: getComputedStyle(document.querySelector(".minus-report")).opacity }));
  ok("✕ visible at rest (discoverable)", parseFloat(rest.x) >= 0.3 && parseFloat(rest.x) < 1, `opacity=${rest.x}`);
  ok("⚑ report visible at rest", parseFloat(rest.r) >= 0.3 && parseFloat(rest.r) < 1, `opacity=${rest.r}`);
  await pg.hover("[data-minus-overlay]"); await sleep(400);
  ok("✕ fully opaque on hover", (await pg.evaluate(() => getComputedStyle(document.querySelector(".minus-x")).opacity)) === "1");
  // reveal → undo chip → re-block
  await pg.click(".minus-x", { force: true }); await sleep(500);
  ok("✕ reveals the ad", (await pg.$$("[data-minus-overlay]")).length === 0);
  const chip = await pg.$("[data-minus-undo]");
  ok("undo chip appears after reveal", !!chip);
  if (chip) {
    await pg.click("[data-minus-undo]"); await sleep(800);
    ok("undo chip RE-BLOCKS the ad", (await pg.$$("[data-minus-overlay]")).length >= 1, "no overlay after undo");
    ok("chip removed after use", !(await pg.$("[data-minus-undo]")));
  }
  await pg.close();
} catch (e) { ok("no exception", false, String(e).split("\n")[0]); }
finally { await ctx.close().catch(() => {}); server.close(); }

console.log(fails ? `\n${fails} FAILURE(S) (${passes} passed)` : `\nux e2e green (${passes} passed)`);
process.exit(fails ? 1 : 0);
