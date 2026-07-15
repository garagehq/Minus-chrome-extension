// Pure unit tests (no browser) for the options page + flashcard decks:
//  - deck integrity: every language has >=10 cards, every card has w/en/ex,
//    MINUS_LANGS covers exactly the deck keys, es keeps its 20-card deck and
//    the MINUS_SPANISH back-compat alias
//  - options wiring: manifest exposes options_ui, options.html loads the deck
//    file before options.js, popup has the ⚙ options link, background DEFAULTS
//    carry the three block-action keys content.js reads
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) failures++;
};

// Evaluate the decks file the same way the content script consumes it.
const deckSrc = readFileSync(join(EXT, "spanish.js"), "utf8");
const { MINUS_DECKS, MINUS_LANGS, MINUS_SPANISH } =
  new Function(`${deckSrc}; return { MINUS_DECKS, MINUS_LANGS, MINUS_SPANISH };`)();

ok("decks and language labels cover the same keys",
   JSON.stringify(Object.keys(MINUS_DECKS).sort()) === JSON.stringify(Object.keys(MINUS_LANGS).sort()),
   `decks=${Object.keys(MINUS_DECKS)} langs=${Object.keys(MINUS_LANGS)}`);
for (const [lang, deck] of Object.entries(MINUS_DECKS)) {
  ok(`deck ${lang}: >=10 cards`, deck.length >= 10, String(deck.length));
  ok(`deck ${lang}: every card has non-empty w/en/ex`,
     deck.every((c) => c.w?.trim() && c.en?.trim() && c.ex?.trim()));
}
ok("es deck keeps its full 20 cards", MINUS_DECKS.es.length === 20, String(MINUS_DECKS.es.length));
ok("MINUS_SPANISH back-compat alias points at the es deck", MINUS_SPANISH === MINUS_DECKS.es);

// Full 500-card JSON decks (decks/<lang>.json) — the shipped decks.
for (const lang of Object.keys(MINUS_LANGS)) {
  let deck;
  try { deck = JSON.parse(readFileSync(join(EXT, "decks", `${lang}.json`), "utf8")); }
  catch (e) { ok(`decks/${lang}.json parses`, false, String(e).slice(0, 80)); continue; }
  ok(`decks/${lang}.json has exactly 500 cards`, deck.length === 500, String(deck.length));
  ok(`decks/${lang}.json: every card has non-empty w/en/ex`,
     deck.every((c) => c.w?.trim() && c.en?.trim() && c.ex?.trim()));
  ok(`decks/${lang}.json: all words unique`, new Set(deck.map((c) => c.w)).size === deck.length);
  ok(`decks/${lang}.json: built-in starter cards lead the deck`,
     JSON.stringify(deck.slice(0, MINUS_DECKS[lang].length).map((c) => c.w)) ===
     JSON.stringify(MINUS_DECKS[lang].map((c) => c.w)));
}
ok("spanish.js exposes the JSON deck loader", deckSrc.includes("function minusLoadDeck"));

// Options page wiring
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
ok("manifest exposes options_ui.page = options.html", manifest.options_ui?.page === "options.html");
const optionsHtml = readFileSync(join(EXT, "options.html"), "utf8");
ok("options.html loads spanish.js before options.js",
   optionsHtml.indexOf("spanish.js") !== -1 &&
   optionsHtml.indexOf("spanish.js") < optionsHtml.indexOf("options.js"));
for (const id of ["blockLang", "actFlash", "actMinimal", "showConfidence", "disabledSites", "engineKind"]) {
  ok(`options.html has #${id}`, optionsHtml.includes(`id="${id}"`));
}
ok("popup has the options link", readFileSync(join(EXT, "popup.html"), "utf8").includes("optionsLink"));
ok("popup.js opens the options page",
   readFileSync(join(EXT, "popup.js"), "utf8").includes("openOptionsPage"));

// Settings plumbing: background defaults + content.js consumption
const bg = readFileSync(join(EXT, "background.js"), "utf8");
for (const key of ["blockAction", "blockLang", "showConfidence"]) {
  ok(`background DEFAULTS carry ${key}`, new RegExp(`${key}:`).test(bg));
}
const content = readFileSync(join(EXT, "content.js"), "utf8");
ok("content.js reads blockAction from settings", content.includes("resp.settings.blockAction"));
ok("content.js loads the JSON deck on settings + language change", content.includes("loadActiveDeck()"));
const manifestRaw = readFileSync(join(EXT, "manifest.json"), "utf8");
ok("manifest exposes decks/*.json as web-accessible", manifestRaw.includes("decks/*.json"));
ok("content.js re-renders overlays on block-action change", content.includes('"blockAction" in changes'));
ok("content.js minimal card exists", content.includes("This ad has been blocked by minus."));

console.log(failures ? `\n${failures} failure(s)` : "\nall green");
process.exit(failures ? 1 : 0);
