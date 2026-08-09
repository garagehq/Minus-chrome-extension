// Review page controller. Loads the learning store, builds a spaced-repetition
// session (due reviews + the day's new-card allowance), and persists each grade.
// Pure scheduling/stat logic lives in learn.js; MINUS_LANGS labels in spanish.js.

const $ = (id) => document.getElementById(id);
let store = null;
let queue = [];
let idx = 0;
let revealed = false;
let lang = "all";

function langLabel(code) {
  return (typeof MINUS_LANGS !== "undefined" && MINUS_LANGS[code]) || code;
}

function renderStats() {
  const s = minusLearnStats(store, Date.now(), lang);
  $("sSeen").textContent = s.seen;
  $("sLearning").textContent = s.learning;
  $("sLearned").textContent = s.learned;
  $("sDue").textContent = queue.length; // cards actually queued this session
}

// Fill the language filter with "All" + only the languages the user has seen.
function buildLangFilter() {
  const codes = [...new Set(Object.values(store.cards).map((c) => c.l))].sort();
  const sel = $("lang");
  sel.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "all"; optAll.textContent = "All languages";
  sel.appendChild(optAll);
  for (const c of codes) {
    const o = document.createElement("option");
    o.value = c; o.textContent = langLabel(c);
    sel.appendChild(o);
  }
  sel.value = lang;
}

function startSession() {
  queue = minusBuildQueue(store, Date.now(), lang);
  idx = 0;
  renderStats();
  showCurrent();
}

function showCurrent() {
  revealed = false;
  if (idx >= queue.length) return finishSession();
  $("session").classList.remove("hidden");
  $("done").classList.add("hidden");
  const c = queue[idx];
  $("cLang").textContent = langLabel(c.l) + (minusIsNew(c) ? " · new" : "");
  $("cWord").textContent = c.w;
  $("cEn").textContent = c.en || "";
  $("cEx").textContent = c.ex || "";
  $("cEn").classList.add("hidden");
  $("cEx").classList.add("hidden");
  $("showRow").classList.remove("hidden");
  $("gradeRow").classList.add("hidden");
  $("progress").textContent = `${idx + 1} / ${queue.length}`;
}

function reveal() {
  if (revealed || idx >= queue.length) return;
  revealed = true;
  $("cEn").classList.remove("hidden");
  $("cEx").classList.remove("hidden");
  $("showRow").classList.add("hidden");
  $("gradeRow").classList.remove("hidden");
}

async function grade(g) {
  if (!revealed || idx >= queue.length) return;
  const c = queue[idx];
  minusGrade(store, c, g, Date.now());
  await minusLearnSave(store);
  // "Again" re-queues the card near the end of this session so it comes back.
  if (g === 0) queue.push(store.cards[minusLearnKey(c.l, c.w)]);
  idx++;
  renderStats();
  showCurrent();
}

function finishSession() {
  $("session").classList.add("hidden");
  $("done").classList.remove("hidden");
  $("progress").textContent = "";
  const s = minusLearnStats(store, Date.now(), lang);
  if (s.seen === 0) {
    $("doneBig").textContent = "No words yet";
    $("doneMsg").textContent = "Browse with Minus on — every ad it blocks adds a flashcard here to review.";
  } else {
    $("doneBig").textContent = "All caught up ✓";
    $("doneMsg").textContent = `${s.learned} learned · ${s.learning} in progress · ${s.news} still new. Come back later for more reviews.`;
  }
}

document.addEventListener("keydown", (e) => {
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if ((e.key === " " || e.key === "Enter") && !revealed) { e.preventDefault(); reveal(); }
  else if (revealed && (e.key === "1" || e.key === "2" || e.key === "3")) { e.preventDefault(); grade(+e.key - 1); }
});
$("showBtn").addEventListener("click", reveal);
for (const b of document.querySelectorAll("#gradeRow button")) b.addEventListener("click", () => grade(+b.dataset.g));
$("lang").addEventListener("change", () => { lang = $("lang").value; startSession(); });
$("optionsLink").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

(async function init() {
  store = await minusLearnLoad();
  buildLangFilter();
  startSession();
})();
