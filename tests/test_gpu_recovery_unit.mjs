// Pure (no-GPU) guard for the device-loss recovery. The WebGPU integration test
// (test_device_loss_recovery.mjs) needs a free GPU; this one tests the actual
// detector regex + wiring straight from offscreen.js source, so it's
// deterministic and runs in `npm test`.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join } from "path";
const HERE = join(fileURLToPath(import.meta.url), "..");
const src = readFileSync(join(HERE, "..", "extension", "offscreen.js"), "utf8");
let fail = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

// pull the real regex literal out of isFatalGpuError and exercise it
const m = src.match(/function isFatalGpuError\(e\)\s*\{\s*return\s*(\/.+?\/[a-z]*)\.test/s);
ok("isFatalGpuError regex found in source", !!m);
const re = m ? eval(m[1]) : /$^/;

// the EXACT error the user pasted from the extension
const userErr = "An error occurred during model execution: \"Error: failed to call OrtRun(). ERROR_CODE: 1, ERROR_MESSAGE: /mnt/vss/_work/1/s/onnxruntime/core/providers/webgpu/buffer_manager.cc:553 ... Failed to execute 'mapAsync' on 'GPUBuffer': A valid external Instance reference no longer exists.\"";
ok("matches the user's exact device-loss error", re.test(userErr));
for (const s of ["A valid external Instance reference no longer exists", "failed to call OrtRun()", "GPUBuffer mapAsync failed", "WebGPU device is lost", "Device lost: reason destroyed"])
  ok(`matches: ${s.slice(0, 42)}`, re.test(s));
// must NOT nuke the engine on benign / transient errors
for (const s of ["classify error, retrying once", "no available backend found", "Unable to determine content-length", "image decode failed", "network timeout"])
  ok(`does NOT match benign: ${s.slice(0, 40)}`, !re.test(s));

// wiring: the classify handler must reset+rebuild on a fatal error, once per batch
ok("classify handler calls resetEngine() on fatal error", /if \(fatal && !rebuilt\)[\s\S]{0,300}resetEngine\(\)/.test(src));
ok("rebuilds via getEngine after reset", /resetEngine\(\);[\s\S]{0,120}getEngine\(msg\.engineKind\)/.test(src));
ok("resetEngine clears enginePromise + loadedEngineKey", /function resetEngine\(\)[\s\S]{0,220}enginePromise = null[\s\S]{0,120}loadedEngineKey = null/.test(src));
ok("engineInfo reset to cold so status reflects recovery", /function resetEngine\(\)[\s\S]{0,260}engineInfo = \{ state: "cold" \}/.test(src));

console.log(fail ? `\n${fail} failure(s)` : "\ngpu-recovery unit green");
process.exit(fail ? 1 : 0);
