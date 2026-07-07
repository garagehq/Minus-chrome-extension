// Minus background service worker.
// Two jobs: screenshot the visible tab on request (content scripts cannot),
// and route classification requests to the in-browser inference engine that
// lives in the offscreen document (WebGPU is not reliable in service workers).

const DEFAULTS = {
  threshold: 0.5,
  enabled: true,
};

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

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
        sendResponse({ ok: true, settings: await getSettings() });
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
