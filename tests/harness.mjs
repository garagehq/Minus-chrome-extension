// Shared Playwright harness for extension tests.
// - launches chromium (full build) headless with the extension loaded and the
//   WebGPU flags this Linux/NVIDIA box needs (regular desktop Chrome needs none)
// - retries launch when the Tegra/Dawn adapter flakes ("Instance reference
//   no longer exists" ~50% of cold launches)
// - persistent profile so the ~500MB model download is cached across runs
import { chromium } from "playwright";
import { createServer } from "http";
import { readFileSync, rmSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = join(HERE, "..", "extension");
const PROFILE = process.env.MINUS_TEST_PROFILE || "/home/ubuntu/.cache/minus-ext-profile";

const GPU_FLAGS = [
  "--no-sandbox",
  "--enable-unsafe-webgpu",
  "--ignore-gpu-blocklist",
  "--use-angle=vulkan",
  "--enable-features=Vulkan",
  "--disable-vulkan-surface",
  "--disable-gpu-shader-disk-cache",
];

function scrubGpuCaches() {
  for (const d of [
    "Default/GPUCache", "GrShaderCache", "GraphiteDawnCache", "DawnGraphiteCache",
    "DawnWebGPUCache", "Default/DawnGraphiteCache", "Default/DawnWebGPUCache",
    // Chrome caches the extension's MV3 service worker script here and will
    // happily run a STALE background.js after we edit it — always refetch.
    "Default/Service Worker",
  ]) {
    rmSync(join(PROFILE, d), { recursive: true, force: true });
  }
}

async function webgpuAlive(ctx) {
  const page = await ctx.newPage();
  try {
    await page.goto("https://example.com", { timeout: 20000 });
    return await page.evaluate(async () => {
      if (!navigator.gpu) return false;
      // The FIRST requestAdapter in a fresh session can fail while the GPU
      // service spins up (observed on NVIDIA Tegra/Vulkan) — retry in-session.
      // Explicit power preferences also return null on this driver; use default.
      for (let i = 0; i < 6; i++) {
        const a = await navigator.gpu.requestAdapter();
        if (a && (a.info?.vendor || "") !== "google") return true; // google == swiftshader
        await new Promise((r) => setTimeout(r, 1500));
      }
      return false;
    });
  } catch {
    return false;
  } finally {
    await page.close();
  }
}

export async function launchWithExtension({ requireGpu = true, attempts = 4 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    scrubGpuCaches();
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: "chromium",
      headless: true,
      args: [
        ...GPU_FLAGS,
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
      ],
    });
    if (!requireGpu || (await webgpuAlive(ctx))) return ctx;
    console.log(`[harness] WebGPU adapter flake, relaunching (${i}/${attempts})`);
    await ctx.close();
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("could not get a WebGPU adapter after retries");
}

// Static fixture server: serves tests/fixtures at http://127.0.0.1:<port>
export function serveFixtures(port = 8919) {
  const MIME = { html: "text/html", js: "application/javascript", png: "image/png",
                 webm: "video/webm", mp4: "video/mp4", css: "text/css" };
  const server = createServer((req, res) => {
    try {
      const path = join(HERE, "fixtures", req.url.replace(/^\/+/, "").split("?")[0] || "index.html");
      res.setHeader("Content-Type", MIME[path.split(".").pop()] || "application/octet-stream");
      res.end(readFileSync(path));
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  // Retry on EADDRINUSE: a prior test's server may still be releasing the
  // port (or a crashed run left a lingering socket in TIME_WAIT).
  return new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = () => {
      server.once("error", (e) => {
        if (e.code === "EADDRINUSE" && ++tries < 20) {
          setTimeout(attempt, 1500);
        } else {
          reject(e);
        }
      });
      server.listen(port, () => resolve(server));
    };
    attempt();
  });
}

// Wait until the extension's engine reports ready (first run downloads the
// model, so the ceiling is generous).
export async function waitForEngine(ctx, timeoutMs = 15 * 60 * 1000) {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 60000 });
  const t0 = Date.now();
  for (;;) {
    const info = await sw.evaluate(async () => {
      try {
        // NB: a context never receives its own runtime message, so from the
        // service worker we must address the offscreen document directly.
        if (typeof ensureOffscreen === "function") await ensureOffscreen();
        const r = await new Promise((resolve) =>
          chrome.runtime.sendMessage({ target: "minus-offscreen", type: "engine-status" }, resolve));
        return r?.info || r || { state: "no-offscreen-response" };
      } catch (e) {
        return { state: "swerr", error: String(e) };
      }
    });
    if (info?.state === "ready") return info;
    if (info?.state === "error") throw new Error(`engine error: ${info.error}`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`engine not ready in time (last: ${JSON.stringify(info)})`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
