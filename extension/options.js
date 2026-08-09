// Full-page options (chrome://extensions → Details → Extension options, or the
// popup's ⚙ link). Every control writes straight to chrome.storage.local —
// content.js and background react live via storage.onChanged / minus:settings,
// so there is no Save button. Superset of the popup's quick controls, plus the
// block-action configuration (overlay style, flashcard language, confidence tag).
const DEFAULTS = {
  enabled: true, blockVideo: true, blockDisplay: true, collectOptIn: false,
  engineKind: "lfm", disabledSites: [],
  blockAction: "flashcards", blockLang: "es", showConfidence: true,
};

const $ = (id) => document.getElementById(id);
let saveTick = null;

function savedFlash(msg = "saved") {
  $("saved").textContent = msg;
  clearTimeout(saveTick);
  saveTick = setTimeout(() => { $("saved").textContent = ""; }, 1800);
}

async function set(patch) {
  await chrome.storage.local.set(patch);
  savedFlash();
}

// ---- block-action preview ---------------------------------------------------
async function renderPreview(s) {
  const minimal = s.blockAction === "minimal";
  if (minimal) {
    $("pvW").textContent = "ad blocked";
    $("pvEn").textContent = "";
    $("pvEx").textContent = "This ad has been blocked by minus.";
  } else {
    const deck = await minusLoadDeck(s.blockLang);
    const card = deck[Math.floor(Math.random() * deck.length)];
    $("pvW").textContent = card.w;
    $("pvEn").textContent = card.en;
    $("pvEx").textContent = card.ex;
  }
  $("pvP").style.display = s.showConfidence ? "" : "none";
  $("blockLang").disabled = minimal;
}

async function current() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

// ---- engine list + live status ----------------------------------------------
async function loadEngines(selected) {
  const sel = $("engineKind");
  try {
    const r = await fetch(chrome.runtime.getURL("models/index.json"));
    const models = (await r.json())?.models || [];
    sel.innerHTML = "";
    for (const m of models) {
      if (!m?.key) continue;
      const o = document.createElement("option");
      o.value = m.key;
      o.textContent = m.label || m.key;
      if (m.thresholds) o.textContent += `  [gates ${m.thresholds.ctx}/${m.thresholds.bare}]`;
      sel.appendChild(o);
    }
  } catch { /* leave empty; popup still works */ }
  sel.value = selected;
}

async function refreshEngineStatus() {
  const resp = await new Promise((res) => chrome.runtime.sendMessage({ type: "minus:engine-status" }, res));
  const info = resp?.info;
  const el = $("engineStatus");
  if (!info) { el.textContent = "engine: starting…"; return; }
  if (info.state === "ready") el.textContent = `engine ready: ${info.modelId} on ${info.device}`;
  else if (info.state === "loading") el.textContent = `downloading model… ${Math.round((info.progress || 0) * 100)}%`;
  else if (info.state === "off") el.textContent = "blocking off — model unloaded";
  else if (info.state === "error") el.textContent = `engine error: ${String(info.error).slice(0, 120)}`;
  else el.textContent = `engine: ${info.state}`;
}

// ---- wire-up ------------------------------------------------------------------
async function load() {
  const s = await current();
  $("enabled").checked = s.enabled;
  $("blockDisplay").checked = s.blockDisplay;
  $("blockVideo").checked = s.blockVideo;
  $("collect").checked = s.collectOptIn;
  $("showConfidence").checked = s.showConfidence;
  ($("actMinimal").checked = s.blockAction === "minimal") || ($("actFlash").checked = true);
  $("disabledSites").value = (s.disabledSites || []).join("\n");
  $("ver").textContent = "Minus v" + chrome.runtime.getManifest().version;

  // language dropdown from the shared decks file
  const langSel = $("blockLang");
  langSel.innerHTML = "";
  for (const [code, name] of Object.entries(MINUS_LANGS)) {
    const o = document.createElement("option");
    o.value = code;
    o.textContent = `${name} (${(await minusLoadDeck(code)).length} cards)`;
    langSel.appendChild(o);
  }
  langSel.value = s.blockLang in MINUS_DECKS ? s.blockLang : "es";

  await loadEngines(s.engineKind);
  renderPreview(s);
  refreshEngineStatus();
  setInterval(refreshEngineStatus, 2000);
}

for (const id of ["enabled", "blockDisplay", "blockVideo", "collect", "showConfidence"]) {
  $(id).addEventListener("change", async () => {
    const key = id === "collect" ? "collectOptIn" : id;
    await set({ [key]: $(id).checked });
    renderPreview(await current());
  });
}
for (const id of ["actFlash", "actMinimal"]) {
  $(id).addEventListener("change", async () => {
    await set({ blockAction: $("actMinimal").checked ? "minimal" : "flashcards" });
    renderPreview(await current());
  });
}
$("blockLang").addEventListener("change", async () => {
  await set({ blockLang: $("blockLang").value });
  renderPreview(await current());
});
$("engineKind").addEventListener("change", () => {
  set({ engineKind: $("engineKind").value });
  savedFlash("saved — engine reloads on next classification");
});
$("disabledSites").addEventListener("change", () => {
  const sites = [...new Set($("disabledSites").value.split("\n")
    .map((l) => l.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0])
    .filter(Boolean))];
  $("disabledSites").value = sites.join("\n");
  set({ disabledSites: sites });
});
// clicking the preview deals a new card
$("preview").addEventListener("click", async () => renderPreview(await current()));

// ---- Learning section: progress stats + open review + reset ----
async function refreshLearnStats() {
  try {
    const store = await minusLearnLoad();
    const s = minusLearnStats(store, Date.now(), "all");
    $("lsSeen").textContent = s.seen;
    $("lsLearning").textContent = s.learning;
    $("lsLearned").textContent = s.learned;
    $("lsDue").textContent = minusBuildQueue(store, Date.now(), "all").length;
  } catch { /* storage unavailable */ }
}
$("openReview").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("review.html") }));
$("resetLearn").addEventListener("click", async () => {
  if (!confirm("Reset all flashcard progress? The words you've seen and their review schedule will be cleared.")) return;
  await chrome.storage.local.set({ [MINUS_LEARN_KEY]: { v: 1, cards: {} } });
  await refreshLearnStats();
  savedFlash("learning progress reset");
});
refreshLearnStats();

load();
