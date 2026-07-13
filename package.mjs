// Build a release zip of the extension.
//
// The archive holds the CONTENTS of extension/ at its ROOT (no wrapper folder),
// so a user unzips it and points "Load unpacked" straight at the unzipped
// folder — no drilling into a nested extension/ subfolder.
//
//   npm run package        -> dist-release/minus-extension-v<version>.zip
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const ext = join(root, "extension");
const { version } = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));

const outDir = join(root, "dist-release");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `minus-extension-v${version}.zip`);
if (existsSync(out)) rmSync(out);

// Releases ship only the DEFAULT engine's weights (lfm -> lfm-iter24). The
// other engine dirs are dev-only; bundling them would many-x the download.
// A trailing "*" (no slash) drops both the dir entry and its contents.
const EXCLUDE = [
  "models/lfm-iter14*",
  "models/lfm-iter20web*",
  "models/lfm-iter21web*",
  "models/lfm-iter22web*",
  "models/lfm-iter23*",
  "models/lfm-iter24*",
  "models/siglip2*",
  "*/.DS_Store",
  ".DS_Store",
];

// `.` = the contents of extension/ (cwd), added at the archive root.
execFileSync("zip", ["-r", "-q", "-X", out, ".", "-x", ...EXCLUDE], { cwd: ext, stdio: "inherit" });

const mb = (statSync(out).size / 1048576).toFixed(0);
console.log(`packaged ${out} (${mb} MB)`);
