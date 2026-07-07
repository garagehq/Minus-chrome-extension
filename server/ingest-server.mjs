// Reference ingest server for opted-in Minus ad snapshots.
// Deploy anywhere Node runs; the HF write token stays HERE, never in the
// extension. Writes samples to disk as JSONL + PNGs; optionally syncs the
// dataset directory to a (private) Hugging Face dataset repo.
//
//   MINUS_INGEST_DIR=./captures PORT=8790 node server/ingest-server.mjs
//   # optional HF sync (needs `pip install huggingface_hub` + HF_TOKEN):
//   #   HF_DATASET=garagehq/minus-web-captures HF_TOKEN=hf_xxx ...
//
// POST /ingest  {v:1, samples:[{key, img(dataURL), p_ad, verdict, host, w, h, engine}]}
import { createServer } from "http";
import { mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { execFile } from "child_process";

const DIR = process.env.MINUS_INGEST_DIR || "./captures";
const PORT = Number(process.env.PORT || 8790);
const HF_DATASET = process.env.HF_DATASET || "";
const MAX_BODY = 40 * 1024 * 1024;

mkdirSync(join(DIR, "images"), { recursive: true });

let sinceSync = 0;
function maybeSyncToHf() {
  if (!HF_DATASET || ++sinceSync < 200) return;
  sinceSync = 0;
  execFile("hf", ["upload", HF_DATASET, DIR, "--repo-type", "dataset"],
    { env: process.env }, (err) => err && console.error("hf sync failed:", err.message));
}

createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/ingest") {
    res.statusCode = 404;
    return res.end();
  }
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > MAX_BODY) req.destroy();
  });
  req.on("end", () => {
    try {
      const { samples = [] } = JSON.parse(body);
      const day = new Date().toISOString().slice(0, 10);
      for (const s of samples) {
        const id = `${day}_${s.key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        const b64 = String(s.img || "").split(",")[1] || "";
        if (!b64) continue;
        writeFileSync(join(DIR, "images", `${id}.png`), Buffer.from(b64, "base64"));
        appendFileSync(join(DIR, "samples.jsonl"), JSON.stringify({
          id, p_ad: s.p_ad, verdict: s.verdict, host: s.host,
          w: s.w, h: s.h, engine: s.engine, received: Date.now(),
        }) + "\n");
      }
      maybeSyncToHf();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, received: samples.length }));
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  });
}).listen(PORT, () => console.log(`minus ingest on :${PORT} -> ${DIR}${HF_DATASET ? ` (sync: ${HF_DATASET})` : ""}`));
