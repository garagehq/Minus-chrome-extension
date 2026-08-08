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

console.log(f ? `\n${f} failure(s)` : "\nall green");
process.exit(f ? 1 : 0);
