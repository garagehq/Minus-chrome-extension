// GPU-backed integration test for the options page + configurable block action.
// Loads the extension, blocks a fixture ad, then drives the options page and
// asserts the LIVE overlay re-renders: flashcard language switch (Spanish →
// French deck word appears), minimal style switch ("blocked by minus" card),
// confidence-tag toggle. Not in npm test (needs GPU + model); run standalone:
//   node tests/test_options_page_live.mjs
import { launchWithExtension, serveFixtures, waitForEngine } from "./harness.mjs";

const server = await serveFixtures();
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
};

const ctx = await launchWithExtension({ requireGpu: true });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 60000 });
const extId = new URL(sw.url()).host;
await sw.evaluate((cfg) => chrome.storage.local.set(cfg), {
  enabled: true, blockDisplay: true, blockVideo: true, disabledSites: [],
  blockAction: "flashcards", blockLang: "es", showConfidence: true,
});
console.log("engine:", JSON.stringify(await waitForEngine(ctx, 8 * 60 * 1000)));

// 1. block a fixture ad
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:8919/", { waitUntil: "load" });
await page.bringToFront();
await page.waitForSelector("[data-minus-overlay]", { timeout: 120000 });
const overlayText = () => page.evaluate(() => document.querySelector("[data-minus-overlay]")?.textContent || "");
ok("fixture ad covered with a flashcard overlay", (await overlayText()).length > 0);
ok("confidence tag shown by default", /ad \d+%/.test(await overlayText()), await overlayText());

// 2. open the options page and drive it
const opts = await ctx.newPage();
await opts.goto(`chrome-extension://${extId}/options.html`, { waitUntil: "domcontentloaded" });
ok("options page renders (brand + sections)", await opts.evaluate(() =>
  document.querySelector(".brand")?.textContent.includes("Minus") &&
  document.querySelectorAll("section").length >= 5));
// dropdowns populate async (deck JSON fetches) — wait for load() to finish
await opts.waitForFunction(() =>
  document.getElementById("engineKind").options.length >= 3 &&
  document.getElementById("blockLang").options.length >= 2, { timeout: 20000 });
ok("engine dropdown populated from index.json", await opts.evaluate(() =>
  document.getElementById("engineKind").options.length >= 3));
ok("language dropdown lists all decks", await opts.evaluate(() =>
  document.getElementById("blockLang").options.length === Object.keys(MINUS_DECKS).length));
ok("dropdown labels show 500-card counts", await opts.evaluate(() =>
  [...document.getElementById("blockLang").options].every((o) => o.textContent.includes("(500 cards)"))));

// 3. switch language → French; live overlay should re-render with a French card
await opts.selectOption("#blockLang", "fr");
await page.waitForTimeout(700);
const frWords = await opts.evaluate(async () => (await minusLoadDeck("fr")).map((c) => c.w));
const t1 = await overlayText();
ok("overlay re-rendered with a French card", frWords.some((w) => t1.includes(w)), t1.slice(0, 80));

// 4. switch to minimal
await opts.click("#actMinimal");
await page.waitForTimeout(700);
const t2 = await overlayText();
ok("overlay re-rendered as minimal card", t2.includes("This ad has been blocked by minus."), t2.slice(0, 80));
ok("preview shows minimal too", await opts.evaluate(() =>
  document.getElementById("pvEx").textContent.includes("blocked by minus")));

// 5. confidence toggle off
await opts.click("#showConfidence + .toggle-slider"); // the checkbox itself is opacity:0
await page.waitForTimeout(700);
ok("confidence tag removed live", !/ad \d+%/.test(await overlayText()), await overlayText());

// 6. X still reveals after re-render (handler re-wired)
await page.evaluate(() => document.querySelector("[data-minus-overlay] .minus-x").click());
await page.waitForTimeout(400);
ok("X reveal works on re-rendered overlay", await page.evaluate(() =>
  !document.querySelector("[data-minus-overlay]")));

await ctx.close();
server.close();
console.log(failures ? `\n${failures} failure(s)` : "\noptions-page live test green");
process.exit(failures ? 1 : 0);
