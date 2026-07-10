// Capture REAL browser-chrome screenshots (toolbar + Extensions puzzle menu with
// the pin toggle) for the onboarding page. Playwright's page.screenshot only
// grabs page content, so we run a HEADED Chromium on a virtual X display (Xvfb)
// and capture the whole screen with ImageMagick `import`, driving the native
// Extensions menu with xdotool.
//
// Prereqs (started by the caller): Xvfb on $DISPLAY, `import` + `xdotool` on PATH.
//   DISPLAY=:99 node tests/capture_toolbar.mjs [puzzleX puzzleY]
import { chromium } from "playwright";
import { execSync } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = join(HERE, "..", "extension");
const OUT = join(HERE, "screenshots", "toolbar");
execSync(`mkdir -p "${OUT}"`);

const W = 1280, Hgt = 900;
// Extensions puzzle button sits near the top-right of the toolbar. Overridable
// via argv so we can nudge it after eyeballing the first capture.
const PZ_X = parseInt(process.argv[2] || String(W - 158), 10);
const PZ_Y = parseInt(process.argv[3] || "72", 10);

const grab = (name) => {
  // ImageMagick's brew bottle has no X11 delegate, so grab via mss (pure-Python
  // libX11 client) which talks straight to $DISPLAY.
  execSync(`/usr/bin/python3 -c "import mss; mss.MSS().shot(mon=1, output='${join(OUT, name)}')"`, { stdio: "inherit" });
  console.log("grabbed", name);
};
const xdo = (cmd) => execSync(`xdotool ${cmd}`, { stdio: "inherit" });

const profile = mkdtempSync(join(tmpdir(), "minus-headed-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: false,
  viewport: null,
  args: [
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    `--window-size=${W},${Hgt}`,
    "--window-position=0,0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",                 // no GPU in Xvfb; we only need chrome UI
    "--use-gl=disabled",
  ],
});

// Wait for the extension SW, then show a clean page so the toolbar is tidy.
try { ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 30000 }); } catch {}
const page = await ctx.newPage();
await page.goto("about:blank");
await page.waitForTimeout(3500);

xdo(`mousemove ${PZ_X} ${PZ_Y}`);   // hover the puzzle button (shows its tooltip/highlight)
await page.waitForTimeout(800);
grab("01_toolbar_closed.png");

xdo(`mousemove ${PZ_X} ${PZ_Y} click 1`);  // open the Extensions menu
await page.waitForTimeout(1200);
grab("02_menu_open.png");

await ctx.close();
console.log(`\nDone. puzzle click was (${PZ_X},${PZ_Y}). Review ${OUT}/ and re-run with corrected coords if needed.`);
