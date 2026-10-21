import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { waitForFilm } from "../video/readiness.mjs";

test(
  "delayed replay readiness works while browser timers and RAF are frozen",
  { timeout: 15000 },
  async () => {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage();
      await page.addInitScript(() => {
        window.setTimeout = () => 0;
        window.requestAnimationFrame = () => 0;
      });
      await page.route("http://recorder.test/index.html", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><script>fetch('/data.json').then(r=>r.json()).then(()=>{window.swarmFilm={ready:true}})</script>",
        }),
      );
      await page.route("http://recorder.test/data.json", async (route) => {
        await delay(250);
        await route.fulfill({ contentType: "application/json", body: "{}" });
      });
      await page.goto("http://recorder.test/index.html", {
        waitUntil: "domcontentloaded",
      });
      assert.equal(
        await page.evaluate(() => Boolean(window.swarmFilm?.ready)),
        false,
      );
      await waitForFilm(page, { timeoutMs: 2000 });
      assert.equal(await page.evaluate(() => window.swarmFilm.ready), true);
    } finally {
      await browser.close();
    }
  },
);
