// Full-page options (chrome://extensions → Details → Extension options, or the
// popup's ⚙ link). Every control writes straight to chrome.storage.local —
// content.js and background react live via storage.onChanged / minus:settings,
// so there is no Save button. Superset of the popup's quick controls, plus the
// block-action configuration (overlay style, flashcard language, confidence tag).
const DEFAULTS = {
  enabled: true, blockVideo: true, blockDisplay: true, collectOptIn: false,
  engineKind: "lfm", disabledSites: [], threshold: 0.5,
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
  else if (info.state === "cold") el.textContent = "engine idle — starts on next scan";
  else el.textContent = `engine: ${info.state}`;
}

// Same both-types-off warning as the popup: the master toggle looks "on" while
// blocking is effectively disabled.
function updateTypesWarn() {
  $("typesWarn").style.display = (!$("blockVideo").checked && !$("blockDisplay").checked) ? "block" : "none";
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
  $("threshold").value = s.threshold;
  $("thVal").textContent = Number(s.threshold).toFixed(2);
  updateTypesWarn();
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
    if (id === "blockVideo" || id === "blockDisplay") updateTypesWarn();
    renderPreview(await current());
  });
}
$("threshold").addEventListener("input", async () => {
  const v = Math.min(1, Math.max(0, parseFloat($("threshold").value) || 0.5));
  $("thVal").textContent = v.toFixed(2);
  await set({ threshold: v });
});
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
// Destructive reset uses an inline armed two-step (click once to arm, again to
// confirm; auto-disarms) instead of a jarring native confirm() dialog.
let resetArmTimer = null;
$("resetLearn").addEventListener("click", async () => {
  const btn = $("resetLearn");
  if (!btn.classList.contains("armed")) {
    btn.classList.add("armed");
    btn.textContent = "Really reset? Click again";
    clearTimeout(resetArmTimer);
    resetArmTimer = setTimeout(() => { btn.classList.remove("armed"); btn.textContent = "Reset progress"; }, 5000);
    return;
  }
  clearTimeout(resetArmTimer);
  btn.classList.remove("armed");
  btn.textContent = "Reset progress";
  const store = await minusLearnLoad();
  minusLearnReset(store);
  await minusLearnSave(store);
  await refreshLearnStats();
  savedFlash("learning progress reset");
});
refreshLearnStats();

load();
