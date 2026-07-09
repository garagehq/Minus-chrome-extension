// Popup/branding regression on the loaded extension. Guards:
//  - charset fix (en-dash renders, no U+FFFD mojibake)
//  - VT323 wordmark loads and is applied
//  - default engine label is Iter 21-web (not the old mislabeled "Iter 14")
//  - the engine dropdown is populated FROM models/index.json (auto-discovery)
import { launchWithExtension } from "./harness.mjs";

const ctx = await launchWithExtension({ requireGpu: false });
let failures = 0;
const check = (name, cond, detail) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); if (!cond) failures++; };

try {
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await page.waitForSelector("#engineKind", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll("#engineKind option").length > 0, { timeout: 20000 });

  const info = await page.evaluate(async () => {
    await document.fonts.ready;
    const idx = await (await fetch(chrome.runtime.getURL("models/index.json"))).json();
    const opts = [...document.querySelectorAll("#engineKind option")];
    return {
      vt323: document.fonts.check("20px VT323"),
      wordmark: getComputedStyle(document.querySelector(".brand .word")).fontFamily,
      thresholdLabel: document.querySelector('label[for="threshold"]').textContent,
      defaultOpt: opts[0]?.textContent || "",
      optionValues: opts.map((o) => o.value),
      indexKeys: idx.models.map((m) => m.key),
      badChar: document.body.innerHTML.includes("�"),
    };
  });

  check("VT323 font loaded", info.vt323 === true, `fonts.check=${info.vt323}`);
  check("wordmark uses VT323", /VT323/.test(info.wordmark), info.wordmark);
  check("charset intact (en-dash, no U+FFFD)", info.thresholdLabel.includes("–") && !info.badChar, info.thresholdLabel);
  check("default engine label is Iter 21-web (not 14)", info.defaultOpt.includes("Iter 21-web") && !info.defaultOpt.includes("Iter 14"), info.defaultOpt);
  check("dropdown options come from index.json", JSON.stringify(info.optionValues) === JSON.stringify(info.indexKeys), JSON.stringify(info.optionValues));
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]);
  failures++;
} finally {
  await ctx.close();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall green");
process.exit(failures ? 1 : 0);
