// Pure unit tests (no browser) for the model catalog + scanner. Guards:
//  - engine-switch env fix (modelEnvFlags is symmetric)
//  - engineKind -> model resolution with default fallback
//  - auto-discovery: a newly-dropped model dir appears; a removed one drops;
//    curated entries (stable key/label/default) are preserved
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  FALLBACK_CATALOG, parseCatalog, resolveModel, modelEnvFlags, prettifyLabel, inferKind,
} from "../extension/models_catalog.js";
import { scanModels, buildIndex } from "../build_model_index.mjs";

let failures = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { failures++; console.log(`      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};
const ok = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failures++; };

// --- env flags: the engine-switch regression. Both flags on every load. ------
eq("modelEnvFlags(local) allows local, blocks remote", modelEnvFlags(true), { allowLocalModels: true, allowRemoteModels: false });
eq("modelEnvFlags(non-local) allows remote fallback", modelEnvFlags(false), { allowLocalModels: true, allowRemoteModels: true });

// --- resolution + default fallback -------------------------------------------
ok("resolveModel(known key) returns that entry", resolveModel(FALLBACK_CATALOG, "lfm-web").dir === "lfm-iter20web");
ok("resolveModel(unknown key) falls back to default", resolveModel(FALLBACK_CATALOG, "does-not-exist").key === "lfm");
ok("default key resolves to the current default dir", resolveModel(FALLBACK_CATALOG, "lfm").dir === "lfm-iter24");
ok("parseCatalog repairs a bad default", parseCatalog({ default: "ghost", models: [{ key: "a", dir: "a" }] }).default === "a");
ok("parseCatalog on junk yields the fallback", parseCatalog(null).models.length === FALLBACK_CATALOG.models.length);

// --- per-engine thresholds (the Iter 24 threshold-lever plumbing) -------------
ok("parseCatalog preserves an entry's thresholds field",
   parseCatalog({ default: "a", models: [{ key: "a", dir: "a", thresholds: { ctx: 0.35, bare: 0.75 } }] })
     .models[0].thresholds?.ctx === 0.35);
{
  const { readFileSync } = await import("fs");
  const idx = JSON.parse(readFileSync(new URL("../extension/models/index.json", import.meta.url)));
  const lfm = idx.models.find((m) => m.key === "lfm");
  const th = lfm?.thresholds;
  ok("packaged index.json default engine carries sane thresholds",
     !!th && th.ctx > 0.05 && th.ctx < 0.6 && th.bare > th.ctx && th.bare < 0.9);
}

// --- label + kind inference ---------------------------------------------------
eq("prettifyLabel lfm-iter23web", prettifyLabel("lfm-iter23web"), "LFM Iter 23-web");
eq("prettifyLabel lfm-iter14", prettifyLabel("lfm-iter14"), "LFM Iter 14");
eq("prettifyLabel lite", prettifyLabel("lite"), "Lite");
eq("inferKind config.json -> lfm", inferKind(["config.json", "onnx"]), "lfm");
eq("inferKind model_fp16.onnx -> siglip2", inferKind(["model_fp16.onnx", "preprocess.json"]), "siglip2");
eq("inferKind unrecognized -> null", inferKind(["readme.txt"]), null);

// --- scanner auto-discovery on a temp models dir -----------------------------
const root = mkdtempSync(join(tmpdir(), "minus-models-"));
const mk = (dir, files) => {
  mkdirSync(join(root, dir), { recursive: true });
  for (const f of files) writeFileSync(join(root, dir, f), "{}");
};
mk("lfm-iter21web", ["config.json"]);   // curated, still present -> kept
mk("lfm-iter99web", ["config.json"]);   // NEW lfm -> auto-appended
mk("newvit", ["model_fp16.onnx", "preprocess.json"]); // NEW siglip2 -> auto-appended
mk("not-a-model", ["notes.md"]);        // no model files -> ignored

const prev = {
  default: "lfm",
  models: [
    { key: "lfm", dir: "lfm-iter21web", kind: "lfm", label: "LFM Iter 21-web (curated)" },
    { key: "lfm-stream", dir: "lfm-iter14", kind: "lfm", label: "LFM Iter 14" }, // dir gone -> dropped
  ],
};
const idx = buildIndex(root, prev);
const byKey = Object.fromEntries(idx.models.map((m) => [m.key, m]));

ok("scanModels ignores non-model dirs", !scanModels(root).some((m) => m.dir === "not-a-model"));
ok("curated entry preserved (key + label)", byKey["lfm"]?.dir === "lfm-iter21web" && byKey["lfm"].label === "LFM Iter 21-web (curated)");
ok("removed dir dropped from catalog", !idx.models.some((m) => m.dir === "lfm-iter14"));
ok("new lfm model auto-appended", byKey["lfm-iter99web"]?.kind === "lfm" && byKey["lfm-iter99web"].label === "LFM Iter 99-web");
ok("new siglip2 model auto-appended", byKey["newvit"]?.kind === "siglip2");
ok("default preserved when its dir survives", idx.default === "lfm");
rmSync(root, { recursive: true, force: true });

console.log(failures ? `\n${failures} failure(s)` : "\nall green");
process.exit(failures ? 1 : 0);
