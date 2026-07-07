// Spike: load LFM2.5-VL ONNX via transformers.js on WebGPU in headless
// chromium, logit-decode P(ad) for one ad and one non-ad fixture.
//
// Uses a persistent profile so the ~700MB model download is cached across runs.
// MODEL_ID env overrides the model (later: our exported Iter 14).
import { chromium } from "playwright";
import { createServer } from "http";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL_ID = process.env.MODEL_ID || "onnx-community/LFM2.5-VL-450M-ONNX";
const DEVICE = process.env.DEVICE || "webgpu";

// tiny static server: fixtures, the spike page, and the built engine bundle
const TJS_DIST = join(HERE, "..", "extension", "dist");
const MIME = { js: "application/javascript", mjs: "application/javascript", wasm: "application/wasm", png: "image/png" };
const server = createServer((req, res) => {
  try {
    if (req.url === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end(PAGE);
    } else {
      const path = req.url.startsWith("/tjs/")
        ? join(TJS_DIST, req.url.slice(5))
        : join(HERE, "fixtures", req.url.slice(1));
      res.setHeader("Content-Type", MIME[path.split(".").pop()] || "application/octet-stream");
      res.end(readFileSync(path));
    }
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(8917, r));

const PAGE = `<!doctype html><html><body><script type="module">
import { AutoModelForImageTextToText, AutoProcessor, RawImage, env } from "/tjs/engine-lib.js";
env.backends.onnx.wasm.wasmPaths = "/tjs/";
// this driver returns null for high-performance adapter requests; force low-power
if (env.backends.onnx.webgpu) env.backends.onnx.webgpu.powerPreference = "low-power";

window.runSpike = async (modelId, device) => {
  const log = (m) => (window._status = m);
  try {
    log("loading processor");
    const processor = await AutoProcessor.from_pretrained(modelId);
    log("loading model");
    const model = await AutoModelForImageTextToText.from_pretrained(modelId, {
      device,
      dtype: { vision_encoder: "q8", embed_tokens: "fp32", decoder_model_merged: "q4" },
    });
    log("model loaded");
    const tok = processor.tokenizer;
    const yesIds = ["Yes","yes"," Yes"," yes"].map(v => tok.encode(v, {add_special_tokens:false})[0]).filter(x => x !== undefined);
    const noIds  = ["No","no"," No"," no"].map(v => tok.encode(v, {add_special_tokens:false})[0]).filter(x => x !== undefined);

    const classify = async (url) => {
      const image = await RawImage.fromURL(url);
      // manual render of the LFM chat template (its {% generation %} tag is
      // unsupported by the bundled jinja parser)
      const text = "<|startoftext|><|im_start|>user\\n<image>Is this an advertisement? Answer Yes or No.<|im_end|>\\n<|im_start|>assistant\\n";
      const inputs = await processor(image, text, { add_special_tokens: false });
      const t0 = performance.now();
      const { logits } = await model({ ...inputs });
      const ms = performance.now() - t0;
      const [, seq, vocab] = logits.dims;
      const last = logits.data.slice((seq - 1) * vocab, seq * vocab);
      const pick = (ids) => ids.map(i => last[i]);
      const all = [...pick(yesIds).map(v => ({v, yes: true})), ...pick(noIds).map(v => ({v, yes: false}))];
      const mx = Math.max(...all.map(a => a.v));
      const exp = all.map(a => ({ e: Math.exp(a.v - mx), yes: a.yes }));
      const sy = exp.filter(a => a.yes).reduce((s, a) => s + a.e, 0);
      const sn = exp.filter(a => !a.yes).reduce((s, a) => s + a.e, 0);
      return { p_ad: sy / (sy + sn), ms: Math.round(ms) };
    };

    const t0 = performance.now();
    const ad = await classify("/ad1.png");
    const nonad = await classify("/nonad1.png");
    return { ok: true, ad, nonad, total_ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), at: window._status };
  }
};
window._ready = true;
</script></body></html>`;

// NVIDIA Tegra + Dawn: a stale GPU shader disk cache breaks adapter creation
// on relaunch ("A valid external Instance reference no longer exists").
// Scrub the caches and keep Chrome from writing new ones.
const PROFILE = "/home/ubuntu/.cache/minus-spike-profile";
const { rmSync } = await import("fs");
for (const d of ["Default/GPUCache", "GrShaderCache", "GraphiteDawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "Default/DawnGraphiteCache", "Default/DawnWebGPUCache"]) {
  rmSync(join(PROFILE, d), { recursive: true, force: true });
}
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "chromium",
  headless: true,
  args: ["--no-sandbox", "--enable-unsafe-webgpu", "--ignore-gpu-blocklist",
         "--use-angle=vulkan", "--enable-features=Vulkan", "--disable-vulkan-surface",
         "--disable-gpu-shader-disk-cache"],
});
const page = ctx.pages()[0] || (await ctx.newPage());
page.on("console", (m) => console.log("[page]", m.text().slice(0, 300)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 500)));
page.on("requestfailed", (r) => console.log("[reqfail]", r.url().slice(0, 120), r.failure()?.errorText));
await page.goto("http://127.0.0.1:8917/");
await page.waitForFunction(() => window._ready, { timeout: 30000 });

console.log(`Running spike: ${MODEL_ID} on ${DEVICE} (download may take a while on first run)`);
const t0 = Date.now();
const result = await page.evaluate(
  ([m, d]) => window.runSpike(m, d),
  [MODEL_ID, DEVICE]
);
console.log(`wall: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(JSON.stringify(result, null, 2));
await ctx.close();
server.close();
process.exit(result.ok ? 0 : 1);
