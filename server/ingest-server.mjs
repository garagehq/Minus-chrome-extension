// Minus ingest server — receives opted-in, anonymized ad snapshots from the
// extension and pushes batches to a PRIVATE Hugging Face dataset. The HF write
// token lives HERE (env), never in the extension.
//
// Run locally:   node --env-file=.env server/ingest-server.mjs
// Deploy:        see server/DEPLOY.md (Fly.io)
//
// Env (see .env.example):
//   HF_DATASET     e.g. garagehq/minus-web-captures   (required for upload)
//   HF_TOKEN       hf_...  fine-grained WRITE token scoped to that dataset
//   INGEST_KEY     shared secret; clients must send `x-minus-key: <it>`
//   MINUS_INGEST_DIR   local staging dir (default ./captures)
//   PORT           default 8790
//   BATCH_UPLOAD   flush to HF every N samples (default 50)
//
// POST /ingest  {v:1, samples:[{key, img(dataURL), p_ad, verdict, host, w, h, engine}]}
// GET  /health  -> {ok, queued, uploaded, dataset}
import { createServer } from "http";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

const DIR = process.env.MINUS_INGEST_DIR || "./captures";
const PORT = Number(process.env.PORT || 8790);
const HF_DATASET = process.env.HF_DATASET || "";
const HF_TOKEN = process.env.HF_TOKEN || "";
const INGEST_KEY = process.env.INGEST_KEY || "";
const BATCH_UPLOAD = Number(process.env.BATCH_UPLOAD || 50);
const MAX_BODY = 40 * 1024 * 1024; // 40 MB
const RATE_MAX = 120;              // requests/min/IP
const RATE_WINDOW_MS = 60_000;

mkdirSync(join(DIR, "images"), { recursive: true });

// Content-hash dedup: never store the same image twice (the extension can
// capture an ad slot across several scans). Durable via a hashes file so it
// survives restarts / scale-to-zero.
const HASHES_FILE = join(DIR, "hashes.txt");
const seenHashes = new Set(
  existsSync(HASHES_FILE) ? readFileSync(HASHES_FILE, "utf8").split("\n").filter(Boolean) : []
);
let dupes = 0;

// lazy-load the HF client so the server still boots without the dep for
// local/no-upload testing
let uploadFiles = null;
async function hfUpload(files) {
  if (!HF_DATASET || !HF_TOKEN) return; // upload disabled -> local-only
  if (!uploadFiles) ({ uploadFiles } = await import("@huggingface/hub"));
  await uploadFiles({
    repo: { type: "dataset", name: HF_DATASET },
    accessToken: HF_TOKEN,
    files,
  });
}

// ---- state ----------------------------------------------------------------
let queued = 0, uploaded = 0;
let pending = [];              // {path (in-repo), content: Uint8Array}
const rate = new Map();        // ip -> {count, resetAt}

function rateLimited(ip) {
  const now = Date.now();
  const r = rate.get(ip);
  if (!r || now > r.resetAt) { rate.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS }); return false; }
  r.count++;
  return r.count > RATE_MAX;
}

async function flush() {
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  // Collapse duplicate paths (samples.jsonl is re-pushed per sample) — keep the
  // last version of each path; uploadFiles rejects conflicting duplicate paths.
  const byPath = new Map();
  for (const f of batch) byPath.set(f.path, f);
  const files = [...byPath.values()];
  try {
    await hfUpload(files.map((f) => ({ path: f.path, content: new Blob([f.content]) })));
    uploaded += files.length;
  } catch (e) {
    console.error("hf upload failed, will retry:", e.message);
    pending = batch.concat(pending); // requeue
  }
}

// ---- http -----------------------------------------------------------------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-minus-key" });
  res.end(body);
}

createServer((req, res) => {
  if (req.method === "OPTIONS") return send(res, 200, {});
  if (req.method === "GET" && req.url === "/health")
    return send(res, 200, { ok: true, queued, uploaded, pending: pending.length, dupesSkipped: dupes,
      dataset: HF_DATASET || null, upload: !!(HF_DATASET && HF_TOKEN) });
  if (req.method !== "POST" || req.url !== "/ingest") return send(res, 404, { error: "not found" });

  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
  if (rateLimited(ip)) return send(res, 429, { error: "rate limited" });
  if (INGEST_KEY && req.headers["x-minus-key"] !== INGEST_KEY) return send(res, 401, { error: "unauthorized" });

  let body = "", killed = false;
  req.on("data", (c) => { body += c; if (body.length > MAX_BODY) { killed = true; req.destroy(); } });
  req.on("end", async () => {
    if (killed) return;
    try {
      const { samples = [] } = JSON.parse(body);
      const day = new Date().toISOString().slice(0, 10);
      let n = 0;
      for (const s of samples) {
        const b64 = String(s.img || "").split(",")[1] || "";
        if (!b64) continue;
        const png = Buffer.from(b64, "base64");
        const hash = createHash("sha1").update(png).digest("hex");
        if (seenHashes.has(hash)) { dupes++; continue; } // byte-identical duplicate — skip
        seenHashes.add(hash);
        appendFileSync(HASHES_FILE, hash + "\n");
        const id = `${day}_${String(s.key).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        writeFileSync(join(DIR, "images", `${id}.png`), png);
        const meta = { id, p_ad: s.p_ad, verdict: s.verdict, host: s.host, w: s.w, h: s.h,
          engine: s.engine, received: Date.now() };
        appendFileSync(join(DIR, "samples.jsonl"), JSON.stringify(meta) + "\n");
        pending.push({ path: `images/${id}.png`, content: png });
        pending.push({ path: `samples.jsonl`, content: Buffer.from(readFileSync(join(DIR, "samples.jsonl"))) });
        queued++; n++;
      }
      if (queued % BATCH_UPLOAD < n) await flush();
      send(res, 200, { ok: true, received: n });
    } catch (e) {
      send(res, 400, { ok: false, error: String(e) });
    }
  });
}).listen(PORT, () => console.log(
  `minus ingest on :${PORT} -> ${DIR}` +
  (HF_DATASET && HF_TOKEN ? ` (sync -> ${HF_DATASET})` : " (local only — set HF_DATASET+HF_TOKEN to sync)") +
  (INGEST_KEY ? " [auth on]" : " [auth OFF — set INGEST_KEY]")));

// periodic flush so trickle traffic still uploads
setInterval(flush, 5 * 60_000);
