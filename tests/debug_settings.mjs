import { launchWithExtension, waitForEngine } from "./harness.mjs";
const ctx = await launchWithExtension();
try {
  await waitForEngine(ctx);
  const [sw] = ctx.serviceWorkers();
  await sw.evaluate(() => chrome.storage.local.set({ collectOptIn: true, ingestUrl: "http://x/", uploadCooldownMs: 4000 }));
  const probe = await sw.evaluate(async () => {
    const out = {};
    try { out.getSettings = await getSettings(); } catch (e) { out.getSettingsErr = String(e); }
    try { out.raw = await chrome.storage.local.get(null); } catch (e) { out.rawErr = String(e); }
    out.swGlobals = { hasGetSettings: typeof getSettings, hasEnsureOffscreen: typeof ensureOffscreen, hasQueueSample: typeof queueSample };
    return out;
  });
  console.log(JSON.stringify(probe, null, 1));
} finally { await ctx.close(); }
