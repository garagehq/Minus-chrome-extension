// E2E: extension loaded, fixture page with one ad + one content image.
// Expect: overlay over the ad image, none over the content image,
// X button reveals the ad.
import { launchWithExtension, serveFixtures, waitForEngine, HERE } from "./harness.mjs";
import { mkdirSync } from "fs";
import { join } from "path";

const server = await serveFixtures();
const ctx = await launchWithExtension();
mkdirSync(join(HERE, "screenshots"), { recursive: true });

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
};

try {
  console.log("waiting for engine (first run downloads the model)...");
  const engine = await waitForEngine(ctx);
  console.log("engine:", JSON.stringify(engine));

  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:8919/", { waitUntil: "load" });

  // overlay over the ad image
  const overlay = page.locator("[data-minus-overlay]");
  await overlay.first().waitFor({ state: "visible", timeout: 120000 });
  // let a couple scan cycles settle (content image must stay uncovered)
  await page.waitForTimeout(8000);

  const count = await overlay.count();
  check("exactly one overlay", count === 1);

  const [adBox, ovBox] = await Promise.all([
    page.locator("#ad-img").boundingBox(),
    overlay.first().boundingBox(),
  ]);
  const covers =
    Math.abs(adBox.x - ovBox.x) < 8 && Math.abs(adBox.y - ovBox.y) < 8 &&
    Math.abs(adBox.width - ovBox.width) < 16 && Math.abs(adBox.height - ovBox.height) < 16;
  check("overlay covers the ad image", covers);

  const spanishVisible = await overlay.locator(".minus-es").isVisible();
  check("overlay shows Spanish flashcard", spanishVisible);

  await page.screenshot({ path: join(HERE, "screenshots", "overlay_basic.png") });

  // X button reveals the ad
  await overlay.first().hover();
  await overlay.locator(".minus-x").click();
  await page.waitForTimeout(3000);
  check("X removes the overlay", (await overlay.count()) === 0);
  await page.waitForTimeout(6000);
  check("allowed ad stays revealed after rescans", (await overlay.count()) === 0);

  await page.screenshot({ path: join(HERE, "screenshots", "overlay_allowed.png") });
} catch (e) {
  console.log("FAIL  (exception)", String(e).split("\n")[0]);
  failures++;
} finally {
  await ctx.close();
  server.close();
}
console.log(failures ? `\n${failures} failure(s)` : "\nall green");
process.exit(failures ? 1 : 0);
