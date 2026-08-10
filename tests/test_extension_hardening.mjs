// Pure unit tests (no browser) for the hardening pass: allowlist matching,
// keyboard command, overlay a11y, disable teardown wiring, rAF gating.
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
let f = 0;
const ok = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${c ? "" : `  — ${d}`}`); if (!c) f++; };

const bg = readFileSync(join(EXT, "background.js"), "utf8");
const content = readFileSync(join(EXT, "content.js"), "utf8");
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
const overlayCss = readFileSync(join(EXT, "overlay.css"), "utf8");

// --- allowlist: subdomain-aware, www-insensitive (exercise the real function) ---
const isDisabled = new Function("host", "disabledSites", `${/const normHost[\s\S]*?^}/m.exec(bg)[0]}\n${/function isDisabled[\s\S]*?^}/m.exec(bg)[0]}\nreturn isDisabled(host, disabledSites);`);
ok("allowlist: exact host matches", isDisabled("example.com", ["example.com"]));
ok("allowlist: www-insensitive", isDisabled("www.example.com", ["example.com"]) && isDisabled("example.com", ["www.example.com"]));
ok("allowlist: subdomain of a disabled domain matches", isDisabled("m.example.com", ["example.com"]));
ok("allowlist: unrelated domain does NOT match", !isDisabled("notexample.com", ["example.com"]));
ok("allowlist: empty list matches nothing", !isDisabled("example.com", []));

// --- keyboard shortcut ---
ok("manifest declares a toggle-blocking command", !!manifest.commands?.["toggle-blocking"]);
ok("background handles the toggle-blocking command", /onCommand[\s\S]{0,200}toggle-blocking[\s\S]{0,200}enabled: !enabled/.test(bg));

// --- content.js correctness/hardening wiring ---
ok("content: onChanged reacts to enabled/disabledSites", /"enabled" in changes \|\| "disabledSites" in changes/.test(content));
ok("content: teardownOverlays clears overlays on disable", /function teardownOverlays\(\)[\s\S]{0,160}overlays\.clear\(\)/.test(content));
ok("content: MutationObserver no longer watches style", !/attributeFilter: \["src", "class", "id", "style"\]/.test(content));
ok("content: scan scheduler coalesces (no unconditional clearTimeout reset)", /function scheduleScan[\s\S]{0,120}if \(scanTimer\) return;/.test(content));
ok("content: messaging routed through sendMsg (context-invalidation safe)", /function sendMsg\(msg\)/.test(content) && /context invalidated\|Extension context/.test(content));
ok("content: rAF loop self-suspends when no overlays", /function trackOverlays\(\)[\s\S]{0,120}overlays\.size === 0[\s\S]{0,60}tracking = false; return;/.test(content));
ok("content: src-less signature disambiguated by DOM path", /function domKey\(el\)/.test(content) && /domKey\(el\)/.test(content.split("function domKey")[1] || ""));

// --- a11y ---
ok("overlay ✕ revealed on keyboard focus", /:focus-within \.minus-x|\.minus-x:focus-visible/.test(overlayCss));
ok("overlay ✕ has an aria-label", /aria-label="Reveal the ad blocked by Minus"/.test(content));
ok("flashcard text is aria-hidden (not read by screen readers)", /class="minus-es" aria-hidden="true"/.test(content));
ok("overlay carries a group role + label", /setAttribute\("role", "group"\)/.test(content) && /Advertisement blocked by Minus/.test(content));
ok("deck strings set via textContent, not innerHTML (xss-safe)", /\.minus-es"\)\.textContent = w/.test(content));

// --- lifetime stat ---
ok("background tallies a lifetime blocked count", /lifetimeBlocked/.test(bg) && /bumpLifetime/.test(bg));


ok("display scan excludes video players (YouTube recovery fix)", /el\.tagName === "VIDEO"[\s\S]{0,220}querySelector\?\.\("video"\)/.test(content));

ok("video sampler treats a black (unreadable) crop as non-ad (DRM/Vevo recovery)", /BLACK_LUMA/.test(content) && /unreadable\.has\(v\)/.test(content));

// Two-tier unreadable thresholds: a DIRECT (trusted) read uses a tight bar
// (BLACK_LUMA/MIN_CROP_STDDEV); the tainted-screenshot (DRM) path uses an
// aggressive bar (SHOT_DARK_LUMA/SHOT_MIN_STD) because a dark screenshot crop is
// a hardware-overlay letterbox we can't actually read.
ok("direct read uses the tight unreadable bar", /direct\.luma < BLACK_LUMA \|\| direct\.std < MIN_CROP_STDDEV/.test(content));
ok("tainted screenshot path uses the aggressive unreadable bar", /luma < SHOT_DARK_LUMA \|\| std < SHOT_MIN_STD/.test(content));
ok("aggressive bar is looser than the tight bar (SHOT_DARK_LUMA > BLACK_LUMA)", (() => {
  const dark = +(content.match(/const SHOT_DARK_LUMA = (\d+)/) || [])[1];
  const black = +(content.match(/const BLACK_LUMA = (\d+)/) || [])[1];
  const sstd = +(content.match(/const SHOT_MIN_STD = (\d+)/) || [])[1];
  const mstd = +(content.match(/const MIN_CROP_STDDEV = (\d+)/) || [])[1];
  return dark > black && sstd > mstd;
})());

// --- timed pause ---
ok("background computes effective-enabled including pause", /!isPaused\(settings\)/.test(bg) && /const isPaused =/.test(bg));
ok("background schedules an auto-resume alarm", /minus-resume/.test(bg));
ok("popup has pause + resume controls", /class="pausebtn"/.test(readFileSync(join(EXT,"popup.html"),"utf8")) && /pausedUntil: Date\.now\(\)/.test(readFileSync(join(EXT,"popup.js"),"utf8")));
ok("content reacts to pausedUntil", /"pausedUntil" in changes/.test(content));

// --- UX-audit fixes (v0.4.5) ---
{
  const css = readFileSync(join(EXT, "overlay.css"), "utf8");
  ok("✕ reveal is faintly visible at rest (not hover-only)", /\.minus-x\s*{[^}]*opacity:\s*0\.\d+/s.test(css));
  ok("⚑ report is faintly visible at rest", /\.minus-report\s*{[^}]*opacity:\s*0\.\d+/s.test(css));
  ok("undo chip styled + fade class", /data-minus-undo/.test(css) && /minus-undo-fading/.test(css));
  ok("content shows an undo chip after ✕ reveal", /showUndoChip/.test(content) && /allowed\.delete\(el\)/.test(content));
  const popupHtml = readFileSync(join(EXT, "popup.html"), "utf8");
  const popupJs = readFileSync(join(EXT, "popup.js"), "utf8");
  ok("popup threshold is a clamped slider with live readout", /type="range" id="threshold"/.test(popupHtml) && /thVal/.test(popupJs));
  ok("popup warns when both ad types are off", /typesWarn/.test(popupHtml) && /updateTypesWarn/.test(popupJs));
  ok("popup gives engine-switch feedback", /new engine loads on the next scan/.test(popupJs));
  ok("popup maps the internal 'cold' state to plain language", /cold/.test(popupJs) && /starts on next scan/.test(popupJs));
  const optHtml = readFileSync(join(EXT, "options.html"), "utf8");
  const optJs = readFileSync(join(EXT, "options.js"), "utf8");
  ok("options has the threshold slider too (popup parity)", /type="range" id="threshold"/.test(optHtml));
  ok("options reset uses an inline armed confirm, not confirm()", /armed/.test(optJs) && !/confirm\("/.test(optJs));
  ok("options has the both-off warning", /typesWarn/.test(optHtml) && /updateTypesWarn/.test(optJs));
  const reviewJs = readFileSync(join(EXT, "review.js"), "utf8");
  ok("review TO-REVIEW stat counts down (not stale)", /queue\.length - idx/.test(reviewJs));
}

// --- popup guard (hijack-click popup/popunder ad tabs) ---
{
  const bg = readFileSync(join(EXT, "background.js"), "utf8");
  ok("background tracks non-link clicks + popup suspects", /nonLinkClickAt/.test(bg) && /popupSuspects/.test(bg) && /minus:nonlink-click/.test(bg));
  ok("suspects are judged by the model at a high gate", /POPUP_GATE = 0\.8/.test(bg) && /minus:popup-verdict/.test(bg));
  ok("same-domain popups (reader re-open trick) are exempt", /regDomain/.test(bg));
  ok("guard is toggleable and honors pause", /blockPopups/.test(bg) && /settings\.blockPopups === false/.test(bg));
  ok("close-tab is user-initiated, never automatic", /minus:close-popup/.test(bg) && !/tabs\.remove\(tab\.id\)/.test(bg));
  ok("content reports non-link clicks only (anchors exempt)", /viaLink/.test(content) && /minus:nonlink-click/.test(content));
  ok("content renders the popup cover with Close/Show choice", /minus:popup-verdict/.test(content) && /Close tab/.test(content) && /Show page/.test(content));
  ok("disable teardown also removes the popup cover", /data-minus-popup.*\?\.remove/.test(content) || /querySelector\("\[data-minus-popup\]"\)\?\.remove/.test(content));
  ok("popup has the popup-guard toggle", /blockPopups/.test(readFileSync(join(EXT, "popup.html"), "utf8")));
}

// --- false-positive reporting ---
ok("background handles a user false-positive report", /minus:report-fp/.test(bg) && /user_fp/.test(bg) || /queuedAt: 0/.test(bg));
ok("content sends a user_fp report with the crop", /minus:report-fp/.test(content) && /verdict: "user_fp"/.test(content));
ok("FP report gated on opt-in (only rendered when collecting)", /collectOptIn[\s\S]{0,80}minus-report/.test(content));

console.log(f ? `\n${f} failure(s)` : "\nall green");
process.exit(f ? 1 : 0);
