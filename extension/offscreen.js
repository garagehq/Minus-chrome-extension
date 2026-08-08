// Minus inference engine — runs INSIDE the browser in an MV3 offscreen
// document (window context: WebGPU + canvas available, survives while the
// service worker sleeps).
//
// Engine: LFM2.5-VL (our Iter 14 fine-tune when packaged under models/,
// otherwise the stock ONNX from the HF hub) via transformers.js, WebGPU with
// WASM fallback. Verdict = logit decode: softmax over Yes/No token logits at
// the first generated position — the same decoder the training campaign used.

import { AutoModelForImageTextToText, AutoProcessor, RawImage, env, ort } from "./dist/engine-lib.js";
import { FALLBACK_CATALOG, parseCatalog, resolveModel, modelEnvFlags } from "./models_catalog.js";

env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("dist/");
ort.env.wasm.wasmPaths = chrome.runtime.getURL("dist/");

// Quiet the engine's startup noise. Models are packaged (chrome-extension://),
// so the browser Cache API can't cache them anyway — disabling it removes the
// "Failed to execute 'put' on 'Cache'" throw. logLevel trims ORT's chatter.
env.useBrowserCache = false;
ort.env.logLevel = "error";

// transformers.js/ORT default `powerPreference` to "high-performance" so
// requestAdapter() picks the discrete GPU on multi-GPU machines. On Windows,
// Chromium *ignores* powerPreference and logs a warning on every load
// (crbug.com/369219127). That warning is emitted by the browser INSIDE
// requestAdapter() — it's not a console.* call, so the mute list below can't
// touch it; the only way to silence it is to not pass the option. ORT-web's
// WebGPU EP requests the adapter itself (see `Ic` in the WASM glue:
// `requestAdapter({powerPreference: "high-performance"})`), so setting ort.env
// isn't enough — the EP re-applies its default. Strip it at the one choke point
// every caller (ours + ORT + transformers.js) funnels through. Windows-only and
// behaviorally a no-op there (the option is ignored anyway); macOS/Linux keep
// the discrete-GPU hint untouched.
if (/Windows/i.test(navigator.userAgent) && ort.env?.webgpu) {
  ort.env.webgpu.powerPreference = undefined;
}
if (/Windows/i.test(navigator.userAgent) && navigator.gpu?.requestAdapter) {
  const realRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = (opts) => {
    if (opts && "powerPreference" in opts) { const { powerPreference, ...rest } = opts; opts = rest; }
    return realRequestAdapter(opts);
  };
}

// A few loader warnings are emitted via console.* by ORT / transformers.js and
// are benign for a packaged, local-only model. Filter exactly those strings so
// the extension console stays clean without hiding real errors.
const MUTE = [
  "Unable to determine content-length",
  "Unable to add response to browser cache",
  "Some nodes were not assigned to the preferred execution providers",
  "CleanUnusedInitializersAndNodeArgs",
  "Failed to get GPU adapter",       // flaky/absent WebGPU — we catch this and fall back to WASM
  "WebGPU is not supported",
  "no available backend",
  "wasm streaming compile failed",   // benign: ORT then instantiates from ArrayBuffer instead
];
const muteText = (a) => (typeof a === "string" ? a : String(a?.message || ""));
for (const level of ["log", "info", "warn", "error"]) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    if (args.some((a) => MUTE.some((m) => muteText(a).includes(m)))) return; // match string OR Error.message, any arg
    orig(...args);
  };
}

// WebGPU can be *present but non-functional* (flaky adapter / driver). We try
// it, catch the failure, and fall back to WASM — but ORT can surface the
// adapter error as an uncaught rejection with a scary stack. Swallow those
// known-benign engine errors so they don't alarm users; the WASM fallback keeps
// the extension fully working.
const benignEngineError = (r) =>
  /Failed to get GPU adapter|WebGPU is not supported|no available backend|requestAdapter|requestDevice/i.test(String(r?.message || r || ""));
self.addEventListener("unhandledrejection", (e) => { if (benignEngineError(e.reason)) e.preventDefault(); });
self.addEventListener("error", (e) => { if (benignEngineError(e.error || e.message)) e.preventDefault(); });

const PROMPT = "Is this an advertisement? Answer Yes or No.";
const HUB_MODEL = "onnx-community/LFM2.5-VL-450M-ONNX";

// The engine catalog (key -> dir/kind/label) is loaded from the generated
// models/index.json, which build_model_index.mjs regenerates from the packaged
// model dirs. Adding a model dir therefore makes it selectable here and in the
// popup with no code changes. Falls back to the built-in catalog if the index
// is missing.
let catalogPromise = null;
function getCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch(chrome.runtime.getURL("models/index.json"))
      .then((r) => (r.ok ? r.json() : null))
      .then((raw) => parseCatalog(raw || FALLBACK_CATALOG))
      .catch(() => parseCatalog(FALLBACK_CATALOG));
  }
  return catalogPromise;
}

let enginePromise = null;
let engineInfo = { state: "cold" };

async function localModelAvailable(dir) {
  try {
    const r = await fetch(chrome.runtime.getURL(`models/${dir}/config.json`));
    return r.ok;
  } catch {
    return false;
  }
}

// Decide whether WebGPU is *actually usable* before we ask ORT to build a
// WebGPU session. Requesting an adapter isn't enough — WebGPU can be present
// but non-functional, so we also request a full GPUDevice (which is what ORT
// needs). If we can't get a device, we go straight to WASM and never trigger
// ORT's "Failed to get GPU adapter" throw. Retries cover a GPU service that's
// still spinning up (seen on NVIDIA Tegra).
async function warmUpWebGpu(tries = 5, delayMs = 1200) {
  if (!navigator.gpu) return false;
  for (let i = 0; i < tries; i++) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      const device = adapter && await adapter.requestDevice();
      if (device) { device.destroy?.(); return true; }
    } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}


// Reject if `promise` doesn't settle within `ms`. Used to bound WebGPU model
// load + warm-up, which can HANG (not throw) on flaky GPU drivers — without a
// bound the engine sticks in "loading" forever and never falls back to WASM.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

async function loadEngine(entry) {
  const localDir = entry.dir;
  const useLocal = await localModelAvailable(localDir);
  // `env` is a shared singleton across engine loads. modelEnvFlags() returns
  // BOTH flags on every load so switching engines can't inherit a prior local
  // load's allowRemoteModels=false and then fail "file was not found locally"
  // when the newly-selected model isn't packaged.
  const flags = modelEnvFlags(useLocal);
  env.allowLocalModels = flags.allowLocalModels;        // browser builds default this to false
  env.localModelPath = chrome.runtime.getURL("models/");
  env.allowRemoteModels = flags.allowRemoteModels;
  const modelId = useLocal ? localDir : HUB_MODEL;

  // Validated combo (parity vs PyTorch: ad 0.999 / non-ad 0.031): 431MB total.
  const dtype = { vision_encoder: "q8", embed_tokens: "q8", decoder_model_merged: "q4" };
  let device = (await warmUpWebGpu()) ? "webgpu" : "wasm";
  engineInfo = { state: "loading", modelId, device };

  // aggregate download/load progress for the popup (file -> fraction)
  const progressByFile = {};
  const progress_callback = (p) => {
    if (p.status === "progress" && p.total) {
      progressByFile[p.file] = { loaded: p.loaded, total: p.total };
      let loaded = 0, total = 0;
      for (const f of Object.values(progressByFile)) { loaded += f.loaded; total += f.total; }
      engineInfo = { ...engineInfo, state: "loading", progress: total ? loaded / total : 0 };
    }
  };

  const processor = await AutoProcessor.from_pretrained(modelId, { progress_callback });
  const buildModel = (dev) => withTimeout(
    AutoModelForImageTextToText.from_pretrained(modelId, { device: dev, dtype, progress_callback }),
    dev === "webgpu" ? 150000 : 300000, `${dev} model load`);

  let model;
  try {
    model = await buildModel(device);
  } catch (e) {
    if (device === "wasm") throw e;
    console.info(`[minus] ${device} model load failed; using WASM.`); // no error obj -> no scary stack
    device = "wasm";
    engineInfo = { ...engineInfo, device, state: "loading" };
    model = await buildModel("wasm");
  }

  const tok = processor.tokenizer;
  const ids = (variants) =>
    variants.map((v) => tok.encode(v, { add_special_tokens: false })[0]).filter((x) => x !== undefined);
  const yesIds = ids(["Yes", "yes", " Yes", " yes"]);
  const noIds = ids(["No", "no", " No", " no"]);

  const engine = { model, processor, yesIds, noIds };

  // Warm-up on a dummy image (shader compilation / first-run JIT lands here, not
  // on the first real scan) — AND doubles as a health check: if the GPU
  // inference path hangs/errors, rebuild on WASM instead of shipping a dead
  // engine that would hang every real classify call. Bounded so it can never
  // wedge the "ready" transition.
  async function warmUp(eng) {
    const canvas = new OffscreenCanvas(64, 64);
    canvas.getContext("2d").fillRect(0, 0, 64, 64);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
    await classifyOne(eng, url);
  }
  try {
    await withTimeout(warmUp(engine), 60000, `${device} warm-up`);
  } catch (e) {
    if (device !== "wasm") {
      console.info(`[minus] ${device} inference failed; rebuilding on WASM.`); // no error obj
      device = "wasm";
      engineInfo = { ...engineInfo, device, state: "loading" };
      engine.model = await buildModel("wasm");
      try { await withTimeout(warmUp(engine), 60000, "wasm warm-up"); } catch (e2) { console.warn("[minus] WASM warm-up failed (continuing):", e2); }
    } else {
      console.warn("[minus] WASM warm-up failed (continuing):", e);
    }
  }

  engineInfo = { state: "ready", modelId, device };
  return engine;
}

// ---------------------------------------------------------------- SigLIP2
// Alternate engine: our SigLIP2-SO400M-384 fine-tune as one self-contained
// ONNX graph (pixel_values [b,3,384,384] pre-normalized -> p_ad [b]).
// WebGPU-only (fp16 weights); preprocess = squash-resize to 384, (x/255-.5)/.5.
const SIGLIP2_SIZE = 384;

async function exists(url) {
  return fetch(url, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
}

// Backend chain for the SigLIP2 ONNX graph, in preference order. fp16 weights
// run only on WebGPU; WebGL/WASM need the fp32 model (bigger — ship it only if
// you intend to support non-WebGPU machines). WebGL EP op coverage is partial,
// so it may fail to init on this graph — we try it and fall through.
// SigLIP2-family engines (single ONNX graph, squash-384 preprocess):
//   "siglip2" -> SO400M-384 web fine-tune (817MB, accurate)
//   "lite"    -> ViT-B-16-384 (178MB fp16, for low-end / no-WebGPU machines)
async function loadSiglip2Engine(entry) {
  const dir = entry.dir;
  const label = entry.label || dir;
  const base = chrome.runtime.getURL(`models/${dir}/`);
  const fp16 = `${base}model_fp16.onnx`;
  const fp32 = `${base}model.onnx`;
  const haveFp16 = await exists(fp16);
  const haveFp32 = await exists(fp32);

  // WebGL EP is only present when built against onnxruntime-web/all.
  const hasWebgl = !!(ort.env?.webgl) || (ort.backends && "webgl" in ort.backends);
  const plan = [];
  if (haveFp16) plan.push({ ep: "webgpu", url: fp16, needWarmup: true });
  if (haveFp32) plan.push({ ep: "webgpu", url: fp32, needWarmup: true });
  if (haveFp32 && hasWebgl) plan.push({ ep: "webgl", url: fp32 });
  if (haveFp32) plan.push({ ep: "wasm", url: fp32 });
  if (!plan.length) throw new Error("no SigLIP2 model packaged");

  let lastErr;
  for (const step of plan) {
    try {
      if (step.needWarmup && !(await warmUpWebGpu())) continue; // no adapter, skip GPU steps
      engineInfo = { state: "loading", modelId: label, device: step.ep };
      const session = await ort.InferenceSession.create(step.url, {
        executionProviders: [step.ep],
      });
      engineInfo = { state: "ready", modelId: label, device: step.ep };
      return { kind: "siglip2", session };
    } catch (e) {
      console.warn(`[minus] SigLIP2 on ${step.ep} failed, trying next:`, e);
      lastErr = e;
    }
  }
  throw lastErr || new Error("SigLIP2: no working backend");
}

async function siglip2Classify(engine, dataUrl) {
  const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(SIGLIP2_SIZE, SIGLIP2_SIZE);
  const ctx2d = canvas.getContext("2d");
  ctx2d.imageSmoothingQuality = "high";
  ctx2d.drawImage(img, 0, 0, SIGLIP2_SIZE, SIGLIP2_SIZE); // squash resize
  const { data } = ctx2d.getImageData(0, 0, SIGLIP2_SIZE, SIGLIP2_SIZE);
  const n = SIGLIP2_SIZE * SIGLIP2_SIZE;
  const px = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    px[i] = (data[i * 4] / 255 - 0.5) / 0.5;
    px[n + i] = (data[i * 4 + 1] / 255 - 0.5) / 0.5;
    px[2 * n + i] = (data[i * 4 + 2] / 255 - 0.5) / 0.5;
  }
  const t0 = performance.now();
  const out = await engine.session.run({
    pixel_values: new ort.Tensor("float32", px, [1, 3, SIGLIP2_SIZE, SIGLIP2_SIZE]),
  });
  return { p_ad: Number(out.p_ad.data[0]), ms: Math.round(performance.now() - t0) };
}

// engineKind is passed IN from the background worker — offscreen documents
// do not reliably expose chrome.storage across Chrome builds. It's a catalog
// KEY; we resolve it to a model entry (dir + kind) and reload when the resolved
// model changes (popup engine switch, or first load).
let loadedEngineKey = null;

// A WebGPU device can be LOST at runtime — GPU-process restart, driver reset, or
// memory pressure (common on video-heavy pages like streaming sites). Once lost,
// every OrtRun on that device fails forever ("A valid external Instance reference
// no longer exists" / mapAsync / device lost) — the engine is a corpse and the
// extension silently stops blocking anything. So: detect that error class and
// REBUILD the engine on a fresh device instead of retrying on the dead one.
function isFatalGpuError(e) {
  return /Instance reference no longer exists|failed to call OrtRun|mapAsync|device (is )?lost|buffer_manager|Failed to download data from buffer|GPUDevice|Device lost/i.test(String(e));
}
// Disposal of a dead/old engine's WebGPU device must FINISH before a new device
// is created — otherwise the two contend and the new load wedges in "loading"
// forever (Tegra device-teardown race; the recurring stuck-loading bug). We
// stash the disposal promise and make getEngine await it before rebuilding.
let disposalDone = null;
function disposeOld(old) {
  disposalDone = Promise.resolve(old)
    .then((eng) => { try { eng?.model?.dispose?.(); } catch {} })
    .catch(() => {})
    .then(() => new Promise((r) => setTimeout(r, 250))); // let the GPU device fully tear down
  return disposalDone;
}
function resetEngine() {
  const old = enginePromise;
  enginePromise = null;
  loadedEngineKey = null;
  engineInfo = { state: "cold" };
  disposeOld(old);
}

// Concurrent classify batches (content.js runs in all_frames) can each hit a
// fatal GPU error on the SAME shared engine. Without a guard, batch B would
// resetEngine a second time and dispose the fresh engine batch A just rebuilt.
// Only the batch whose dead engine is still the live one triggers the reset;
// the others simply adopt whatever engine is current now.
async function rebuildEngine(deadEngine, engineKind) {
  const cur = await Promise.resolve(enginePromise).catch(() => null);
  if (cur && cur !== deadEngine) return cur;   // already rebuilt by another batch
  if (cur === deadEngine) resetEngine();
  return getEngine(engineKind);
}

async function getEngine(engineKind = "lfm") {
  const catalog = await getCatalog();
  const entry = resolveModel(catalog, engineKind);
  if (enginePromise && loadedEngineKey !== entry.key) {
    // Engine switch: dispose the previous device before creating the new one.
    disposeOld(enginePromise);
    enginePromise = null;
    engineInfo = { state: "cold" };
  }
  if (!enginePromise) {
    loadedEngineKey = entry.key;
    // Assign enginePromise SYNCHRONOUSLY (before any await) so a concurrent
    // getEngine sees it and shares this one build — single-flight. The pending
    // disposal barrier is folded INTO the builder (not awaited out here where a
    // racing caller could null it and skip the wait), so the new WebGPU device
    // is created only after the old one has fully torn down.
    const pending = disposalDone;
    disposalDone = null;
    enginePromise = (async () => {
      if (pending) await pending;
      return Promise.race([
        (entry.kind === "siglip2" ? loadSiglip2Engine(entry) : loadEngine(entry)),
        // A WebGPU load that never resolves (Tegra device wedge after a reset)
        // would leave the engine stuck "loading" forever, silently blocking
        // nothing. Time it out so the next classify/status triggers a clean retry.
        new Promise((_, rej) => setTimeout(() => rej(new Error("engine load timeout")), 90000)),
      ]);
    })()
      .catch((e) => {
        enginePromise = null;
        loadedEngineKey = null;
        // The quantized LFM model uses GatherBlockQuantized, which ORT's WASM
        // backend can't run — so on a machine without working WebGPU the session
        // fails to create. Turn that cryptic ORT error into clear guidance.
        const s = String(e);
        const needsGpu = /GatherBlockQuantized|Could not find an implementation|Can't create a session/i.test(s);
        engineInfo = {
          state: "error",
          error: needsGpu
            ? "This engine needs WebGPU, which isn't available. Enable it in your browser (chrome://flags → “Unsafe WebGPU”) and reload."
            : s,
        };
        throw e;
      });
  }
  return enginePromise;
}

// Manual render of the LFM chat template for our single-turn prompt — the
// template's {% generation %} tag is unsupported by transformers.js's jinja.
const PROMPT_TEXT =
  `<|startoftext|><|im_start|>user\n<image>${PROMPT}<|im_end|>\n<|im_start|>assistant\n`;

// Test affordance: `test-force-fail` makes the next N classifyOne calls throw
// the real WebGPU device-loss error, so the recovery path can be tested
// deterministically. Default 0 = no-op; harmless in production.
let testForceFail = 0;

async function classifyOne(engine, dataUrl) {
  if (testForceFail > 0) {
    testForceFail--;
    throw new Error("failed to call OrtRun(). ERROR_CODE: 1 ... Failed to execute 'mapAsync' on 'GPUBuffer': A valid external Instance reference no longer exists.");
  }
  if (engine.kind === "siglip2") return siglip2Classify(engine, dataUrl);
  const { model, processor, yesIds, noIds } = engine;
  const image = await RawImage.fromURL(dataUrl);
  const inputs = await processor(image, PROMPT_TEXT, { add_special_tokens: false });
  const t0 = performance.now();
  const { logits } = await model({ ...inputs });
  const ms = performance.now() - t0;

  const [, seq, vocab] = logits.dims;
  const last = logits.data.slice((seq - 1) * vocab, seq * vocab);
  const scored = [
    ...yesIds.map((i) => ({ v: Number(last[i]), yes: true })),
    ...noIds.map((i) => ({ v: Number(last[i]), yes: false })),
  ];
  const mx = Math.max(...scored.map((s) => s.v));
  let sy = 0, sn = 0;
  for (const s of scored) {
    const e = Math.exp(s.v - mx);
    if (s.yes) sy += e; else sn += e;
  }
  return { p_ad: sy / (sy + sn), ms: Math.round(ms) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "minus-offscreen") return;
  (async () => {
    try {
      if (msg.type === "engine-status") {
        // touch the engine so it starts warming up on first status call
        getEngine(msg.engineKind).catch(() => {});
        sendResponse({ ok: true, info: engineInfo });
      } else if (msg.type === "test-force-fail") {
        testForceFail = msg.n | 0;
        sendResponse({ ok: true });
      } else if (msg.type === "classify") {
        let engine = await getEngine(msg.engineKind);
        const results = [];
        let rebuilt = false;
        for (const img of msg.images) {
          try {
            results.push(await classifyOne(engine, img));
          } catch (e) {
            const fatal = isFatalGpuError(e);
            // On a lost GPU device, rebuild the engine ONCE for this batch, then
            // retry on the fresh one; a plain transient error just retries once.
            if (fatal && !rebuilt) {
              rebuilt = true;
              console.warn("[minus] GPU device lost — rebuilding engine:", String(e).slice(0, 120));
              try { engine = await rebuildEngine(engine, msg.engineKind); }
              catch (er) { results.push({ p_ad: 0, ms: 0, error: String(er) }); continue; }
            } else {
              console.warn("[minus] classify error, retrying once:", String(e).slice(0, 120));
            }
            try {
              results.push(await classifyOne(engine, img));
            } catch (e2) {
              results.push({ p_ad: 0, ms: 0, error: String(e2) });
            }
          }
        }
        sendResponse({ ok: true, results, engine: engineInfo });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});
