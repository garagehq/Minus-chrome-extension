// E2E: opt-in snapshot collection. With opt-in ON and a local ingest server:
// blocked ad -> sample queued -> (cool-down elapses) -> uploaded with
// hostname-only metadata. And: X-click retracts before upload.
import { launchWithExtension, serveFixtures, waitForEngine, HERE } from "./harness.mjs";
import { createServer } from "http";
import { join } from "path";
import { mkdirSync } from "fs";

// local ingest sink
const received = [];
const ingest = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try { received.push(...JSON.parse(body).samples); } catch {}
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((r) => ingest.listen(8791, r));

const server = await serveFixtures();
const ctx = await launchWithExtension();
mkdirSync(join(HERE, "screenshots"), { recursive: true });

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
};

try {
  await waitForEngine(ctx);
  let [sw] = ctx.serviceWorkers();

  // opt in + short cool-down for the test
  await sw.evaluate(() => chrome.storage.local.set({
    collectOptIn: true,
    ingestUrl: "http://127.0.0.1:8791/ingest",
    uploadCooldownMs: 4000,
  }));

  const stored = await sw.evaluate(() => chrome.storage.local.get(null));
  console.log("storage after set:", JSON.stringify(stored));

  // --- case 1: blocked ad gets queued and uploaded after cool-down
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.text().includes("minus")) console.log("[page]", m.text().slice(0, 160)); });
  await page.goto("http://127.0.0.1:8919/", { waitUntil: "load" });
  await page.locator("[data-minus-overlay]").first().waitFor({ state: "visible", timeout: 120000 });

  const queued = await sw.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("minus-samples", 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onupgradeneeded = () => r.result.createObjectStore("queue", { keyPath: "key" });
    });
    return new Promise((res) => {
      const rq = db.transaction("queue", "readonly").objectStore("queue").getAll();
      rq.onsuccess = () => res(rq.result.length);
    });
  });
  check("sample queued after block", queued >= 1);

  await page.waitForTimeout(4500); // cool-down passes
  await sw.evaluate(() => uploadDueSamples()); // direct call: SW can't self-message
  await page.waitForTimeout(500);
  check("sample uploaded after cool-down", received.length >= 1);
  const s = received[0];
  check("payload has crop image", typeof s?.img === "string" && s.img.startsWith("data:image/png"));
  check("payload host is hostname only", s?.host === "127.0.0.1");
  check("payload has confidence + size", typeof s?.p_ad === "number" && s?.w > 0 && s?.h > 0);
  await page.close();

  // --- case 2: X-click retracts before upload
  received.length = 0;
  const page2 = await ctx.newPage();
  await page2.goto("http://127.0.0.1:8919/", { waitUntil: "load" });
  const overlay = page2.locator("[data-minus-overlay]").first();
  await overlay.waitFor({ state: "visible", timeout: 120000 });
  await overlay.hover();
  await page2.locator(".minus-x").click(); // retract within cool-down
  await page2.waitForTimeout(4500);
  await sw.evaluate(() => uploadDueSamples());
  await page2.waitForTimeout(500);
  check("X-click retracts sample (nothing uploaded)", received.length === 0);
  await page2.close();
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]);
  failures++;
} finally {
  await ctx.close();
  server.close();
  ingest.close();
}
console.log(failures ? `\n${failures} failure(s)` : "\nall green");
process.exit(failures ? 1 : 0);
