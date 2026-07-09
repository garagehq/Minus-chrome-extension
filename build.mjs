// Build the self-contained inference bundle used by both the extension and
// the test pages: dist/engine-lib.js + the ONNX Runtime wasm/mjs assets.
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { buildIndex } from "./build_model_index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "extension", "dist");
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: [join(HERE, "src", "engine-lib.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: join(OUT, "engine-lib.js"),
  minify: true,
  logLevel: "info",
  // ORT loads its wasm runtime dynamically; keep those as copied assets
  external: ["node:*"],
});

// copy the ORT web runtime assets next to the bundle
const ORT_DIST = join(HERE, "node_modules", "onnxruntime-web", "dist");
let copied = 0;
for (const f of readdirSync(ORT_DIST)) {
  if (/\.(wasm|mjs)$/.test(f) && !f.includes("node")) {
    cpSync(join(ORT_DIST, f), join(OUT, f));
    copied++;
  }
}
console.log(`copied ${copied} ORT runtime assets -> ${OUT}`);

// Regenerate the model catalog so newly-packaged models are auto-discovered by
// the popup dropdown and the offscreen loader.
const MODELS_DIR = join(HERE, "extension", "models");
const INDEX = join(MODELS_DIR, "index.json");
const prevIndex = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, "utf8")) : undefined;
const modelIndex = buildIndex(MODELS_DIR, prevIndex);
writeFileSync(INDEX, JSON.stringify(modelIndex, null, 2) + "\n");
console.log(`model index -> ${modelIndex.models.length} models (default: ${modelIndex.default})`);
