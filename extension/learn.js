// Spaced-repetition learning loop for words shown on blocked ads.
//
// Dependency-free (like spanish.js): defines globals used by review.js, popup.js
// and options.js. background.js records exposures into storage under
// MINUS_LEARN_KEY; here we schedule reviews (SM-2-lite), pace new cards, and
// summarise progress. A "card" is one word the user has actually seen:
//   { l, w, en, ex, seen, reps, ease, ivl, lapses, due, first, last }
// reps 0 = never reviewed ("new"); ivl is the current interval in days.

const MINUS_LEARN_KEY = "minusLearn";
const MINUS_LEARN_SEP = "::";                 // storage-key delimiter: <lang>::<word>
const MINUS_NEW_PER_DAY = 12;                 // how many brand-new cards a review day introduces
const MINUS_MATURE_IVL = 21;                  // ivl (days) at/after which a card counts as "learned"
const MINUS_DAY = 86400000;
const MINUS_MIN = 60000;

const minusLearnKey = (l, w) => l + MINUS_LEARN_SEP + w;
const minusTodayStr = (now) => new Date(now).toISOString().slice(0, 10);

// SM-2-lite. grade: 0 = Again, 1 = Good, 2 = Easy. Returns the fields to merge
// into the card. Pure (takes `now`), so it's unit-testable without a clock.
function minusSchedule(card, grade, now) {
  let ease = card.ease || 2.5;
  let ivl = card.ivl || 0;
  let reps = card.reps || 0;
  let lapses = card.lapses || 0;
  if (grade === 0) {                          // forgot: relearn soon, ease down, interval reset
    return { reps: 0, ease: Math.max(1.3, ease - 0.2), ivl: 0, lapses: lapses + 1, due: now + 10 * MINUS_MIN };
  }
  if (reps === 0) ivl = grade === 2 ? 4 : 1;  // graduate a new card
  else if (reps === 1) ivl = grade === 2 ? 6 : 3;
  else ivl = Math.round(ivl * ease * (grade === 2 ? 1.3 : 1));
  if (grade === 2) ease = Math.min(3.0, ease + 0.15);
  ivl = Math.max(1, ivl);
  return { reps: reps + 1, ease, ivl, lapses, due: now + ivl * MINUS_DAY };
}

const minusIsNew = (c) => (c.reps || 0) === 0;
const minusIsLearned = (c) => (c.reps || 0) > 0 && (c.ivl || 0) >= MINUS_MATURE_IVL;
const minusIsDue = (c, now) => (c.reps || 0) > 0 && (c.due || 0) <= now;

// Progress summary across all (optionally language-filtered) cards.
function minusLearnStats(store, now, lang) {
  const all = Object.values((store && store.cards) || {});
  const cards = lang && lang !== "all" ? all.filter((c) => c.l === lang) : all;
  let seen = cards.length, learning = 0, learned = 0, dueNow = 0, news = 0;
  for (const c of cards) {
    if (minusIsNew(c)) news++;
    else if (minusIsLearned(c)) learned++;
    else learning++;
    if (minusIsDue(c, now)) dueNow++;
  }
  return { seen, learning, learned, dueNow, news };
}

// New cards already introduced today (0 if the stored day isn't today).
function minusNewDoneToday(store, now) {
  const nt = store && store.newToday;
  return nt && nt.date === minusTodayStr(now) ? (nt.count || 0) : 0;
}
function minusNewAllowed(store, now) {
  return Math.max(0, MINUS_NEW_PER_DAY - minusNewDoneToday(store, now));
}

// Build a review session: all due reviews first, then up to the day's remaining
// new-card allowance. `lang` "all" or a code. Returns an array of card objects.
function minusBuildQueue(store, now, lang) {
  const all = Object.values((store && store.cards) || {});
  const pool = lang && lang !== "all" ? all.filter((c) => c.l === lang) : all;
  const due = pool.filter((c) => minusIsDue(c, now)).sort((a, b) => (a.due || 0) - (b.due || 0));
  const fresh = pool.filter(minusIsNew).sort((a, b) => (a.first || 0) - (b.first || 0));
  return due.concat(fresh.slice(0, minusNewAllowed(store, now)));
}

// Load / save the whole learning store from chrome.storage.local.
function minusLearnLoad() {
  return chrome.storage.local.get(MINUS_LEARN_KEY).then((r) => {
    const s = r[MINUS_LEARN_KEY] || { v: 1, cards: {} };
    if (!s.cards) s.cards = {};
    return s;
  });
}
function minusLearnSave(store) {
  return chrome.storage.local.set({ [MINUS_LEARN_KEY]: store });
}

// Apply a grade to one card inside the store (records the schedule + bumps the
// per-day new counter when a brand-new card graduates). Mutates + returns store.
function minusGrade(store, card, grade, now) {
  const wasNew = minusIsNew(card);
  const patch = minusSchedule(card, grade, now);
  const key = minusLearnKey(card.l, card.w);
  store.cards[key] = Object.assign({}, card, patch, { last: now });
  if (wasNew) {
    const today = minusTodayStr(now);
    if (!store.newToday || store.newToday.date !== today) store.newToday = { date: today, count: 0 };
    store.newToday.count = (store.newToday.count || 0) + 1;
  }
  return store;
}

// Node/CommonJS export for unit tests (ignored in the browser).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MINUS_LEARN_KEY, MINUS_NEW_PER_DAY, MINUS_MATURE_IVL, MINUS_DAY,
    minusSchedule, minusLearnStats, minusBuildQueue, minusGrade,
    minusIsNew, minusIsLearned, minusIsDue, minusNewAllowed, minusLearnKey,
  };
}
