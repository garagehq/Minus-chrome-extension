// Generates the onboarding screenshot(s) shipped in extension/onboarding/.
// The popup is real UI we can render; we turn ON the "Contribute anonymous ad
// snapshots" toggle and ring it so users see exactly which control to click.
import { launchWithExtension } from "./harness.mjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "extension", "onboarding");

const ctx = await launchWithExtension({ requireGpu: false });
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 20000 });
const extId = new URL(sw.url()).host;
const p = await ctx.newPage();
await p.setViewportSize({ width: 330, height: 900 });
await p.goto(`chrome-extension://${extId}/popup.html`);
await p.waitForSelector("#collect", { state: "attached" }); // hidden input (toggle-switch UI)
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(400);

// Show the desired end-state (toggle ON) and draw an attention ring + arrow
// around the "Contribute anonymous ad snapshots" row.
await p.evaluate(() => {
  const cb = document.getElementById("collect");
  cb.checked = true;
  const row = cb.closest(".row");
  row.style.position = "relative";
  row.style.outline = "2px solid #ffdd00";
  row.style.outlineOffset = "4px";
  row.style.borderRadius = "3px";
  row.style.boxShadow = "0 0 18px rgba(255,221,0,0.6)";
  // Little "click here" flag pinned to the toggle.
  const flag = document.createElement("div");
  flag.textContent = "◄ turn ON";
  flag.style.cssText = "position:absolute; left:56px; top:50%; transform:translateY(-50%);"
    + "color:#ffdd00; font-family:'VT323',monospace; font-size:15px; letter-spacing:0.04em;"
    + "text-shadow:0 0 8px rgba(255,221,0,0.7); white-space:nowrap; pointer-events:none;";
  row.appendChild(flag);
});
await p.waitForTimeout(300);
// Screenshot just the popup body (not the empty viewport around it).
const body = await p.$("body");
await body.screenshot({ path: join(OUT, "optin.png") });
console.log("wrote", join(OUT, "optin.png"));
await ctx.close();
