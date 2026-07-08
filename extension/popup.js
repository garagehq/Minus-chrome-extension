const DEFAULTS = { threshold: 0.5, enabled: true, engineKind: "lfm" };

function ask(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
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

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  document.getElementById("enabled").checked = s.enabled;
  document.getElementById("threshold").value = s.threshold;
  document.getElementById("engineKind").value = s.engineKind;
  refreshStatus();
  setInterval(refreshStatus, 1500);
}

async function save() {
  await chrome.storage.local.set({
    enabled: document.getElementById("enabled").checked,
    threshold: Math.min(1, Math.max(0, parseFloat(document.getElementById("threshold").value) || DEFAULTS.threshold)),
    engineKind: document.getElementById("engineKind").value,
  });
}

for (const id of ["enabled", "threshold", "engineKind"]) {
  document.getElementById(id).addEventListener("change", save);
}
load();
