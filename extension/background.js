// Minus background service worker.
// Jobs: screenshot the visible tab on request (content scripts cannot),
// route classification requests to the in-browser inference engine in the
// offscreen document, own the right-click menu/settings, and run the
// OPT-IN anonymous snapshot queue (default OFF, X-click retracts).

const DEFAULTS = {
  threshold: 0.5,
  enabled: true,
  engineKind: "lfm",
  blockVideo: true,                  // cover video ads (in-player / iframe)
  blockDisplay: true,                // cover static display ads (img / iframe / ad-slot)
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
const UPLOAD_TIMEOUT_MS = 25 * 1000;   // allow a scale-to-zero server cold-start + HF push
const BACKOFF_BASE_MS = 20 * 1000;     // gentle first retry (cold start != dead server)
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

    const batch = due.slice(0, 6); // small batches: keep each POST light so it never times out
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
    // Gentle ramp so a cold-start blip (scale-to-zero server waking) costs ~20s,
    // not 10min; still backs off hard for a genuinely dead server.
    const backoff = Math.min(MAX_BACKOFF_MS, BACKOFF_BASE_MS * 2 ** Math.min(uploadFailures - 1, 9));
    nextUploadAt = Date.now() + backoff;
  }
}

chrome.alarms.create("minus-upload", { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "minus-upload") uploadDueSamples();
});
// tests poke this via minus:flush-samples; harmless in production


// ---------------------------------------------------------------- action style
// All controls live in the left-click popup (popup.html) — enable/disable,
// per-site toggle, engine, threshold, and the anonymous-snapshot opt-in. There
// is no native right-click menu (it can't be styled and duplicated the popup).
function initActionStyle() {
  chrome.action.setBadgeBackgroundColor({ color: "#3b82f6" });
  chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
}

// ------------------------------------------------------------- first-run hint
// Chrome doesn't let an extension pin itself to the toolbar (no API — only
// managed policy can). So on first install we (a) open a one-time welcome page
// that teaches the basics and how to pin, and (b) draw the eye to the (likely
// unpinned, tucked-in-the-🧩-menu) icon with a "NEW" badge + a helpful tooltip.
// The hint clears the first time the user opens the popup or the welcome page.
const REST_TITLE = "Minus — vision ad blocker (click for controls)";
const HINT_TITLE = "👋 Minus is installed — click the 🧩 puzzle menu to pin me, then click me to start";

function showFirstRunHint() {
  chrome.action.setBadgeText({ text: "NEW" });
  chrome.action.setTitle({ title: HINT_TITLE });
}
function clearFirstRunHint() {
  chrome.storage.local.get({ onboardingSeen: false }, ({ onboardingSeen }) => {
    if (onboardingSeen) return;
    chrome.storage.local.set({ onboardingSeen: true });
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: REST_TITLE });
  });
}

function onInstalled(details) {
  initActionStyle();
  if (details?.reason === "install") {
    chrome.storage.local.set({ onboardingSeen: false });
    chrome.action.setTitle({ title: REST_TITLE });
    showFirstRunHint();
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(onInstalled);
chrome.runtime.onStartup?.addListener(initActionStyle);
initActionStyle();

// ---------------------------------------------------------------- badge / icon
// Toolbar icon is BLUE at rest and turns RED while ads are blocked on the tab,
// with a per-tab counter badge (like a conventional ad blocker). The content
// script reports its live blocked count; we paint the matching tab's action.
const ICON_BLUE = { 16: "icons/m-blue-16.png", 32: "icons/m-blue-32.png", 48: "icons/m-blue-48.png", 128: "icons/m-blue-128.png" };
const ICON_RED = { 16: "icons/m-red-16.png", 32: "icons/m-red-32.png", 48: "icons/m-red-48.png", 128: "icons/m-red-128.png" };
// tabId -> Map(frameId -> count). The content script runs in every frame
// (all_frames), so the badge is the SUM of each frame's live blocked count.
const blockedByTab = new Map();

function setFrameCount(tabId, frameId, count) {
  let frames = blockedByTab.get(tabId);
  if (!frames) { frames = new Map(); blockedByTab.set(tabId, frames); }
  if (count > 0) frames.set(frameId, count); else frames.delete(frameId);
  let total = 0;
  for (const c of frames.values()) total += c;
  return total;
}

async function paintAction(tabId, count) {
  try {
    await chrome.action.setIcon({ tabId, path: count > 0 ? ICON_RED : ICON_BLUE });
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" });
  } catch { /* tab gone / not paintable (e.g. chrome:// pages) */ }
}

// Reset the counter when the tab's main frame navigates (clears all sub-frames).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    blockedByTab.delete(tabId);
    paintAction(tabId, 0);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => blockedByTab.delete(tabId));

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
      } else if (msg.type === "minus:blocked") {
        const tabId = sender.tab?.id;
        if (tabId != null) {
          const total = setFrameCount(tabId, sender.frameId ?? 0, Math.max(0, msg.count | 0));
          paintAction(tabId, total);
        }
        sendResponse({ ok: true });
      } else if (msg.type === "minus:blocked-count") {
        const frames = blockedByTab.get(msg.tabId);
        let count = 0;
        if (frames) for (const c of frames.values()) count += c;
        sendResponse({ ok: true, count });
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
      } else if (msg.type === "minus:onboarding-seen") {
        clearFirstRunHint();
        sendResponse({ ok: true });
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
