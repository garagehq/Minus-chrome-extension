// Unit tests for the spaced-repetition learning loop (learn.js), the Greek deck,
// and the exposure/UX wiring. Pure — no browser, no GPU.
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "extension");
const read = (p) => readFileSync(join(EXT, p), "utf8");
// learn.js is a classic browser script (globals + a CJS export tail). The repo
// is type:module, so load it in a VM sandbox and grab its module.exports.
const sandbox = { module: { exports: {} } };
vm.runInNewContext(read("learn.js"), sandbox);
const L = sandbox.module.exports;

let f = 0, p = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  — ${d}`}`); c ? p++ : f++; };
const NOW = 1_700_000_000_000;
const DAY = L.MINUS_DAY;

// ---------------- SM-2-lite scheduler ----------------
{
  const nw = { reps: 0, ease: 2.5, ivl: 0 };
  const good = L.minusSchedule(nw, 1, NOW);
  ok("new + Good graduates to 1-day interval", good.reps === 1 && good.ivl === 1 && good.due === NOW + DAY, JSON.stringify(good));
  const easy = L.minusSchedule(nw, 2, NOW);
  ok("new + Easy jumps to 4-day interval + raises ease", easy.ivl === 4 && easy.ease > 2.5, JSON.stringify(easy));

  const r1 = { reps: 1, ease: 2.5, ivl: 1 };
  ok("reps1 + Good -> 3 days", L.minusSchedule(r1, 1, NOW).ivl === 3);
  ok("reps1 + Easy -> 6 days", L.minusSchedule(r1, 2, NOW).ivl === 6);

  const mature = { reps: 4, ease: 2.5, ivl: 10 };
  const mg = L.minusSchedule(mature, 1, NOW);
  ok("mature + Good multiplies interval by ease", mg.ivl === Math.round(10 * 2.5), JSON.stringify(mg));
  ok("mature intervals grow (spacing increases)", mg.ivl > mature.ivl);

  const again = L.minusSchedule({ reps: 4, ease: 2.5, ivl: 20, lapses: 0 }, 0, NOW);
  ok("Again resets reps to 0 + short relearn step", again.reps === 0 && again.ivl === 0 && again.due < NOW + DAY);
  ok("Again lowers ease and counts a lapse", again.ease < 2.5 && again.lapses === 1);
  ok("ease never drops below 1.3", L.minusSchedule({ reps: 2, ease: 1.3, ivl: 5 }, 0, NOW).ease >= 1.3);
  ok("ease is capped at 3.0", L.minusSchedule({ reps: 2, ease: 3.0, ivl: 5 }, 2, NOW).ease <= 3.0);
}

// ---------------- stats + queue pacing ----------------
{
  const store = { v: 1, cards: {
    "es::a": { l: "es", w: "a", reps: 0, ivl: 0, due: NOW },                 // new
    "es::b": { l: "es", w: "b", reps: 2, ivl: 5, due: NOW - DAY },           // learning, due
    "es::c": { l: "es", w: "c", reps: 6, ivl: 30, due: NOW + DAY },          // learned, not due
    "el::d": { l: "el", w: "d", reps: 1, ivl: 3, due: NOW - 100 },           // learning, due (Greek)
  } };
  const s = L.minusLearnStats(store, NOW, "all");
  ok("stats: seen counts every card", s.seen === 4, JSON.stringify(s));
  ok("stats: learned = mature interval only", s.learned === 1);
  ok("stats: dueNow counts only started+due", s.dueNow === 2);
  ok("stats: news counts unreviewed", s.news === 1);
  const sEl = L.minusLearnStats(store, NOW, "el");
  ok("stats: language filter narrows the set", sEl.seen === 1 && sEl.dueNow === 1);

  const q = L.minusBuildQueue(store, NOW, "all");
  ok("queue puts due reviews before new cards", q[0].reps > 0 && q[q.length - 1].reps === 0);
  ok("queue includes the new card (allowance not spent)", q.some((c) => c.w === "a"));
}
{
  // new-card daily pacing: once the allowance is spent, no new cards queue
  const today = new Date(NOW).toISOString().slice(0, 10);
  const cards = {};
  for (let i = 0; i < 50; i++) cards[`es::n${i}`] = { l: "es", w: `n${i}`, reps: 0, ivl: 0, due: NOW, first: NOW + i };
  const store = { v: 1, cards, newToday: { date: today, count: L.MINUS_NEW_PER_DAY } };
  ok("new allowance exhausted -> queue empty", L.minusBuildQueue(store, NOW, "all").length === 0);
  ok("fresh day -> allowance restored", L.minusNewAllowed({ v: 1, cards, newToday: { date: "2000-01-01", count: 99 } }, NOW) === L.MINUS_NEW_PER_DAY);
}

// ---------------- minusGrade mutates store + paces new cards ----------------
{
  const store = { v: 1, cards: { "es::x": { l: "es", w: "x", en: "the x", ex: "…", reps: 0, ivl: 0, due: NOW } } };
  L.minusGrade(store, store.cards["es::x"], 1, NOW);
  ok("grade updates the card in place (reps advanced)", store.cards["es::x"].reps === 1);
  ok("grading a NEW card bumps today's new counter", store.newToday && store.newToday.count === 1);
}

// ---------------- minusLearnReset wipes cards, preserves skeleton ----------
{
  const store = { v: 2, cards: { "es::a": { l: "es", w: "a", reps: 3, ivl: 10 }, "fr::b": { l: "fr", w: "b", reps: 1, ivl: 2 } } };
  const before = JSON.parse(JSON.stringify(store));
  L.minusLearnReset(store);
  ok("reset clears all cards", Object.keys(store.cards).length === 0);
  ok("reset resets newToday counter to 0", store.newToday && store.newToday.count === 0);
  ok("reset preserves store version", store.v === before.v);
  ok("reset returns the store for chaining", store === L.minusLearnReset(store));
  ok("fresh queue after reset is empty", L.minusBuildQueue(store, NOW, "all").length === 0);
  const s = L.minusLearnStats(store, NOW, "all");
  ok("stats after reset: all zeroes", s.seen === 0 && s.learning === 0 && s.learned === 0 && s.dueNow === 0 && s.news === 0);
}

// ---------------- Greek deck ----------------
{
  const el = JSON.parse(read("decks/el.json"));
  ok("Greek deck is a solid size", el.length >= 200, `only ${el.length}`);
  ok("Greek deck words are unique", new Set(el.map((c) => c.w)).size === el.length);
  ok("Greek deck entries all have w/en/ex", el.every((c) => c.w && c.en && c.ex));
  ok("Greek deck is actually Greek script", el.filter((c) => /[Ͱ-Ͽ]/.test(c.w)).length > el.length * 0.9);
  const sp = read("spanish.js");
  ok("Greek registered in MINUS_LANGS", /el:\s*"Greek"/.test(sp));
  ok("Greek starter deck present in MINUS_DECKS", /\bel:\s*\[/.test(sp));
}

// ---------------- wiring ----------------
{
  const content = read("content.js");
  ok("content records exposures on flashcard render", /minus:learn-seen/.test(content) && /l:\s*blockLang/.test(content));
  const bg = read("background.js");
  ok("background handles + coalesces exposures", /minus:learn-seen/.test(bg) && /function recordSeen/.test(bg) && /minusLearn/.test(bg));
  const popup = read("popup.js");
  ok("popup surfaces a review entry point", /reviewBtn/.test(popup) && /review\.html/.test(popup));
  const opt = read("options.js");
  ok("options has learning stats + reset", /refreshLearnStats/.test(opt) && /resetLearn/.test(opt));
  read("review.html"); read("review.js"); read("learn.js"); // exist or throw
  ok("review page + learn module ship", true);
}

console.log(f ? `\n${f} failure(s)` : "\nall green");
process.exit(f ? 1 : 0);
