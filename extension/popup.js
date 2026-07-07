const DEFAULTS = { serverUrl: "http://127.0.0.1:8484", threshold: 0.5, enabled: true };

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  document.getElementById("enabled").checked = s.enabled;
  document.getElementById("serverUrl").value = s.serverUrl;
  document.getElementById("threshold").value = s.threshold;
  try {
    const r = await fetch(`${s.serverUrl}/health`);
    const h = await r.json();
    document.getElementById("status").textContent = `server: ${h.model} (${h.device})`;
  } catch {
    document.getElementById("status").textContent = "server: unreachable";
  }
}

async function save() {
  await chrome.storage.local.set({
    enabled: document.getElementById("enabled").checked,
    serverUrl: document.getElementById("serverUrl").value.trim() || DEFAULTS.serverUrl,
    threshold: Math.min(1, Math.max(0, parseFloat(document.getElementById("threshold").value) || DEFAULTS.threshold)),
  });
}

for (const id of ["enabled", "serverUrl", "threshold"]) {
  document.getElementById(id).addEventListener("change", save);
}
load();
