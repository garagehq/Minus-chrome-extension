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
  blockAction: "flashcards",         // overlay style: "flashcards" | "minimal"
  blockLang: "es",                   // flashcard deck language (MINUS_DECKS key)
  showConfidence: true,              // show the "ad NN%" tag on overlays
  collectOptIn: false,               // anonymous ad-snapshot contribution (opt-in)
  blockPopups: true,                 // popup guard: judge hijack-click popup tabs (full-page ad landings)
  pausedUntil: 0,                    // epoch ms; blocking is suspended until then (0 = not paused)
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
      tx.objectStore("queue").put({ ...sample, queuedAt: sample.queuedAt ?? Date.now() });
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

// Keyboard shortcut (user-bindable at chrome://extensions/shortcuts) — a quick
// global on/off, the one ad-blocker convenience we were missing. Flipping the
// stored flag makes content.js tear down/restore overlays and the background
// warm/unload the model, all via the existing storage.onChanged handlers.
chrome.commands?.onCommand?.addListener(async (cmd) => {
  if (cmd !== "toggle-blocking") return;
  try {
    const { enabled = true } = await chrome.storage.local.get({ enabled: true });
    await chrome.storage.local.set({ enabled: !enabled });
  } catch {}
});
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
  const prev = frames.get(frameId) || 0;
  if (count > prev) bumpLifetime(count - prev);   // newly-covered ads → lifetime tally
  if (count > 0) frames.set(frameId, count); else frames.delete(frameId);
  let total = 0;
  for (const c of frames.values()) total += c;
  return total;
}

// Lifetime "ads blocked" counter (the "is this working / worth it" signal every
// blocker shows). Batched so we don't write storage on every single cover.
let lifetimePending = 0, lifetimeFlush = null;
function bumpLifetime(n) {
  if (n <= 0) return;
  lifetimePending += n;
  if (lifetimeFlush) return;
  lifetimeFlush = setTimeout(async () => {
    const add = lifetimePending; lifetimePending = 0; lifetimeFlush = null;
    try {
      const { lifetimeBlocked = 0 } = await chrome.storage.local.get({ lifetimeBlocked: 0 });
      await chrome.storage.local.set({ lifetimeBlocked: lifetimeBlocked + add });
    } catch {}
  }, 5000);
}

// Allowlist match: www-insensitive AND subdomain-aware, so disabling "example.com"
// also covers "www.example.com" / "m.example.com" (exact-hostname-only surprised users).
const isPaused = (s) => (s?.pausedUntil || 0) > Date.now();
const normHost = (h) => String(h || "").toLowerCase().replace(/^www\./, "");
function isDisabled(host, disabledSites) {
  const h = normHost(host);
  return (disabledSites || []).some((raw) => {
    const d = normHost(raw);
    return d && (h === d || h.endsWith("." + d));
  });
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

// ---------------------------------------------------------------- popup guard
// Aggressive sites (manga/stream readers etc.) hijack clicks on NON-link page
// areas to spawn popup/popunder tabs whose ENTIRE page is an ad landing.
// Element covering can't touch those — every element there is the ad site's own
// first-party content — so the guard works at the tab level:
//   1. content.js reports clicks that did NOT ride a real <a href> (real
//      target=_blank links never enter this pipeline)
//   2. a tab created by that opener within a short window is a popup SUSPECT
//   3. once the suspect is active + loaded (+ cross-domain from its opener),
//      screenshot the viewport and ask the model about the PAGE itself
//   4. p(ad) >= POPUP_GATE -> the tab's content script shows a full-page cover
//      with an explicit choice: close the tab, or show the page. Never
//      auto-closes — a false positive costs one extra click, not user data.
const POPUP_GATE = 0.85;
const POPUP_CLICK_WINDOW_MS = 3000;
const nonLinkClickAt = new Map(); // opener tabId -> { ts, anchorHost } of last click
const popupSuspects = new Map();  // suspect tabId -> { openerTabId, checked }
const popupTrace = (ev, d) => { const t = (globalThis.__minusPopupTrace ||= []); t.push([ev, d]); if (t.length > 60) t.shift(); };
const regDomain = (h) => { const p = String(h || "").toLowerCase().replace(/^www\d?\./, "").split("."); return p.length <= 2 ? p.join(".") : p.slice(-2).join("."); };

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId == null) { popupTrace("created-no-opener", tab.pendingUrl || tab.url || ""); return; }
  const createdAt = Date.now();
  const tryArm = (late) => {
    if (popupSuspects.has(tab.id)) return;
    const click = nonLinkClickAt.get(tab.openerTabId);
    // |age| — window.open fires INSIDE the page's click handler, so the
    // tab-created event can beat the runtime message carrying the click report
    const armed = !!(click && Math.abs(createdAt - click.ts) <= POPUP_CLICK_WINDOW_MS);
    popupTrace(late ? "created-late" : "created", { opener: tab.openerTabId, armed, ageMs: click ? createdAt - click.ts : -1 });
    if (armed) {
      popupSuspects.set(tab.id, { openerTabId: tab.openerTabId, anchorHost: click.anchorHost || null, checked: false, tries: 0 });
      if (late) checkPopupSuspect(tab.id); // load/activate events may already be gone
    }
  };
  tryArm(false);
  if (!popupSuspects.has(tab.id)) setTimeout(() => tryArm(true), 1200);
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete" && popupSuspects.has(tabId)) checkPopupSuspect(tabId);
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  // popunders load in the background; judge them on first focus (capture needs
  // the tab to be the active one anyway)
  if (popupSuspects.has(tabId)) checkPopupSuspect(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => { popupSuspects.delete(tabId); nonLinkClickAt.delete(tabId); });

async function checkPopupSuspect(tabId) {
  const s = popupSuspects.get(tabId);
  if (!s || s.busy) return;
  const settings = await getSettings();
  if (!settings.enabled || settings.blockPopups === false || isPaused(settings)) { popupSuspects.delete(tabId); return; }
  let tab; try { tab = await chrome.tabs.get(tabId); } catch { popupSuspects.delete(tabId); return; }
  if (tab.status !== "complete" || !tab.active || !/^https?:/.test(tab.url || "")) { popupTrace("check-defer", { st: tab.status, act: tab.active }); return; } // retry on a later event
  try {
    const tabDom = regDomain(new URL(tab.url).hostname);
    // the click's DECLARED destination matches what opened -> a real link nav
    if (s.anchorHost && regDomain(s.anchorHost) === tabDom) { popupTrace("exempt-anchor", tabDom); popupSuspects.delete(tabId); return; }
    const opener = await chrome.tabs.get(s.openerTabId).catch(() => null);
    if (opener?.url && /^https?:/.test(opener.url) && tabDom === regDomain(new URL(opener.url).hostname)) {
      popupTrace("exempt-same-site", tabDom); popupSuspects.delete(tabId); return; // site opening itself (reader re-open trick) — not the ad tab
    }
  } catch { /* opener gone: keep judging the suspect */ }
  s.busy = true;                                  // guard against overlapping re-entry
  await new Promise((r) => setTimeout(r, 1200)); // let the landing paint
  const shot = await captureTab(tab.windowId).catch(() => null);
  if (!shot) { popupTrace("no-shot", tabId); s.busy = false; return; } // capture raced a nav — retry on next event
  try {
    await ensureOffscreen();
    const { engineKind } = settings;
    const resp = await askOffscreen({ type: "classify", images: [shot], engineKind });
    const p = resp?.results?.[0]?.p_ad ?? 0;
    s.tries = (s.tries || 0) + 1;
    (globalThis.__minusPopupVerdicts ||= []).push({ url: (tab.url || "").slice(0, 100), p: +p.toFixed(3) }); // diagnosable
    if (p >= POPUP_GATE) {
      popupSuspects.delete(tabId);
      chrome.tabs.sendMessage(tabId, { type: "minus:popup-verdict", p_ad: p }).catch(() => {});
      bumpLifetime(1);
    } else if (s.tries >= 3) {
      popupSuspects.delete(tabId);               // gave it 3 hops of a redirect chain; it's not an ad landing
    } else {
      s.busy = false;                            // low score, maybe a blank redirect hop -> re-judge on the next 'complete'
    }
  } catch { popupSuspects.delete(tabId); }
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

// Fully unload the vision model by closing the offscreen document. The engine
// holds ~1-2 GB (ORT session + WebGPU buffers); killing the document context is
// the only teardown that guarantees the GPU memory is released.
async function closeOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument?.()) await chrome.offscreen.closeDocument();
  } catch { /* already gone */ }
  offscreenReady = null;
}

// The offscreen engine signals "minus:engine-stuck" when it has been GPU-degraded
// too long to recover in place — a REAL device loss, where the WebGPU device never
// returns inside the SAME offscreen document (soak finding, 2026-08-14). The only
// reliable recovery is to recreate the document: a fresh one gets a NEW GPU
// context. Rate-limited so a genuinely dead GPU can't thrash recreation, and never
// resurrects a document the user has disabled/paused.
let lastEngineReload = 0;
const ENGINE_RELOAD_MIN_INTERVAL_MS = 45000;
async function reloadOffscreenEngine(reason) {
  const now = Date.now();
  if (now - lastEngineReload < ENGINE_RELOAD_MIN_INTERVAL_MS) return false;
  const s = await getSettings().catch(() => ({}));
  if (s.enabled === false || isPaused(s)) return false;
  lastEngineReload = now;
  console.warn(`[minus] engine stuck (${reason}) — recreating offscreen document for a fresh GPU context`);
  await closeOffscreen();
  await ensureOffscreen();
  // warm the fresh context so it's ready before the next scan
  askOffscreen({ type: "engine-status", engineKind: s.engineKind }).catch(() => {});
  return true;
}

// "Block ads (all sites)" OFF -> unload the model entirely; back ON -> warm it
// up again so the first page doesn't eat the whole cold-start.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // Timed pause: schedule the auto-resume alarm and free the model while paused.
  if ("pausedUntil" in changes) {
    const until = changes.pausedUntil.newValue || 0;
    if (until > Date.now()) chrome.alarms.create("minus-resume", { when: until });
    else chrome.alarms.clear("minus-resume");
  }
  if (!("enabled" in changes) && !("pausedUntil" in changes)) return;
  (async () => {
    try {
      const s = await getSettings();
      if (s.enabled === false || isPaused(s)) { closeOffscreen(); return; }
      await ensureOffscreen();
      askOffscreen({ type: "engine-status", engineKind: s.engineKind });
    } catch { /* warm-up is best-effort */ }
  })();
});

// Auto-resume when a timed pause elapses (also survives an SW restart — the
// alarm is persisted; on wake we clear the flag, which re-warms via onChanged).
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "minus-resume") chrome.storage.local.set({ pausedUntil: 0 });
});

function askOffscreen(msg) {
  return new Promise((resolve, reject) => {
    // A WebGPU classify can HANG (not throw) on a wedged device — the offscreen
    // never calls sendResponse, so without a timeout this promise (and the
    // content-side classify it backs) would never settle. Bound it; the caller
    // treats a timeout as an engine error and retries on the next scan.
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; reject(new Error("offscreen timeout")); } }, 30000);
    chrome.runtime.sendMessage({ ...msg, target: "minus-offscreen" }, (resp) => {
      if (done) return;
      done = true; clearTimeout(t);
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
      // captureVisibleTab can HANG (not reject) when the active tab is mid-
      // navigation or a sibling tab just closed — and because captures are
      // serialized through captureInflight, one hang would wedge EVERY future
      // capture (display scans silently stop; only the direct-read video path
      // survives — the "0 display overlays after multi-tab churn" bug). Race a
      // timeout so a stuck capture fails fast and the next one proceeds.
      return await Promise.race([
        chrome.tabs.captureVisibleTab(windowId, { format: "png" }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("capture timeout")), 2500)),
      ]);
    } finally {
      lastCaptureAt = Date.now();
      captureInflight = null;
    }
  })().catch(() => null);
  return captureInflight;
}

// ---------------------------------------------------------------- routing
// Per-engine decision thresholds from the packaged catalog (models/index.json,
// optional `thresholds: {ctx, bare}` on an entry). Cached for the SW lifetime;
// resolution mirrors models_catalog.resolveModel (key -> default -> first).
let catalogCache = null;
async function engineThresholds(engineKind) {
  try {
    if (!catalogCache) {
      catalogCache = await (await fetch(chrome.runtime.getURL("models/index.json"))).json();
    }
    const models = Array.isArray(catalogCache?.models) ? catalogCache.models : [];
    const entry = models.find((m) => m?.key === engineKind)
               || models.find((m) => m?.key === catalogCache?.default)
               || models[0];
    const th = entry?.thresholds;
    return th && (typeof th.ctx === "number" || typeof th.bare === "number") ? th : null;
  } catch {
    return null;
  }
}

// ---- language-learning: record each flashcard word shown on a blocked ad ----
// content.js fires minus:learn-seen from every frame; coalesce by key and flush
// on a short timer so many overlays don't hammer storage. A new word enters as a
// "new" SRS card (reps 0, due now); the Review page paces how many appear/day.
const LEARN_KEY = "minusLearn";
const learnPending = new Map();
let learnFlushTimer = null;
function recordSeen(card) {
  if (!card || !card.l || !card.w) return;
  learnPending.set(card.l + "::" + card.w, card);
  if (!learnFlushTimer) learnFlushTimer = setTimeout(flushLearn, 4000);
}
async function flushLearn() {
  learnFlushTimer = null;
  if (!learnPending.size) return;
  const batch = [...learnPending.values()];
  learnPending.clear();
  try {
    const store = (await chrome.storage.local.get(LEARN_KEY))[LEARN_KEY] || { v: 1, cards: {} };
    if (!store.cards) store.cards = {};
    const now = Date.now();
    for (const c of batch) {
      const k = c.l + "::" + c.w;
      const e = store.cards[k] || { l: c.l, w: c.w, en: c.en || "", ex: c.ex || "", seen: 0, reps: 0, ease: 2.5, ivl: 0, lapses: 0, due: now, first: now };
      e.seen = (e.seen || 0) + 1;
      e.last = now;
      if (c.en) e.en = c.en;
      if (c.ex) e.ex = c.ex;
      store.cards[k] = e;
    }
    await chrome.storage.local.set({ [LEARN_KEY]: store });
  } catch { /* transient storage error: drop this batch, no retry */ }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === "minus-offscreen") return; // not for us
  (async () => {
    try {
      if (msg.type === "minus:engine-stuck") {
        // offscreen engine can't recover a real device loss in place — recreate it
        await reloadOffscreenEngine(`degraded ${Math.round((msg.stuckMs || 0) / 1000)}s`);
        sendResponse({ ok: true });
      } else if (msg.type === "minus:capture") {
        // captureVisibleTab ALWAYS returns the active tab's pixels for the
        // window. A background/inactive tab that captured would crop its own
        // element coordinates against the wrong image — mis-scaled overlays and
        // phantom false-positives (the multi-tab scaling bug). Only the tab that
        // is active in its window may capture.
        const tab = sender.tab;
        if (!tab || tab.active !== true) {
          globalThis.__minusCapRefused = (globalThis.__minusCapRefused || 0) + 1;
          globalThis.__minusLastRefusedActive = tab ? tab.active : "no-tab";
          sendResponse({ ok: false, notActive: true }); return;
        }
        globalThis.__minusCapOk = (globalThis.__minusCapOk || 0) + 1;
        const dataUrl = await captureTab(tab.windowId);
        sendResponse({ ok: true, dataUrl });
      } else if (msg.type === "minus:classify") {
        const { threshold, engineKind, enabled } = await getSettings();
        if (!enabled) { sendResponse({ ok: false, error: "blocking disabled" }); return; }
        // Only classify for the active tab — a background tab must never drive
        // the engine (it would fight the active tab for the model and the
        // capture rate limiter). Sub-frame senders carry the parent tab's active
        // flag, so this also covers iframes.
        if (sender.tab && sender.tab.active !== true) { globalThis.__minusClsRefused = (globalThis.__minusClsRefused || 0) + 1; sendResponse({ ok: false, notActive: true }); return; }
        await ensureOffscreen();
        const resp = await askOffscreen({ type: "classify", images: msg.images, engineKind });
        if (!resp?.ok) throw new Error(resp?.error || "engine error");
        const mapped = resp.results.map((r) => ({ ...r, is_ad: r.p_ad >= threshold }));
        globalThis.__minusClsCalls = (globalThis.__minusClsCalls || 0) + 1;
        globalThis.__minusClsImgs = (globalThis.__minusClsImgs || 0) + mapped.length;
        globalThis.__minusAdsFound = (globalThis.__minusAdsFound || 0) + mapped.filter((r) => r.is_ad).length;
        globalThis.__minusMaxP = Math.max(globalThis.__minusMaxP || 0, ...mapped.map((r) => r.p_ad || 0));
        if (mapped.some((r) => r.is_ad)) {
          const h = sender.tab?.url ? new URL(sender.tab.url).hostname.replace(/^www\./, "") : "?";
          globalThis.__minusAdHosts = globalThis.__minusAdHosts || {};
          globalThis.__minusAdHosts[h] = (globalThis.__minusAdHosts[h] || 0) + mapped.filter((r) => r.is_ad).length;
        }
        sendResponse({ ok: true, results: mapped, engine: resp.engine });
      } else if (msg.type === "minus:settings") {
        const settings = await getSettings();
        const host = sender.tab?.url ? new URL(sender.tab.url).hostname : "";
        sendResponse({
          ok: true,
          settings: {
            ...settings,
            enabled: settings.enabled && !isDisabled(host, settings.disabledSites) && !isPaused(settings),
            // per-engine decision thresholds (models/index.json `thresholds`);
            // null -> content.js keeps its built-in defaults.
            engineThresholds: await engineThresholds(settings.engineKind),
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
      } else if (msg.type === "minus:report-fp") {
        // User pressed "not an ad": a verified false positive — the strongest
        // training signal. Queue it past the retract cool-down (queuedAt 0 =
        // immediately due) and flush. Respects collectOptIn via uploadDueSamples.
        if (msg.sample) { await queueSample({ ...msg.sample, queuedAt: 0 }); uploadDueSamples(); }
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
        const { enabled, engineKind } = await getSettings();
        if (!enabled) {
          // blocking globally off -> model unloaded; don't resurrect the
          // offscreen doc just because the popup polls for status
          sendResponse({ ok: true, info: { state: "off" } });
        } else {
          await ensureOffscreen();
          const resp = await askOffscreen({ type: "engine-status", engineKind });
          sendResponse(resp);
        }
      } else if (msg.type === "minus:nonlink-click") {
        // arm the popup-guard window for this tab (every click; anchorHost is
        // the clicked link's declared destination, null for non-link clicks)
        popupTrace("click", { tab: sender.tab?.id, anchorHost: msg.anchorHost || null });
        if (sender.tab?.id != null) nonLinkClickAt.set(sender.tab.id, { ts: Date.now(), anchorHost: msg.anchorHost || null });
        sendResponse({ ok: true });
      } else if (msg.type === "minus:close-popup") {
        // the popup cover's "Close tab" button
        if (sender.tab?.id != null) chrome.tabs.remove(sender.tab.id).catch(() => {});
        sendResponse({ ok: true });
      } else if (msg.type === "minus:learn-seen") {
        recordSeen(msg.card);       // a flashcard word was shown on a blocked ad
        sendResponse({ ok: true });
      } else if (msg.type === "minus:onboarding-seen") {
        clearFirstRunHint();
        sendResponse({ ok: true });
      } else if (msg.type === "minus:capture-wait") {
        // Pre-arm the capture rate limiter WITHOUT taking a shot: content.js
        // calls this before hiding overlay cards for a clean capture, so the
        // <=600ms rate-limit wait happens while the cards are still visible
        // (shrinks the visible blink to just the capture itself).
        const wait = Math.max(0, lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now());
        if (wait) await new Promise((r) => setTimeout(r, wait));
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
getSettings().then((s) => {
  if (!s.enabled) return; // user has blocking off -> keep the model unloaded
  return ensureOffscreen().then(() => askOffscreen({ type: "engine-status", engineKind: s.engineKind }));
}).catch(() => {});
