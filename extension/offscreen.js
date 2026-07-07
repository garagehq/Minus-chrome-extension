// Minus inference engine — runs INSIDE the browser in an MV3 offscreen
// document (window context: WebGPU + canvas available, survives while the
// service worker sleeps).
//
// Engine: LFM2.5-VL (our Iter 14 fine-tune when packaged under models/,
// otherwise the stock ONNX from the HF hub) via transformers.js, WebGPU with
// WASM fallback. Verdict = logit decode: softmax over Yes/No token logits at
// the first generated position — the same decoder the training campaign used.

import { AutoModelForImageTextToText, AutoProcessor, RawImage, env } from "./dist/engine-lib.js";

env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("dist/");
// some drivers (e.g. NVIDIA Tegra Vulkan) return null for high-performance
// adapter requests; low-power resolves to the same (only) GPU
if (env.backends.onnx.webgpu) env.backends.onnx.webgpu.powerPreference = "low-power";

const PROMPT = "Is this an advertisement? Answer Yes or No.";
const HUB_MODEL = "onnx-community/LFM2.5-VL-450M-ONNX";
const LOCAL_MODEL = "lfm-iter14"; // extension/models/lfm-iter14 if packaged

let enginePromise = null;
let engineInfo = { state: "cold" };

async function localModelAvailable() {
  try {
    const url = chrome.runtime.getURL(`models/${LOCAL_MODEL}/config.json`);
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}

async function loadEngine() {
  const useLocal = await localModelAvailable();
  let modelId = HUB_MODEL;
  if (useLocal) {
    env.allowRemoteModels = false;
    env.localModelPath = chrome.runtime.getURL("models/");
    modelId = LOCAL_MODEL;
  }

  const dtype = { vision_encoder: "q8", embed_tokens: "fp32", decoder_model_merged: "q4" };
  let device = "webgpu";
  engineInfo = { state: "loading", modelId, device };

  const processor = await AutoProcessor.from_pretrained(modelId);
  let model;
  try {
    model = await AutoModelForImageTextToText.from_pretrained(modelId, { device, dtype });
  } catch (e) {
    console.warn("[minus] WebGPU load failed, falling back to WASM:", e);
    device = "wasm";
    model = await AutoModelForImageTextToText.from_pretrained(modelId, { device, dtype });
  }

  const tok = processor.tokenizer;
  const ids = (variants) =>
    variants.map((v) => tok.encode(v, { add_special_tokens: false })[0]).filter((x) => x !== undefined);
  const yesIds = ids(["Yes", "yes", " Yes", " yes"]);
  const noIds = ids(["No", "no", " No", " no"]);

  engineInfo = { state: "ready", modelId, device };
  return { model, processor, yesIds, noIds };
}

function getEngine() {
  if (!enginePromise) {
    enginePromise = loadEngine().catch((e) => {
      enginePromise = null;
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
        getEngine().catch(() => {});
        sendResponse({ ok: true, info: engineInfo });
      } else if (msg.type === "classify") {
        const engine = await getEngine();
        const results = [];
        for (const img of msg.images) {
          try {
            results.push(await classifyOne(engine, img));
          } catch (e) {
            console.warn("[minus] classify error:", e);
            results.push({ p_ad: 0, ms: 0, error: String(e) });
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
