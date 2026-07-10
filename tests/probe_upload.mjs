import { launchWithExtension } from "./harness.mjs";
const ctx = await launchWithExtension();
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 60000 });
// direct fetch from the SW to the ingest endpoint with a tiny sample
const res = await sw.evaluate(async () => {
  const url = "https://minus-ingest-garage.fly.dev/ingest";
  const key = "bdc2d283edff8b961ddf5f235bd1ebeab6c4f98ca9a5e48a";
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  try {
    const r = await fetch(url, { method: "POST",
      headers: { "Content-Type": "application/json", "x-minus-key": key },
      body: JSON.stringify({ v: 1, samples: [{ key: "probe_sw_" + Date.now(), img: "data:image/png;base64," + png, p_ad: 0.9, verdict: "ad", host: "probe.sw", w: 300, h: 250, engine: "lfm-iter21web" }] }) });
    const t = await r.text();
    return { ok: r.ok, status: r.status, body: t.slice(0, 200) };
  } catch (e) {
    return { error: String(e) };
  }
});
console.log("PROBE_RESULT:", JSON.stringify(res));
await ctx.close();
