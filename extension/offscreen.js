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

// A few loader warnings are emitted via console.* by ORT / transformers.js and
// are benign for a packaged, local-only model. Filter exactly those strings so
// the extension console stays clean without hiding real errors. (The WebGPU
// "powerPreference ignored" line is emitted by Chromium itself, below the JS
// console layer, so it can't be intercepted here — it's harmless.)
const MUTE = [
  "Unable to determine content-length",
  "Unable to add response to browser cache",
  "Some nodes were not assigned to the preferred execution providers",
  "CleanUnusedInitializersAndNodeArgs",
  "Failed to get GPU adapter",       // flaky/absent WebGPU — we catch this and fall back to WASM
  "wasm streaming compile failed",   // benign: ORT then instantiates from ArrayBuffer instead
];
for (const level of ["log", "info", "warn", "error"]) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    if (typeof args[0] === "string" && MUTE.some((m) => args[0].includes(m))) return;
    orig(...args);
  };
}

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

// The first requestAdapter() of a session can fail while the browser's GPU
// service spins up (seen on NVIDIA Tegra; harmless elsewhere). Warm it up so
// ORT's own single attempt doesn't land on the flake and dump us to WASM.
async function warmUpWebGpu(tries = 6, delayMs = 1500) {
  if (!navigator.gpu) return false;
  for (let i = 0; i < tries; i++) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
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
  let model;
  try {
    model = await AutoModelForImageTextToText.from_pretrained(modelId, { device, dtype, progress_callback });
  } catch (e) {
    console.warn("[minus] WebGPU load failed, falling back to WASM:", e);
    device = "wasm";
    model = await AutoModelForImageTextToText.from_pretrained(modelId, { device, dtype, progress_callback });
  }

  const tok = processor.tokenizer;
  const ids = (variants) =>
    variants.map((v) => tok.encode(v, { add_special_tokens: false })[0]).filter((x) => x !== undefined);
  const yesIds = ids(["Yes", "yes", " Yes", " yes"]);
  const noIds = ids(["No", "no", " No", " no"]);

  const engine = { model, processor, yesIds, noIds };

  // Warm-up inference on a dummy image: shader compilation / first-run JIT
  // lands here instead of on the first real page scan.
  try {
    const canvas = new OffscreenCanvas(64, 64);
    canvas.getContext("2d").fillRect(0, 0, 64, 64);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const url = await new Promise((r) => {
      const fr = new FileReader();
      fr.onload = () => r(fr.result);
      fr.readAsDataURL(blob);
    });
    await classifyOne(engine, url);
  } catch (e) {
    console.warn("[minus] warm-up inference failed (continuing):", e);
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
async function getEngine(engineKind = "lfm") {
  const catalog = await getCatalog();
  const entry = resolveModel(catalog, engineKind);
  if (enginePromise && loadedEngineKey !== entry.key) {
    enginePromise = null;
    engineInfo = { state: "cold" };
  }
  if (!enginePromise) {
    loadedEngineKey = entry.key;
    enginePromise = (async () => (entry.kind === "siglip2" ? loadSiglip2Engine(entry) : loadEngine(entry)))()
      .catch((e) => {
        enginePromise = null;
        loadedEngineKey = null;
        engineInfo = { state: "error", error: String(e) };
        throw e;
      });
  }
  return enginePromise;
}

// Manual render of the LFM chat template for our single-turn prompt — the
// template's {% generation %} tag is unsupported by transformers.js's jinja.
const PROMPT_TEXT =
  `<|startoftext|><|im_start|>user\n<image>${PROMPT}<|im_end|>\n<|im_start|>assistant\n`;

async function classifyOne(engine, dataUrl) {
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
      } else if (msg.type === "classify") {
        const engine = await getEngine(msg.engineKind);
        const results = [];
        for (const img of msg.images) {
          try {
            results.push(await classifyOne(engine, img));
          } catch (e) {
            console.warn("[minus] classify error, retrying once:", e);
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
