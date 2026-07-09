// Shared, dependency-free model-catalog logic. Imported by offscreen.js (engine
// resolution + transformers.js env flags), by build_model_index.mjs (the
// packaging scanner), and by the tests — so all three agree with zero browser
// or Node globals in this file.

// Built-in fallback used when models/index.json is missing or unreadable. The
// generated index.json supersedes it. `key` is the stable id stored in settings
// (so "lfm" always means "the current recommended default", whatever dir that
// points at); `dir` is the packaged folder; `kind` selects the loader
// (lfm = transformers.js multi-file, siglip2 = single ONNX graph).
export const FALLBACK_CATALOG = {
  default: "lfm",
  models: [
    { key: "lfm", dir: "lfm-iter21web", kind: "lfm", label: "LFM Iter 21-web (default — web ads, no content false-positives)" },
    { key: "lfm-iter22", dir: "lfm-iter22web", kind: "lfm", label: "LFM Iter 22-web (experimental — higher web-ad recall)" },
    { key: "lfm-web", dir: "lfm-iter20web", kind: "lfm", label: "LFM Iter 20-web (aggressive web-ad blocking)" },
    { key: "lfm-stream", dir: "lfm-iter14", kind: "lfm", label: "LFM Iter 14 (streaming-only)" },
    { key: "siglip2", dir: "siglip2", kind: "siglip2", label: "SigLIP2-384 (fast)" },
    { key: "lite", dir: "lite", kind: "siglip2", label: "Lite B/16 (low-end / no-WebGPU, 178MB)" },
  ],
};

// Normalize a raw catalog object (e.g. parsed index.json) into a safe shape:
// drop malformed entries, and guarantee `default` names a real entry.
export function parseCatalog(raw) {
  const models = Array.isArray(raw?.models)
    ? raw.models.filter((m) => m && typeof m.key === "string" && typeof m.dir === "string")
    : [];
  if (!models.length) return { default: FALLBACK_CATALOG.default, models: FALLBACK_CATALOG.models.slice() };
  const def = models.some((m) => m.key === raw.default) ? raw.default : models[0].key;
  return { default: def, models };
}

// Resolve a stored engineKind to a catalog entry, falling back to the default
// entry when the key is unknown (e.g. the model it named was removed).
export function resolveModel(catalog, engineKind) {
  const c = parseCatalog(catalog);
  return c.models.find((m) => m.key === engineKind)
      || c.models.find((m) => m.key === c.default)
      || c.models[0];
}

// transformers.js `env` is a shared singleton across engine loads. Return BOTH
// flags on every load so switching engines can never inherit a prior local
// load's allowRemoteModels=false and then fail "file was not found locally".
export function modelEnvFlags(useLocal) {
  return { allowLocalModels: true, allowRemoteModels: !useLocal };
}

// Best-effort human label from a packaged dir name, for models added without an
// explicit label. "lfm-iter23web" -> "LFM Iter 23-web"; "lite" -> "Lite".
export function prettifyLabel(dir) {
  const iter = dir.match(/^lfm-iter(\d+)(web)?$/i);
  if (iter) return `LFM Iter ${iter[1]}${iter[2] ? "-web" : ""}`;
  return dir.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Infer the loader kind from the file names directly under a model dir.
//   config.json                 -> "lfm"      (transformers.js multi-file model)
//   model.onnx / model_fp16.onnx -> "siglip2" (single self-contained graph)
// Returns null for anything that isn't a recognizable model dir.
export function inferKind(filesLower) {
  if (filesLower.includes("config.json")) return "lfm";
  if (filesLower.some((f) => /^model(_fp16)?\.onnx$/.test(f))) return "siglip2";
  return null;
}
