// First-run UX (#63): with no model packaged locally, the engine must fall
// back to downloading from the HF hub AND report progress (for the popup bar).
// We don't wait for the full ~700MB — we confirm the download starts and
// progress advances, which validates the fallback + progress plumbing.
import { launchWithExtension, serveFixtures } from "./harness.mjs";
import { renameSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = join(HERE, "..", "extension", "models");
const STASH = join(HERE, "..", "extension", "_models_stashed");

let moved = false;
if (existsSync(MODELS)) { renameSync(MODELS, STASH); moved = true; }

const server = await serveFixtures();
let ctx, fail = 0;
try {
  ctx = await launchWithExtension();
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 60000 });
  // trigger engine load and poll for hub-download + progress
  const t0 = Date.now();
  let sawHub = false, sawProgress = false, ready = false;
  while (Date.now() - t0 < 120000) {
    const info = await sw.evaluate(async () => {
      if (typeof ensureOffscreen === "function") await ensureOffscreen();
      const r = await new Promise((res) =>
        chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status", engineKind: "lfm" }, res));
      return r?.info || r;
    });
    if (info?.modelId && info.modelId.includes("onnx-community")) sawHub = true;
    if (typeof info?.progress === "number" && info.progress > 0) sawProgress = true;
    if (info?.state === "ready") { ready = true; break; }
    if (info?.state === "error") { console.log("engine error:", info.error); break; }
    if (sawHub && sawProgress) break; // fallback + progress proven; no need to finish 700MB
    await new Promise((r) => setTimeout(r, 3000));
  }
  const p = (n, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; };
  p("falls back to HF hub model when nothing packaged", sawHub || ready);
  p("reports download progress for the popup bar", sawProgress || ready);
} catch (e) {
  console.log("FAIL (exception)", String(e).split("\n")[0]); fail++;
} finally {
  if (ctx) await ctx.close();
  server.close();
  if (moved) renameSync(STASH, MODELS); // ALWAYS restore local models
}
console.log(fail ? `${fail} failure(s)` : "all green");
process.exit(fail ? 1 : 0);
