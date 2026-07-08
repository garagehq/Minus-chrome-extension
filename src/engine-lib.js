// Single bundling entry for everything the Minus inference engine needs from
// transformers.js. esbuild resolves the externalized onnxruntime-web imports;
// the ORT wasm/mjs runtime assets are copied next to the bundle by build.mjs
// and located at runtime via env.backends.onnx.wasm.wasmPaths.
export {
  AutoModelForImageTextToText,
  AutoProcessor,
  AutoTokenizer,
  RawImage,
  Tensor,
  env,
} from "@huggingface/transformers";

// Raw ONNX Runtime for the SigLIP2 engine (single-graph classifier —
// no transformers.js model class needed). Default bundle = webgpu + wasm
// (the two EPs validated on this project's hardware). To enable the WebGL
// fallback for non-WebGPU machines, rebuild against "onnxruntime-web/all" —
// the SigLIP2 loader's EP chain already tries webgl when the runtime exposes
// it (see offscreen.js loadSiglip2Engine).
export * as ort from "onnxruntime-web/webgpu";
