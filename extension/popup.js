const DEFAULTS = { threshold: 0.5, enabled: true, engineKind: "lfm", disabledSites: [], collectOptIn: false, blockVideo: true, blockDisplay: true, pausedUntil: 0 };

let currentHost = "";
let currentTabId = null;

function ask(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function activeTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

// Live count of ads blocked on the current tab (matches the toolbar badge).
async function refreshCount() {
  if (currentTabId == null) return;
  const r = await ask({ type: "minus:blocked-count", tabId: currentTabId });
  document.getElementById("blockedCount").textContent = String(r?.count ?? 0);
  try {
    const { lifetimeBlocked = 0 } = await chrome.storage.local.get({ lifetimeBlocked: 0 });
    document.getElementById("lifetime").textContent = lifetimeBlocked > 0 ? `${lifetimeBlocked.toLocaleString()} blocked all-time` : "";
  } catch {}
}

// Review entry point: show how many cards are queued (due reviews + today's new
// allowance) and open the full review page in a tab.
async function refreshReview() {
  try {
    const store = await minusLearnLoad();
    const s = minusLearnStats(store, Date.now(), "all");
    const queued = minusBuildQueue(store, Date.now(), "all").length;
    const btn = document.getElementById("reviewBtn");
    btn.innerHTML = queued > 0 ? `📚 Review flashcards <b>(${queued})</b>` : "📚 Review flashcards";
    btn.title = s.seen > 0 ? `${s.seen} words seen · ${s.learned} learned` : "Words you see on blocked ads appear here to review";
  } catch {}
}
document.getElementById("reviewBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("review.html") });
});

async function refreshStatus() {
  const el = document.getElementById("status");
  const bar = document.getElementById("bar");
  const resp = await ask({ type: "minus:engine-status" });
  const info = resp?.info;
  if (!info) {
    el.textContent = "engine: starting…";
    return;
  }
  if (info.state === "ready") {
    el.textContent = `engine: ${info.modelId} on ${info.device}`;
    bar.style.display = "none";
  } else if (info.state === "loading") {
    const pct = Math.round((info.progress || 0) * 100);
    el.textContent = `downloading model… ${pct}%`;
    bar.style.display = "block";
    bar.firstElementChild.style.width = `${pct}%`;
  } else if (info.state === "off") {
    el.textContent = "blocking off — model unloaded";
    bar.style.display = "none";
  } else if (info.state === "error") {
    el.textContent = `engine error: ${String(info.error).slice(0, 120)}`;
  } else if (info.state === "cold") {
    // internal state name; say what it means instead of leaking dev jargon
    el.textContent = "engine idle — starts on next scan";
  } else {
    el.textContent = `engine: ${info.state}`;
  }
}

// Amber warning when the master toggle is on but both ad types are off — the
// controls otherwise look "on" while blocking is effectively disabled.
function updateTypesWarn() {
  const bothOff = !document.getElementById("blockVideo").checked && !document.getElementById("blockDisplay").checked;
  document.getElementById("typesWarn").style.display = bothOff ? "block" : "none";
}

let flashTimer = null;
function flash(msg) {
  const el = document.getElementById("flash");
  el.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.textContent = ""; }, 4000);
}

// Populate the engine dropdown from the generated catalog so newly-packaged
// models appear with no code changes. Leaves the static <option>s (offline
// fallback) in place if the index can't be read.
async function loadEngineOptions() {
  const sel = document.getElementById("engineKind");
  try {
    const r = await fetch(chrome.runtime.getURL("models/index.json"));
    if (!r.ok) return;
    const models = (await r.json())?.models;
    if (!Array.isArray(models) || !models.length) return;
    sel.innerHTML = "";
    for (const m of models) {
      if (!m?.key) continue;
      const o = document.createElement("option");
      o.value = m.key;
      o.textContent = m.label || m.key;
      sel.appendChild(o);
    }
  } catch { /* keep static fallback options */ }
}

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  document.getElementById("enabled").checked = s.enabled;
  document.getElementById("collect").checked = s.collectOptIn;
  document.getElementById("blockVideo").checked = s.blockVideo;
  document.getElementById("blockDisplay").checked = s.blockDisplay;
  document.getElementById("threshold").value = s.threshold;
  document.getElementById("thVal").textContent = Number(s.threshold).toFixed(2);
  updateTypesWarn();
  await loadEngineOptions();
  document.getElementById("engineKind").value = s.engineKind;

  const tab = await activeTab();
  currentTabId = tab?.id ?? null;
  currentHost = tab?.url && tab.url.startsWith("http") ? new URL(tab.url).hostname : "";
  const site = document.getElementById("siteEnabled");
  const siteLabel = document.getElementById("siteLabel");
  if (currentHost) {
    site.checked = !s.disabledSites.includes(currentHost);
    site.disabled = false;
    siteLabel.textContent = `Block on ${currentHost}`;
  } else {
    site.checked = false;
    site.disabled = true;
    siteLabel.textContent = "Block on this site (unavailable here)";
    siteLabel.title = "Only regular web pages (http/https) can be scanned — this page type has no ads to block.";
  }

  document.getElementById("ver").textContent = "v" + chrome.runtime.getManifest().version;

  // Opening the popup counts as "seen onboarding" — clears the first-run
  // NEW badge + tooltip hint if the welcome page didn't already.
  ask({ type: "minus:onboarding-seen" });

  refreshPause();
  refreshReview();
  refreshStatus();
  refreshCount();
  setInterval(() => { refreshStatus(); refreshCount(); refreshPause(); }, 1000);
}

// Timed-pause UI: swap the "Pause 10/30/60m" buttons for a "Paused — resumes in
// X" row + Resume, and reflect it in the master toggle's look.
function refreshPause() {
  chrome.storage.local.get({ pausedUntil: 0 }).then(({ pausedUntil }) => {
    const paused = pausedUntil > Date.now();
    document.getElementById("pauseRow").style.display = paused ? "none" : "flex";
    document.getElementById("pausedRow").style.display = paused ? "flex" : "none";
    if (paused) {
      const left = Math.max(0, pausedUntil - Date.now());
      const m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
      document.getElementById("pausedMsg").textContent = `Paused — ${m}:${String(sec).padStart(2, "0")}`;
    }
  }).catch(() => {});
}
for (const b of document.querySelectorAll(".pausebtn[data-min]")) {
  b.addEventListener("click", async () => {
    const mins = parseInt(b.dataset.min, 10);
    await chrome.storage.local.set({ pausedUntil: Date.now() + mins * 60000 });
    refreshPause();
  });
}
document.getElementById("resumeBtn").addEventListener("click", async () => {
  await chrome.storage.local.set({ pausedUntil: 0 });
  refreshPause();
});

async function saveGeneral() {
  await chrome.storage.local.set({
    enabled: document.getElementById("enabled").checked,
    collectOptIn: document.getElementById("collect").checked,
    blockVideo: document.getElementById("blockVideo").checked,
    blockDisplay: document.getElementById("blockDisplay").checked,
    threshold: Math.min(1, Math.max(0, parseFloat(document.getElementById("threshold").value) || DEFAULTS.threshold)),
    engineKind: document.getElementById("engineKind").value,
  });
}

// Per-site toggle writes the hostname in/out of the disabledSites list.
async function saveSite() {
  if (!currentHost) return;
  const { disabledSites = [] } = await chrome.storage.local.get({ disabledSites: [] });
  const set = new Set(disabledSites);
  if (document.getElementById("siteEnabled").checked) set.delete(currentHost);
  else set.add(currentHost);
  await chrome.storage.local.set({ disabledSites: [...set] });
}

for (const id of ["enabled", "collect", "blockVideo", "blockDisplay", "threshold", "engineKind"]) {
  document.getElementById(id).addEventListener("change", saveGeneral);
}
// threshold is a slider: live value readout while dragging, saved continuously
document.getElementById("threshold").addEventListener("input", () => {
  document.getElementById("thVal").textContent = Number(document.getElementById("threshold").value).toFixed(2);
  saveGeneral();
});
for (const id of ["blockVideo", "blockDisplay"]) {
  document.getElementById(id).addEventListener("change", updateTypesWarn);
}
// switching engines is a heavyweight, deferred action — say so explicitly
document.getElementById("engineKind").addEventListener("change", () => {
  flash("✓ saved — new engine loads on the next scan");
});
document.getElementById("siteEnabled").addEventListener("change", saveSite);
document.getElementById("optionsLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
load();
