// Minus background service worker.
// Jobs: screenshot the visible tab on request (content scripts cannot),
// route classification requests to the in-browser inference engine in the
// offscreen document, own the right-click menu/settings, and run the
// OPT-IN anonymous snapshot queue (default OFF, X-click retracts).

const DEFAULTS = {
  threshold: 0.5,
  enabled: true,
  engineKind: "lfm",
  collectOptIn: false,               // anonymous ad-snapshot contribution (opt-in)
  // Pre-wired ingest endpoint so opting in just works. Collection still requires
  // collectOptIn=true (per-user, off by default), so nothing sends until a user
  // turns it on. The key only gates the endpoint against random bots — it ships
  // to every install by design, not a real secret.
  ingestUrl: "https://minus-ingest-garage.fly.dev/ingest",
  ingestKey: "bdc2d283edff8b961ddf5f235bd1ebeab6c4f98ca9a5e48a",
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
// Resilience caps so a dead/cancelled ingest server never bloats storage or
// hammers a dead endpoint. Collection is best-effort and MUST never surface.
const MAX_QUEUE = 400;                 // hard cap on queued samples
const SAMPLE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // drop samples older than 7 days
const UPLOAD_TIMEOUT_MS = 12 * 1000;   // give up on a hung server fast
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;     // cap backoff at 6h
let uploadFailures = 0;                // consecutive failures -> exponential backoff
let nextUploadAt = 0;                  // don't retry a dead server before this

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("queue", { keyPath: "key" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueSample(sample) {
  try {
    const db = await openDb();
    await new Promise((res, rej) => {
      const tx = db.transaction("queue", "readwrite");
      tx.objectStore("queue").put({ ...sample, queuedAt: Date.now() });
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    await enforceQueueCap();
  } catch {
    /* collection is best-effort; never surface */
  }
}

// Keep the queue bounded: drop expired + oldest-over-cap so a permanently
// dead/cancelled ingest server can never grow storage without limit.
async function enforceQueueCap() {
  try {
    const all = await queuedSamples();
    const now = Date.now();
    const fresh = all.filter((s) => now - (s.queuedAt || 0) < SAMPLE_TTL_MS);
    const expired = all.filter((s) => now - (s.queuedAt || 0) >= SAMPLE_TTL_MS);
    fresh.sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0));
    const overflow = fresh.length > MAX_QUEUE ? fresh.slice(0, fresh.length - MAX_QUEUE) : [];
    for (const s of [...expired, ...overflow]) await retractSample(s.key);
  } catch {
    /* ignore */
  }
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

// Best-effort upload. NOTHING here may throw to a caller or surface to the
// user: if the ingest server is slow, down, or permanently cancelled, the
// extension keeps blocking ads exactly the same and just retries later with
// exponential backoff. Contribution is entirely severable.
async function uploadDueSamples() {
  try {
    const { collectOptIn, ingestUrl, ingestKey } = await getSettings();
    if (!collectOptIn || !ingestUrl) return;
    if (Date.now() < nextUploadAt) return; // in backoff after repeated failures

    await enforceQueueCap(); // prune expired/overflow even when uploads never land
    const { uploadCooldownMs } = await chrome.storage.local.get({ uploadCooldownMs: DEFAULT_COOLDOWN_MS });
    const due = (await queuedSamples()).filter((s) => Date.now() - (s.queuedAt || 0) > uploadCooldownMs);
    if (!due.length) return;

    const batch = due.slice(0, 20);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPLOAD_TIMEOUT_MS);
    let ok = false;
    try {
      const resp = await fetch(ingestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(ingestKey ? { "x-minus-key": ingestKey } : {}) },
        body: JSON.stringify({ v: 1, samples: batch }),
        signal: ctrl.signal,
      });
      ok = resp.ok;
    } finally {
      clearTimeout(timer);
    }

    if (ok) {
      for (const s of batch) await retractSample(s.key);
      uploadFailures = 0;
      nextUploadAt = 0;
    } else {
      throw new Error("non-2xx"); // treat as failure -> backoff
    }
  } catch {
    // server down / hung / cancelled: exponential backoff, never surface.
    uploadFailures++;
    const backoff = Math.min(MAX_BACKOFF_MS, 5 * 60_000 * 2 ** Math.min(uploadFailures, 7));
    nextUploadAt = Date.now() + backoff;
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
        const { threshold, engineKind } = await getSettings();
        const resp = await askOffscreen({ type: "classify", images: msg.images, engineKind });
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
        const { engineKind } = await getSettings();
        const resp = await askOffscreen({ type: "engine-status", engineKind });
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
  .then(async () => askOffscreen({ type: "engine-status", engineKind: (await getSettings()).engineKind }))
  .catch(() => {});
