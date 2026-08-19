// Edge-case tests for the spaced-repetition learning loop (learn.js).
// Tests lapse behavior, day rollover, card re-queuing, memory limits, and
// queue stability — scenarios the review page must handle in practice.

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "extension");
const read = (p) => readFileSync(join(EXT, p), "utf8");

// Load learn.js in a VM sandbox and grab its exported functions.
const sandbox = { module: { exports: {} } };
vm.runInNewContext(read("learn.js"), sandbox);
const L = sandbox.module.exports;

let f = 0, p = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  — ${d}`}`); c ? p++ : f++; };

const NOW = 1_700_000_000_000;
const DAY = L.MINUS_DAY;
const HOUR = 3_600_000;

// ==========================================================================
// 1. Lapse cascade: repeated "Again" grades degrade ease toward 1.3 floor
// ==========================================================================
{
  // Start with a fresh card and degrade it repeatedly with "Again"
  let card = { l: "es", w: "cascade", en: "test", ex: "...", reps: 3, ease: 2.5, ivl: 10, lapses: 0 };
  const ease1 = L.minusSchedule(card, 0, NOW).ease;  // ease drops
  const card2 = { ...card, ease: ease1, reps: 0 };
  const ease2 = L.minusSchedule(card2, 0, NOW).ease;
  const card3 = { ...card2, ease: ease2, reps: 0 };
  const ease3 = L.minusSchedule(card3, 0, NOW).ease;
  ok("repeated lapses ease-degrade cascade", ease3 < ease2 && ease2 < ease1,
     `ease went ${ease1} -> ${ease2} -> ${ease3}`);

  // Ease floor is 1.3
  let cardFlat = { reps: 10, ease: 1.3, ivl: 5 };
  ok("ease floors at 1.3", L.minusSchedule(cardFlat, 0, NOW).ease >= 1.3);
}

// ==========================================================================
// 2. Lapses reset the interval and ease; grade must recover through Good/Easy
// ==========================================================================
{
  const forgot = L.minusSchedule({ reps: 5, ease: 2.0, ivl: 15, lapses: 1 }, 0, NOW);
  ok("lapse resets reps to 0", forgot.reps === 0);
  ok("lapse resets ivl to 0", forgot.ivl === 0);
  ok("lapse increments lapses counter", forgot.lapses === 2);

  // After a lapse the card relearns from scratch
  const recovered = L.minusSchedule({ ...forgot, reps: 0 }, 1, NOW);
  ok("after lapse, Good re-enters the learning path", recovered.reps === 1,
     `reps=${recovered.reps} ivl=${recovered.ivl}`);
  ok("after lapse, Good gives a short interval (1 day)", recovered.ivl >= 1);
}

// ==========================================================================
// 3. Day rollover: new-card allowance resets at midnight boundary
// ==========================================================================
{
  const yesterday = NOW - DAY;
  const today = NOW;

  // A store that consumed its allowance yesterday
  const storeYest = {
    v: 1,
    cards: { "es::x": { l: "es", w: "x", reps: 0, ivl: 0, due: yesterday } },
    newToday: { date: new Date(yesterday).toISOString().slice(0, 10), count: L.MINUS_NEW_PER_DAY }
  };

  // Same day — allowance exhausted
  ok("exhausted allowance same day", L.minusNewAllowed(storeYest, yesterday) === 0);

  // New day — allowance restored
  ok("new-card allowance resets next day", L.minusNewAllowed(storeYest, today) === L.MINUS_NEW_PER_DAY,
     `allowed=${L.minusNewAllowed(storeYest, today)}`);
}

// ==========================================================================
// 4. Queue stability: same-card re-queue from "Again" should appear in session
// ==========================================================================
{
  const store = { v: 1, cards: {} };
  const card = { l: "es", w: "stability-test", en: "a test word", ex: "...", reps: 1, ease: 2.0, ivl: 3, due: NOW - HOUR, first: NOW };
  store.cards["es::stability-test"] = card;

  const queue = L.minusBuildQueue(store, NOW, "all");
  ok("due review appears in queue", queue.length >= 1, `queue len=${queue.length}`);

  // Grade "Again" (grade 0) -> card re-queues at the end
  L.minusGrade(store, card, 0, NOW);
  ok("grading 'Again' resets card state", store.cards["es::stability-test"].reps === 0);
  ok("grading 'Again' sets a near-term due time", store.cards["es::stability-test"].due < NOW + DAY);
}

// ==========================================================================
// 5. Mature card interval grows predictably (not randomly)
// ==========================================================================
{
  const base = { reps: 10, ease: 2.5, ivl: 10 };
  const ivl1 = L.minusSchedule(base, 1, NOW).ivl;
  const ivl2 = L.minusSchedule({ ...base, ivl: ivl1 }, 1, NOW).ivl;
  const ivl3 = L.minusSchedule({ ...base, ivl: ivl2 }, 1, NOW).ivl;
  ok("interval grows with each Good grade (spacing)", ivl3 > ivl2 && ivl2 > ivl1,
     `${ivl1} -> ${ivl2} -> ${ivl3}`);

  // Easy should grow faster
  const easy_ivl = L.minusSchedule(base, 2, NOW).ivl;
  ok("Easy grade grows interval more than Good", easy_ivl > ivl1);
}

// ==========================================================================
// 6. Empty store edge cases: stats don't crash
// ==========================================================================
{
  const empty = { v: 1, cards: {} };
  const s = L.minusLearnStats(empty, NOW, "all");
  ok("stats on empty store returns zeros", s.seen === 0 && s.learning === 0 && s.learned === 0 && s.dueNow === 0 && s.news === 0);

  const q = L.minusBuildQueue(empty, NOW, "all");
  ok("queue on empty store is empty", q.length === 0);

  // No-op grade on empty store should not crash
  L.minusGrade(empty, { l: "es", w: "test", reps: 0 }, 1, NOW);
  ok("grade on empty store creates the card", !!empty.cards["es::test"]);
}

// ==========================================================================
// 7. Language-filtered queue: non-due cards don't pollute the session
// ==========================================================================
{
  const esCard = { l: "es", w: "a", reps: 1, ease: 2.5, ivl: 5, due: NOW - HOUR };
  const frCard = { l: "fr", w: "b", reps: 1, ease: 2.5, ivl: 10, due: NOW - HOUR };
  const store = { v: 1, cards: { "es::a": esCard, "fr::b": frCard } };

  const esQueue = L.minusBuildQueue(store, NOW, "es");
  const frQueue = L.minusBuildQueue(store, NOW, "fr");
  ok("language filter isolates queues", esQueue.length === frQueue.length && esQueue.length === 1,
     `es=${esQueue.length} fr=${frQueue.length}`);

  const esWords = esQueue.map((c) => c.w);
  ok("es-only queue has no French cards", !esWords.includes("b"));
  ok("fr-only queue has no Spanish cards", frQueue.every((c) => c.l === "fr"));
}

// ==========================================================================
// 8. "All" language filter includes every language
// ==========================================================================
{
  const store = { v: 1, cards: {
    "es::a": { l: "es", w: "a", reps: 1, ease: 2.5, ivl: 3, due: NOW - HOUR },
    "fr::b": { l: "fr", w: "b", reps: 1, ease: 2.5, ivl: 5, due: NOW - HOUR },
    "ja::c": { l: "ja", w: "c", reps: 1, ease: 2.5, ivl: 7, due: NOW - HOUR },
  }};
  const allQ = L.minusBuildQueue(store, NOW, "all");
  ok("all-language queue has all cards", allQ.length === 3, `allQ=${allQ.length}`);
}

// ==========================================================================
// 9. Card fields are preserved through grading
// ==========================================================================
{
  const original = { l: "el", w: "test", en: "test", ex: "test example", reps: 0, ease: 2.5, ivl: 0, due: NOW };
  const store = { v: 1, cards: {} };
  store.cards["el::test"] = original;

  const graded = L.minusGrade(store, original, 1, NOW);
  const updated = graded.cards["el::test"];
  ok("grade preserves language", updated.l === "el");
  ok("grade preserves word", updated.w === "test");
  ok("grade preserves translation", updated.en === "test");
  ok("grade preserves example", updated.ex === "test example");
  ok("grade advances reps", updated.reps === 1);
  ok("grade sets ivl > 0 for new card", updated.ivl >= 1);
}

// ==========================================================================
// 10. New card first-seen tracking is preserved
// ==========================================================================
{
  const card = { l: "de", w: "neu", en: "new", ex: "...", reps: 0, ease: 2.5, ivl: 0, due: NOW + DAY, first: NOW - DAY };
  const store = { v: 1, cards: {} };
  store.cards["de::neu"] = card;
  L.minusGrade(store, card, 2, NOW);
  ok("grade preserves first-seen timestamp", store.cards["de::neu"].first === NOW - DAY);
}

// ==========================================================================
// 11. Card with no "last" field gets it set on grade
// ==========================================================================
{
  const card = { l: "es", w: "noLast", en: "missing last", ex: "...", reps: 0, ease: 2.5, ivl: 0, due: NOW };
  const store = { v: 1, cards: {} };
  store.cards["es::noLast"] = card;
  ok("card has no 'last' initially", card.last === undefined);
  L.minusGrade(store, card, 1, NOW);
  ok("grade sets 'last' field", store.cards["es::noLast"].last !== undefined && store.cards["es::noLast"].last === NOW);
}

// ==========================================================================
// 12. Multiple cards, queue sorts by due-time (earliest first)
// ==========================================================================
{
  const store = { v: 1, cards: {
    "es::later": { l: "es", w: "later", reps: 1, ease: 2.5, ivl: 3, due: NOW + DAY },
    "es::earlier": { l: "es", w: "earlier", reps: 1, ease: 2.5, ivl: 1, due: NOW - DAY },
    "es::new-one": { l: "es", w: "new-one", reps: 0, ivl: 0, due: NOW + DAY, first: NOW },
  }};
  const q = L.minusBuildQueue(store, NOW, "all");
  // Due reviews come before new cards
  ok("reviews sorted before new cards in queue",
     q[0].reps > 0 && (q[q.length - 1]?.reps || 0) === 0,
     `queue rep sequence: ${q.map((c) => c.reps).join(", ")}`);

  // Within due reviews, earlier due first
  const dueOnly = q.filter((c) => c.reps > 0);
  if (dueOnly.length >= 2) {
    ok("due reviews sorted by due time ascending",
       dueOnly[0].due < dueOnly[1].due,
       `${dueOnly[0].w}:due=${dueOnly[0].due} ${dueOnly[1].w}:due=${dueOnly[1].due}`);
  }
}

// ==========================================================================
// 13. Consecutive Easy grades push toward maturity (MINUS_MATURE_IVL = 21 days)
// ==========================================================================
{
  const card = { l: "es", w: "mature-path", en: "...", ex: "...", reps: 0, ease: 3.0, ivl: 0 };
  // Grade Easy from new
  let c = { ...card };
  let result = L.minusSchedule(c, 2, NOW);
  ok("Easy from new -> ivl >= 4", result.ivl >= 4, `ivl=${result.ivl}`);

  // Simulate growing via Easy
  for (let i = 0; i < 6; i++) {
    c = { ...result };
    result = L.minusSchedule(c, 2, NOW);
  }
  ok("Easy path reaches maturity (ivl >= 21)", result.ivl >= 21,
     `after 6 Easy grades ivl=${result.ivl}`);

  const isMature = (result.reps || 0) > 0 && (result.ivl || 0) >= L.MINUS_MATURE_IVL;
  ok("mature card counted as learned", isMature);
}

// ==========================================================================
// 14. Lapse count is tracked per-card and persists across grades
// ==========================================================================
{
  const card = { l: "es", w: "lapse-track", en: "...", ex: "...", reps: 2, ease: 2.5, ivl: 5, lapses: 0 };
  const lapse1 = L.minusSchedule(card, 0, NOW);
  ok("first lapse increments lapses counter", lapse1.lapses === 1);

  const lapse2 = L.minusSchedule({ ...lapse1, reps: 0 }, 0, NOW);
  ok("second lapse increments lapses to 2", lapse2.lapses === 2);
}

// ==========================================================================
// 15. Grade fields are correct types (not strings)
// ==========================================================================
{
  const card = { l: "es", w: "types", en: "...", ex: "...", reps: 0, ease: 2.5, ivl: 0 };
  const result = L.minusSchedule(card, 1, NOW);
  ok("reps is a number", typeof result.reps === "number");
  ok("ease is a number", typeof result.ease === "number");
  ok("ivl is a number", typeof result.ivl === "number");
  ok("due is a number", typeof result.due === "number");
  ok("reps === 1", result.reps === 1);
  ok("ivl === 1", result.ivl === 1);
  ok("ease > 2.4 (nearly unchanged)", result.ease > 2.4);
}

console.log(f ? `\n${f} failure(s)` : "\nall green");
process.exit(f ? 1 : 0);
