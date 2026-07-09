const DEFAULTS = { threshold: 0.5, enabled: true, engineKind: "lfm", disabledSites: [], collectOptIn: false };

let currentHost = "";

function ask(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function activeHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url && tab.url.startsWith("http") ? new URL(tab.url).hostname : "";
  } catch {
    return "";
  }
}

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
  } else if (info.state === "error") {
    el.textContent = `engine error: ${String(info.error).slice(0, 120)}`;
  } else {
    el.textContent = `engine: ${info.state}`;
  }
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
  document.getElementById("threshold").value = s.threshold;
  await loadEngineOptions();
  document.getElementById("engineKind").value = s.engineKind;

  currentHost = await activeHost();
  const site = document.getElementById("siteEnabled");
  const siteLabel = document.getElementById("siteLabel");
  if (currentHost) {
    site.checked = !s.disabledSites.includes(currentHost);
    site.disabled = false;
    siteLabel.textContent = `Block on ${currentHost}`;
  } else {
    site.checked = false;
    site.disabled = true;
    siteLabel.textContent = "Block on this site (n/a)";
  }

  refreshStatus();
  setInterval(refreshStatus, 1500);
}

async function saveGeneral() {
  await chrome.storage.local.set({
    enabled: document.getElementById("enabled").checked,
    collectOptIn: document.getElementById("collect").checked,
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

for (const id of ["enabled", "collect", "threshold", "engineKind"]) {
  document.getElementById(id).addEventListener("change", saveGeneral);
}
document.getElementById("siteEnabled").addEventListener("change", saveSite);
load();
