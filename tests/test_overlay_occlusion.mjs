// Overlay "yield when covered" regression. Runs the REAL occlusion functions
// extracted from content.js against the REAL overlay.css, and checks the card:
//  - covers the ad when nothing is on top
//  - yields entirely under a full-cover modal (and the modal is clickable)
//  - clips a hole under a partial modal (covered part click-through, rest kept)
//  - restores when the modal closes
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, "..", "extension", "overlay.css"), "utf8");
const content = readFileSync(join(HERE, "..", "extension", "content.js"), "utf8");

// Extract the shipped occlusion functions (topmostAt .. applyOcclusion).
const start = content.indexOf("function topmostAt");
const apply = content.indexOf("function applyOcclusion");
const endClose = content.indexOf("\n  }", apply) + "\n  }".length;
if (start < 0 || apply < 0) throw new Error("could not locate occlusion functions in content.js");
const fnSrc = content.slice(start, endClose).replace(/\n  /g, "\n");

const page = `<!doctype html><html><head><style>${css}
  body { margin:0; height:2000px; }
  #ad { position:absolute; top:100px; left:100px; width:300px; height:200px; background:#c33; z-index:5; }
  .modal { position:fixed; background:#08f; z-index:1000; }
</style></head><body>
  <div id="ad">AD</div>
  <script>${fnSrc}
    const ad = document.getElementById('ad'), r = ad.getBoundingClientRect();
    const card = document.createElement('div');
    card.setAttribute('data-minus-overlay','');
    card.innerHTML = '<div class="minus-es">el anuncio</div>';
    Object.assign(card.style, { top:r.top+'px', left:r.left+'px', width:r.width+'px', height:r.height+'px' });
    document.documentElement.appendChild(card);
    window.tick = () => updateOcclusion(ad, card);
    window.addModal = (id,l,t,w,h) => { const m=document.createElement('div'); m.id=id; m.className='modal'; m.style.cssText=\`left:\${l}px;top:\${t}px;width:\${w}px;height:\${h}px\`; document.body.appendChild(m); };
    window.rmModal = (id) => document.getElementById(id).remove();
    window.state = () => ({ hidden: card.classList.contains('minus-occluded'), clip: card.style.clipPath || '' });
  <\/script>
</body></html>`;

const browser = await chromium.launch({ channel: "chromium", headless: true, args: ["--no-sandbox"] });
const p = await browser.newPage({ viewport: { width: 1000, height: 800 } });
await p.setContent(page);

const topAt = (x, y) => p.evaluate(([x, y]) => {
  const e = document.elementFromPoint(x, y);
  if (!e) return null;
  if (e.closest("[data-minus-overlay]")) return "card";
  return e.id || e.tagName;
}, [x, y]);

let failures = 0;
const check = (name, cond, detail) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!cond) failures++; };

try {
  await p.evaluate(() => tick());
  let s = await p.evaluate(() => state());
  check("nothing on top: covers ad, not hidden, no clip", !s.hidden && s.clip === "" && (await topAt(250, 200)) === "card");

  await p.evaluate(() => addModal("full", 80, 80, 360, 260));
  await p.evaluate(() => tick());
  s = await p.evaluate(() => state());
  check("full cover: card hidden entirely", s.hidden === true);
  check("full cover: modal clickable at ad center", (await topAt(250, 200)) === "full");
  await p.evaluate(() => rmModal("full"));

  await p.evaluate(() => addModal("half", 250, 80, 300, 300));
  await p.evaluate(() => tick());
  s = await p.evaluate(() => state());
  check("partial cover: not hidden, has clip-path", !s.hidden && s.clip.startsWith("path("));
  check("partial cover: covered part shows modal (click-through)", (await topAt(360, 200)) === "half");
  check("partial cover: uncovered part still shows card", (await topAt(150, 200)) === "card");
  await p.evaluate(() => rmModal("half"));

  await p.evaluate(() => tick());
  s = await p.evaluate(() => state());
  check("modal removed: card restored (no hide, no clip)", !s.hidden && s.clip === "" && (await topAt(250, 200)) === "card");
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]);
  failures++;
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall green");
process.exit(failures ? 1 : 0);
