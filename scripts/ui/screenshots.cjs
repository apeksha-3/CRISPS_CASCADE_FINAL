// scripts/ui/screenshots.cjs
// Phase 10: take the dashboard screenshots with Playwright (a dev tool, not a project dependency; the sandbox has it installed).
// Start the server first (PORT=3100 npx tsx server/index.ts), then: node scripts/ui/screenshots.cjs
// Output: docs/screenshots/p10-*.png. It also fails loudly on any page error or console error.

const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3100";
const OUT = "docs/screenshots";
const errors = [];

async function advance(page, ticks) {
  // run fast, stop after `ticks` ticks have arrived
  await page.evaluate(() => { speedU(40); });
  await page.click("#u-play");
  await page.waitForFunction((n) => U.ticks.length >= n || U.finished, ticks, { timeout: 60000 });
  if (await page.evaluate(() => !!U.es && !U.finished)) await page.click("#u-pause");
  await page.waitForTimeout(200);
}

async function shoot(browser, name, width, height, fn) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name}: console ${m.text()}`); });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await fn(page);
  await page.screenshot({ path: `${OUT}/p10-${name}.png`, fullPage: true });
  await ctx.close();
  console.log("saved", `${OUT}/p10-${name}.png`);
}

const toNowcast = async (page, event) => { await page.click('#mode-switch [data-m="nowcast"]'); await page.selectOption("#u-pick", event); };
const layer2 = async (page) => { await page.click("#u-more"); await page.waitForTimeout(150); };

(async () => {
  const browser = await chromium.launch();
  for (const [suffix, w, h] of [["desktop", 1280, 900], ["mobile", 390, 844]]) {
    await shoot(browser, `layer1-rules-${suffix}`, w, h, async (page) => { await page.selectOption("#u-pick", "cascade"); await advance(page, 16); });
    await shoot(browser, `layer1-nowcast-${suffix}`, w, h, async (page) => { await toNowcast(page, "ida-2021"); await advance(page, 62); });
    await shoot(browser, `layer1-nowcast-gate-${suffix}`, w, h, async (page) => { await toNowcast(page, "flood-2023"); await advance(page, 40); });
    await shoot(browser, `layer2-rules-${suffix}`, w, h, async (page) => { await page.selectOption("#u-pick", "rumor"); await advance(page, 18); await layer2(page); });
    await shoot(browser, `layer2-nowcast-${suffix}`, w, h, async (page) => { await toNowcast(page, "flood-2025"); await advance(page, 24); await layer2(page); });
    await shoot(browser, `layer3-rules-${suffix}`, w, h, async (page) => {
      await page.click('#view-switch [data-v="technical"]');
      await page.click('#modes [data-mode="eval"]');
      await page.waitForSelector(".evtable", { timeout: 60000 });
      await page.hover("#eval-table th:nth-child(2)");
      await page.waitForTimeout(200);
    });
    await shoot(browser, `layer3-nowcast-${suffix}`, w, h, async (page) => {
      await toNowcast(page, "ida-2021");
      await advance(page, 62);
      await page.click('#view-switch [data-v="technical"]');
      await page.waitForSelector("#nowcast-tech table");
    });
  }
  await browser.close();
  if (errors.length) { console.error("ERRORS:\n" + errors.join("\n")); process.exit(1); }
  console.log("no page errors");
})();
