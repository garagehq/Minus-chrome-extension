// End-to-end for the learning loop: block a real fixture ad -> a flashcard word
// is shown -> content records the exposure -> background persists it -> the
// review page renders the card and a grade updates its SRS schedule. Uses the
// Greek deck so the whole el pipeline (deck fetch + record + review) is covered.
import { launchWithExtension, serveFixtures, waitForEngine } from "./harness.mjs";

const server = await serveFixtures();
const ctx = await launchWithExtension();
let fails = 0, passes = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  — ${d}`}`); c ? passes++ : fails++; };
const sw = () => ctx.serviceWorkers()[0];
const getLearn = () => sw().evaluate(() => chrome.storage.local.get("minusLearn").then((r) => r.minusLearn || { cards: {} }));

try {
  // flashcards ON, Greek deck, contribution OFF
  await sw().evaluate((c) => chrome.storage.local.set(c),
    { enabled: true, blockDisplay: true, blockVideo: false, blockAction: "flashcards", blockLang: "el", disabledSites: [], minusLearn: { v: 1, cards: {} } });
  ok("engine ready", !!(await waitForEngine(ctx)));

  const extId = new URL(sw().url()).host;

  // 1) Load the fixture ad page; wait for an overlay (a flashcard was rendered).
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:8919/");
  await page.waitForSelector("[data-minus-overlay]", { timeout: 30000 });
  const shownWord = await page.evaluate(() => document.querySelector("[data-minus-overlay] .minus-es")?.textContent || "");
  ok("a flashcard word is shown over the blocked ad", shownWord.trim().length > 0, `word="${shownWord}"`);
  ok("the shown word is Greek (el deck loaded)", /[Ͱ-Ͽ]/.test(shownWord), shownWord);

  // 2) Background coalesces exposures and flushes after ~4s -> assert it persisted.
  let learn = { cards: {} };
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1000);
    learn = await getLearn();
    if (Object.keys(learn.cards || {}).length > 0) break;
  }
  const keys = Object.keys(learn.cards || {});
  ok("exposure was recorded to storage", keys.length > 0, `cards=${keys.length}`);
  const anyEl = keys.some((k) => (learn.cards[k].l === "el"));
  ok("recorded card is tagged with the el language", anyEl, JSON.stringify(keys.slice(0, 3)));
  ok("a recorded card starts as 'new' (reps 0, due set)", Object.values(learn.cards).every((c) => c.reps === 0 && c.seen >= 1 && c.due));

  // 3) Open the review page; grade the first card 'Good' and confirm it reschedules.
  const rev = await ctx.newPage();
  await rev.goto(`chrome-extension://${extId}/review.html`);
  await rev.waitForSelector("#cWord", { timeout: 15000 });
  const frontWord = await rev.evaluate(() => document.getElementById("cWord").textContent || "");
  ok("review page shows a due/new card", frontWord.trim().length > 0, `front="${frontWord}"`);
  // answer hidden until revealed
  const hiddenBefore = await rev.evaluate(() => document.getElementById("cEn").classList.contains("hidden"));
  ok("answer is hidden before 'Show answer'", hiddenBefore);
  await rev.click("#showBtn");
  const gradeVisible = await rev.evaluate(() => !document.getElementById("gradeRow").classList.contains("hidden"));
  ok("grade buttons appear after reveal", gradeVisible);
  await rev.click('#gradeRow button[data-g="1"]');   // Good
  await rev.waitForTimeout(500);

  const after = await getLearn();
  const graded = Object.values(after.cards).filter((c) => (c.reps || 0) > 0);
  ok("grading advanced a card's SRS state (reps > 0)", graded.length >= 1, JSON.stringify(Object.values(after.cards).map((c) => c.reps)));
  ok("graded card is scheduled into the future", graded.every((c) => c.due > Date.now()));
  ok("grading a new card recorded a new-card for today", !!after.newToday && after.newToday.count >= 1);
} catch (e) {
  ok("no exception", false, String(e).split("\n")[0]);
} finally {
  await ctx.close().catch(() => {});
  server.close();
}

console.log(fails ? `\n${fails} FAILURE(S) (${passes} passed)` : `\nlearning e2e green (${passes} passed)`);
process.exit(fails ? 1 : 0);
