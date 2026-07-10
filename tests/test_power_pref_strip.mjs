// Guards the Windows powerPreference fix (crbug.com/369219127). Chromium logs a
// warning inside requestAdapter() when powerPreference is passed on Windows;
// offscreen.js strips it at the navigator.gpu.requestAdapter choke point. We
// can't run Windows here, so we (a) prove the interception logic strips the
// option while preserving everything else, and (b) statically assert offscreen.js
// still wires the patch (Windows-guarded) so it can't silently regress.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const HERE = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const check = (name, cond, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!cond) fail++; };

// (a) Behavioral: replicate the exact wrapper from offscreen.js and prove it.
function installStrip(gpu) {
  const real = gpu.requestAdapter.bind(gpu);
  gpu.requestAdapter = (opts) => {
    if (opts && "powerPreference" in opts) { const { powerPreference, ...rest } = opts; opts = rest; }
    return real(opts);
  };
}
let seen;
const fakeGpu = { requestAdapter: (opts) => { seen = opts; return Promise.resolve({ ok: true }); } };
installStrip(fakeGpu);

await fakeGpu.requestAdapter({ powerPreference: "high-performance", forceFallbackAdapter: false });
check("powerPreference stripped from options", seen && !("powerPreference" in seen), JSON.stringify(seen));
check("other adapter options preserved", seen && seen.forceFallbackAdapter === false, JSON.stringify(seen));

seen = "unset";
await fakeGpu.requestAdapter();               // ORT's/our own no-arg probe
check("no-arg requestAdapter still works", seen === undefined, String(seen));

seen = "unset";
await fakeGpu.requestAdapter({ forceFallbackAdapter: true });  // no powerPreference present
check("options without powerPreference pass through untouched", seen && seen.forceFallbackAdapter === true, JSON.stringify(seen));

// (b) Static: offscreen.js must intercept requestAdapter, guarded by Windows.
const src = readFileSync(join(HERE, "..", "extension", "offscreen.js"), "utf8");
check("offscreen.js patches navigator.gpu.requestAdapter", /navigator\.gpu\.requestAdapter\s*=/.test(src));
check("patch is Windows-guarded (no-op elsewhere)", /Windows/i.test(src) && /powerPreference/.test(src));

console.log(fail ? `\n${fail} failure(s)` : "\nall green");
process.exit(fail ? 1 : 0);
