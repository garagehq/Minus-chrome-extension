// Minus background service worker.
// Jobs: screenshot the visible tab on request (content scripts cannot),
// route classification requests to the in-browser inference engine in the
// offscreen document, own the right-click menu/settings, and run the
// OPT-IN anonymous snapshot queue (default OFF, X-click retracts).

const DEFAULTS = {
  threshold: 0.5,
  enabled: true,
  collectOptIn: false,               // anonymous ad-snapshot contribution
  ingestUrl: "",                     // where opted-in samples are POSTed
  disabledSites: [],                 // per-site kill switch (hostnames)
};

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

// ---------------------------------------------------------------- sample queue
// Opt-in only. Samples sit in IndexedDB for a cool-down window before upload
// so an X-click (user says "not an ad I wanted blocked") retracts them
// before anything leaves the machine.
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000; // uploadCooldownMs in storage overrides (tests)
const DB_NAME = "minus-samples";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("queue", { keyPath: "key" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueSample(sample) {
  const db = await openDb();
  await new Promise((res, rej) => {
    const tx = db.transaction("queue", "readwrite");
    tx.objectStore("queue").put({ ...sample, queuedAt: Date.now() });
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

async function retractSample(key) {
  const db = await openDb();
  await new Promise((res, rej) => {
    const tx = db.transaction("queue", "readwrite");
    tx.objectStore("queue").delete(key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

async function queuedSamples() {
  const db = await openDb();
  return new Promise((res, rej) => {
    const req = db.transaction("queue", "readonly").objectStore("queue").getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function uploadDueSamples() {
  const { collectOptIn, ingestUrl } = await getSettings();
  if (!collectOptIn || !ingestUrl) return;
  const { uploadCooldownMs } = await chrome.storage.local.get({ uploadCooldownMs: DEFAULT_COOLDOWN_MS });
  const due = (await queuedSamples()).filter((s) => Date.now() - s.queuedAt > uploadCooldownMs);
  if (!due.length) return;
  for (const batch of [due.slice(0, 20)]) {
    try {
      const resp = await fetch(ingestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ v: 1, samples: batch }),
      });
      if (resp.ok) for (const s of batch) await retractSample(s.key);
    } catch {
      // network down: keep queued, retry on next alarm
    }
  }
}

chrome.alarms.create("minus-upload", { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "minus-upload") uploadDueSamples();
});
// tests poke this via minus:flush-samples; harmless in production


// ---------------------------------------------------------------- context menu
async function rebuildMenus() {
  const s = await getSettings();
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "toggle-global", title: "Block ads", type: "checkbox",
    checked: s.enabled, contexts: ["action"],
  });
  chrome.contextMenus.create({
    id: "toggle-site", title: "Enabled on this site", type: "checkbox",
    checked: true, contexts: ["action"],
  });
  chrome.contextMenus.create({
    id: "toggle-collect", type: "checkbox", checked: s.collectOptIn, contexts: ["action"],
    title: "Contribute anonymous ad snapshots (opt-in)",
  });
}

chrome.runtime.onInstalled.addListener(rebuildMenus);
chrome.runtime.onStartup?.addListener(rebuildMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const s = await getSettings();
  if (info.menuItemId === "toggle-global") {
    await chrome.storage.local.set({ enabled: info.checked });
  } else if (info.menuItemId === "toggle-collect") {
    await chrome.storage.local.set({ collectOptIn: info.checked });
  } else if (info.menuItemId === "toggle-site" && tab?.url) {
    const host = new URL(tab.url).hostname;
    const sites = new Set(s.disabledSites);
    if (info.checked) sites.delete(host); else sites.add(host);
    await chrome.storage.local.set({ disabledSites: [...sites] });
  }
});

// keep the per-site checkbox in sync with the active tab
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url?.startsWith("http")) return;
    const { disabledSites } = await getSettings();
    chrome.contextMenus.update("toggle-site", {
      checked: !disabledSites.includes(new URL(tab.url).hostname),
    });
  } catch {}
});

// ---------------------------------------------------------------- offscreen
let offscreenReady = null;

async function ensureOffscreen() {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const has = await chrome.offscreen.hasDocument?.();
      if (!has) {
        await chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["BLOBS"],
          justification:
            "Runs the on-device vision model (WebGPU) that classifies page elements as ads.",
        });
      }
    })().catch((e) => {
      offscreenReady = null;
      throw e;
    });
  }
  return offscreenReady;
}

function askOffscreen(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ ...msg, target: "minus-offscreen" }, (resp) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

// ---------------------------------------------------------------- capture
// captureVisibleTab is rate-limited by Chrome (~2/sec). Serialize + coalesce.
let captureInflight = null;
let lastCaptureAt = 0;
const MIN_CAPTURE_INTERVAL_MS = 600;

async function captureTab(windowId) {
  if (captureInflight) return captureInflight;
  const wait = Math.max(0, lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now());
  captureInflight = (async () => {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    } finally {
      lastCaptureAt = Date.now();
      captureInflight = null;
    }
  })();
  return captureInflight;
}

// ---------------------------------------------------------------- routing
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === "minus-offscreen") return; // not for us
  (async () => {
    try {
      if (msg.type === "minus:capture") {
        const dataUrl = await captureTab(sender.tab?.windowId);
        sendResponse({ ok: true, dataUrl });
      } else if (msg.type === "minus:classify") {
        await ensureOffscreen();
        const { threshold } = await getSettings();
        const resp = await askOffscreen({ type: "classify", images: msg.images });
        if (!resp?.ok) throw new Error(resp?.error || "engine error");
        sendResponse({
          ok: true,
          results: resp.results.map((r) => ({ ...r, is_ad: r.p_ad >= threshold })),
          engine: resp.engine,
        });
      } else if (msg.type === "minus:settings") {
        const settings = await getSettings();
        const host = sender.tab?.url ? new URL(sender.tab.url).hostname : "";
        sendResponse({
          ok: true,
          settings: {
            ...settings,
            enabled: settings.enabled && !settings.disabledSites.includes(host),
          },
        });
      } else if (msg.type === "minus:queue-sample") {
        const { collectOptIn } = await getSettings();
        if (collectOptIn) await queueSample(msg.sample);
        sendResponse({ ok: true });
      } else if (msg.type === "minus:retract-sample") {
        await retractSample(msg.key);
        sendResponse({ ok: true });
      } else if (msg.type === "minus:queue-stats") {
        const q = await queuedSamples();
        sendResponse({ ok: true, queued: q.length });
      } else if (msg.type === "minus:flush-samples") {
        await uploadDueSamples();
        sendResponse({ ok: true });
      } else if (msg.type === "minus:engine-status") {
        await ensureOffscreen();
        const resp = await askOffscreen({ type: "engine-status" });
        sendResponse(resp);
      } else {
        sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // async response
});

// Warm the engine as soon as the browser starts the worker.
ensureOffscreen()
  .then(() => askOffscreen({ type: "engine-status" }))
  .catch(() => {});
