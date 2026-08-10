// Hands-on UX audit: drive EVERY button/interaction across the popup, options,
// review page and overlays; record what persists, what gives feedback, and what
// feels broken/confusing. Screenshots -> tests/screenshots/ux/. Prints OBS lines.
import { chromium } from "playwright";
import { serveFixtures } from "./harness.mjs";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "extension");
const OUT = join(HERE, "screenshots", "ux");
mkdirSync(OUT, { recursive: true });
const GPU = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface", "--no-sandbox"];
const OBS = (s) => console.log("OBS  " + s);
const shot = (pg, n) => pg.screenshot({ path: join(OUT, n + ".png") }).catch(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await serveFixtures();
const ctx = await chromium.launchPersistentContext(join(HERE, ".profile-ux"), {
  channel: "chromium", headless: false, viewport: { width: 1280, height: 900 }, args: [...GPU, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 60000 });
const extId = new URL(sw.url()).host;
const get = (keys) => sw.evaluate((k) => chrome.storage.local.get(k), keys);
const set = (o) => sw.evaluate((c) => chrome.storage.local.set(c), o);
await set({ enabled: true, blockVideo: true, blockDisplay: true, blockAction: "flashcards", blockLang: "es", collectOptIn: false, disabledSites: [], pausedUntil: 0, threshold: 0.5, engineKind: "lfm", minusLearn: { v: 1, cards: {} } });
const open = async (page) => { const p = await ctx.newPage(); await p.goto(`chrome-extension://${extId}/${page}`); await p.waitForTimeout(600); return p; };
// The toggle switches hide their <input> (0x0, opacity:0) behind a styled slider,
// so a user clicks the SLIDER, not the input. Click it only to reach the wanted state.
async function setToggle(pg, id, want) {
  const is = await pg.isChecked("#" + id).catch(() => null);
  if (is !== want) { await pg.click(`#${id} + .toggle-slider`).catch(() => {}); await sleep(350); }
}

try {
  // ============ POPUP ============
  console.log("\n########## POPUP ##########");
  let pg = await open("popup.html");
  await sleep(800); await shot(pg, "popup_01_initial");
  OBS(`popup site-toggle: label="${await pg.textContent("#siteLabel")}" disabled=${await pg.isDisabled("#siteEnabled")} (opened on an extension page → no host)`);
  OBS(`popup review button: "${(await pg.textContent("#reviewBtn"))?.trim()}"`);
  OBS(`popup status line: "${(await pg.textContent("#status"))?.trim()}"`);

  // master toggle off
  await setToggle(pg,"enabled",false); await sleep(1200);
  OBS(`master OFF → storage.enabled=${(await get({ enabled: 1 })).enabled}, status="${(await pg.textContent("#status"))?.trim()}"`);
  await shot(pg, "popup_02_disabled");
  await setToggle(pg,"enabled",true); await sleep(500);

  // pause
  await pg.click('.pausebtn[data-min="30"]'); await sleep(600);
  const paused1 = await get({ pausedUntil: 0 });
  const pausedRowShown = await pg.isVisible("#pausedRow");
  const msg1 = (await pg.textContent("#pausedMsg"))?.trim();
  await shot(pg, "popup_03_paused");
  await sleep(2600);
  const msg2 = (await pg.textContent("#pausedMsg"))?.trim();
  OBS(`pause 30m → pausedUntil set=${paused1.pausedUntil > Date.now()}, pausedRow shown=${pausedRowShown}, countdown "${msg1}" → "${msg2}" (live tick=${msg1 !== msg2})`);
  await pg.click("#resumeBtn"); await sleep(500);
  OBS(`resume → pausedUntil=${(await get({ pausedUntil: 1 })).pausedUntil} (0=cleared)`);

  // threshold input — validation?
  for (const v of ["abc", "1.5", "-1", "0.72"]) {
    await pg.fill("#threshold", v); await pg.dispatchEvent("#threshold", "change"); await sleep(300);
    OBS(`threshold typed "${v}" → storage.threshold=${(await get({ threshold: 1 })).threshold}, input shows "${await pg.inputValue("#threshold")}" (no visible confirmation)`);
  }
  // engine switch feedback
  await pg.selectOption("#engineKind", "siglip2"); await sleep(900);
  OBS(`engine → siglip2: storage=${(await get({ engineKind: 1 })).engineKind}, status="${(await pg.textContent("#status"))?.trim()}" (any 'switching' feedback?)`);
  await pg.selectOption("#engineKind", "lfm"); await sleep(500);
  // both ad-types off
  await setToggle(pg,"blockVideo",false); await setToggle(pg,"blockDisplay",false); await sleep(500);
  OBS(`both ad-types OFF while master ON → any warning shown? status="${(await pg.textContent("#status"))?.trim()}"`);
  await shot(pg, "popup_04_both_off");
  await setToggle(pg,"blockVideo",true); await setToggle(pg,"blockDisplay",true);
  // review button opens a tab
  const before = ctx.pages().length;
  await pg.click("#reviewBtn"); await sleep(800);
  OBS(`review button → opened ${ctx.pages().length - before} new tab`);
  for (const p of ctx.pages()) if (p.url().includes("review.html")) await p.close();
  await pg.close();

  // ============ OPTIONS ============
  console.log("\n########## OPTIONS ##########");
  pg = await open("options.html"); await sleep(600); await shot(pg, "options_01_initial");
  OBS(`options has a threshold control? ${await pg.$("#threshold") ? "yes" : "NO (popup has it, options doesn't — inconsistent)"}`);
  // block action → minimal
  await pg.check("#actMinimal",{force:true}); await sleep(500);
  OBS(`block action=minimal → blockLang disabled=${await pg.isDisabled("#blockLang")}, preview word="${(await pg.textContent("#pvW"))?.trim()}", saved="${(await pg.textContent("#saved"))?.trim()}"`);
  await shot(pg, "options_02_minimal");
  await pg.check("#actFlash",{force:true}); await sleep(400);
  // language → Greek
  await pg.selectOption("#blockLang", "el"); await sleep(700);
  OBS(`language=Greek → preview word="${(await pg.textContent("#pvW"))?.trim()}" en="${(await pg.textContent("#pvEn"))?.trim()}"`);
  await shot(pg, "options_03_greek");
  const w1 = (await pg.textContent("#pvW"))?.trim();
  await pg.click("#preview"); await sleep(400);
  OBS(`click preview → new card? "${w1}" → "${(await pg.textContent("#pvW"))?.trim()}"`);
  // confidence toggle
  await setToggle(pg,"showConfidence",false); await sleep(400);
  OBS(`showConfidence OFF → preview p-tag visible=${await pg.isVisible("#pvP")}`);
  await setToggle(pg,"showConfidence",true);
  // disabled sites normalization
  await pg.fill("#disabledSites", "Example.COM\nhttps://News.Site.org/path\n\nfoo"); await pg.dispatchEvent("#disabledSites", "change"); await sleep(400);
  OBS(`disabledSites input normalized → "${(await pg.inputValue("#disabledSites")).replace(/\n/g, "|")}" stored=${JSON.stringify((await get({ disabledSites: [] })).disabledSites)}`);
  // reset learning (confirm dialog)
  await set({ minusLearn: { v: 1, cards: { "es::x": { l: "es", w: "x", reps: 0, ivl: 0, due: Date.now() } } } });
  pg.once("dialog", (d) => { OBS(`reset-progress uses a native confirm(): "${d.message()}"`); d.accept(); });
  await pg.click("#resetLearn"); await sleep(600);
  OBS(`reset → learn cards now=${Object.keys((await get({ minusLearn: { cards: {} } })).minusLearn.cards).length}, saved="${(await pg.textContent("#saved"))?.trim()}"`);
  await pg.close();

  // ============ REVIEW ============
  console.log("\n########## REVIEW ##########");
  const now = Date.now();
  await set({ minusLearn: { v: 1, cards: {
    "es::hola": { l: "es", w: "hola", en: "hi", ex: "Hola!", reps: 0, ivl: 0, due: now, first: now, seen: 2 },
    "es::gato": { l: "es", w: "gato", en: "cat", ex: "El gato.", reps: 2, ivl: 3, due: now - 1000, first: now, seen: 4 },
    "el::nero": { l: "el", w: "το νερό", en: "the water", ex: "Πίνω νερό.", reps: 0, ivl: 0, due: now, first: now, seen: 1 },
  } } });
  pg = await open("review.html"); await sleep(700); await shot(pg, "review_01_card");
  OBS(`review stats: seen=${await pg.textContent("#sSeen")} learning=${await pg.textContent("#sLearning")} learned=${await pg.textContent("#sLearned")} due=${await pg.textContent("#sDue")}, progress="${await pg.textContent("#progress")}"`);
  OBS(`review front card: lang="${(await pg.textContent("#cLang"))?.trim()}" word="${(await pg.textContent("#cWord"))?.trim()}", answer hidden=${await pg.isHidden("#cEn")}`);
  await pg.click("#showBtn"); await sleep(300);
  OBS(`show answer → en="${(await pg.textContent("#cEn"))?.trim()}" gradeRow visible=${await pg.isVisible("#gradeRow")}`);
  await shot(pg, "review_02_revealed");
  await pg.click('#gradeRow button[data-g="1"]'); await sleep(400);
  OBS(`graded Good → next card word="${(await pg.textContent("#cWord"))?.trim()}"`);
  // keyboard
  await pg.keyboard.press("Space"); await sleep(200);
  const kbReveal = await pg.isVisible("#gradeRow");
  await pg.keyboard.press("2"); await sleep(300);
  OBS(`keyboard: Space revealed=${kbReveal}, "2" graded → progress="${await pg.textContent("#progress")}"`);
  // language filter
  const langOpts = await pg.$$eval("#lang option", (os) => os.map((o) => o.textContent));
  OBS(`review language filter options: ${JSON.stringify(langOpts)}`);
  // exhaust to done
  for (let i = 0; i < 6; i++) { if (await pg.isVisible("#showBtn")) { await pg.click("#showBtn").catch(() => {}); await sleep(150); } await pg.click('#gradeRow button[data-g="1"]').catch(() => {}); await sleep(200); }
  await sleep(300); await shot(pg, "review_03_done");
  OBS(`after clearing queue: done shown=${await pg.isVisible("#done")}, doneBig="${(await pg.textContent("#doneBig"))?.trim()}"`);
  await pg.close();
  // empty state
  await set({ minusLearn: { v: 1, cards: {} } });
  pg = await open("review.html"); await sleep(500); await shot(pg, "review_04_empty");
  OBS(`empty review: doneBig="${(await pg.textContent("#doneBig"))?.trim()}" msg="${(await pg.textContent("#doneMsg"))?.trim()}"`);
  await pg.close();

  // ============ OVERLAY (needs engine) ============
  console.log("\n########## OVERLAY ##########");
  await set({ enabled: true, blockDisplay: true, blockVideo: false, collectOptIn: true, blockAction: "flashcards", blockLang: "es" });
  // warm engine
  let ready = false;
  for (let i = 0; i < 40; i++) { const st = await sw.evaluate(async () => { const r = await new Promise((res) => chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind: "lfm" }, res)); return r?.info?.state; }).catch(() => "?"); if (st === "ready") { ready = true; break; } await sleep(3000); }
  OBS(`overlay test engine ready=${ready}`);
  if (ready) {
    pg = await ctx.newPage(); await pg.goto("http://127.0.0.1:8919/"); await pg.bringToFront();
    await pg.waitForSelector("[data-minus-overlay]", { timeout: 30000 }).catch(() => {});
    const ov = await pg.$$("[data-minus-overlay]");
    OBS(`fixture ad → ${ov.length} overlay(s)`);
    await shot(pg, "overlay_01_covered");
    // is the ✕ reveal discoverable without hover?
    const xVisibleNoHover = await pg.evaluate(() => { const x = document.querySelector(".minus-x"); if (!x) return null; return getComputedStyle(x).opacity; });
    OBS(`✕ reveal button opacity at rest (no hover) = ${xVisibleNoHover} (0 = invisible until hover → discoverability?)`);
    const reportBtn = await pg.$(".minus-report");
    OBS(`⚑ not-an-ad button present (collectOptIn on) = ${!!reportBtn}`);
    if (reportBtn) { const rOp = await pg.evaluate(() => getComputedStyle(document.querySelector(".minus-report")).opacity); OBS(`⚑ report opacity at rest = ${rOp}`); }
    // hover reveals?
    await pg.hover("[data-minus-overlay]").catch(() => {});
    await sleep(400); await shot(pg, "overlay_02_hover");
    const xOnHover = await pg.evaluate(() => { const x = document.querySelector(".minus-x"); return x ? getComputedStyle(x).opacity : "none"; });
    OBS(`✕ opacity on hover = ${xOnHover}`);
    // click ✕ to reveal ad
    const nBefore = (await pg.$$("[data-minus-overlay]")).length;
    await pg.click(".minus-x", { force: true }).catch(() => {});
    await sleep(500);
    OBS(`clicked ✕ → overlays ${nBefore} → ${(await pg.$$("[data-minus-overlay]")).length} (ad revealed, no undo affordance)`);
    await pg.close();
  }
} catch (e) { OBS("EXCEPTION: " + String(e).split("\n")[0]); }
finally { await ctx.close().catch(() => {}); server.close(); }
console.log("\nUX audit done — screenshots in tests/screenshots/ux/");
process.exit(0);
