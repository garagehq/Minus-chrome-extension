// Regenerate extension/models/index.json from the packaged model dirs so a new
// model shows up in the engine dropdown AND the loader with no code edits:
// drop the dir under extension/models/, run `node build_model_index.mjs` (also
// invoked by build.mjs), and it's discovered automatically.
//
// Curated entries already in index.json (stable key, editorial label, order,
// which one is `default`) are PRESERVED; any packaged dir with no entry is
// auto-appended with an inferred kind + a derived label; entries whose dir no
// longer exists are dropped.
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { FALLBACK_CATALOG, inferKind, prettifyLabel, parseCatalog } from "./extension/models_catalog.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(HERE, "extension", "models");
const INDEX = join(MODELS_DIR, "index.json");

// [{ dir, kind }] for every recognizable model dir under modelsDir.
export function scanModels(modelsDir) {
  const dirs = readdirSync(modelsDir).filter((d) => {
    try { return statSync(join(modelsDir, d)).isDirectory(); } catch { return false; }
  });
  return dirs
    .map((dir) => ({ dir, kind: inferKind(readdirSync(join(modelsDir, dir)).map((f) => f.toLowerCase())) }))
    .filter((m) => m.kind);
}

// Merge the on-disk models with the previous catalog: keep curated entries that
// still exist, append newly-found dirs, drop vanished ones.
export function buildIndex(modelsDir, prev) {
  const scanned = scanModels(modelsDir);
  const scannedDirs = new Set(scanned.map((m) => m.dir));
  const prevCat = parseCatalog(prev || FALLBACK_CATALOG);

  const kept = prevCat.models.filter((m) => scannedDirs.has(m.dir));
  const keptDirs = new Set(kept.map((m) => m.dir));

  const added = scanned
    .filter((m) => !keptDirs.has(m.dir))
    .map((m) => ({ key: m.dir, dir: m.dir, kind: m.kind, label: prettifyLabel(m.dir) }));

  const models = [...kept, ...added];
  const def = models.some((m) => m.key === prevCat.default) ? prevCat.default : (models[0]?.key || "lfm");
  return { default: def, models };
}

// CLI entry — skipped when imported (build.mjs / tests).
if (process.argv[1] && process.argv[1].endsWith("build_model_index.mjs")) {
  const prev = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, "utf8")) : FALLBACK_CATALOG;
  const scanned = scanModels(MODELS_DIR);
  let index;
  if (scanned.length === 0) {
    // No model dirs on disk (dev box / test sandbox): use the fallback
    // catalog directly so tests and the popup still work without models/.
    index = parseCatalog(prev);
  } else {
    index = buildIndex(MODELS_DIR, prev);
  }
  writeFileSync(INDEX, JSON.stringify(index, null, 2) + "\n");
  console.log(`wrote ${INDEX}\n  ${index.models.length} models: ${index.models.map((m) => `${m.key}→${m.dir}`).join(", ")}\n  default: ${index.default}`);
}
