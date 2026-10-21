import { setTimeout as delay } from "node:timers/promises";

export async function waitForFilm(
  page,
  { timeoutMs = 90000, pollMs = 100 } = {},
) {
  // The page's timers and RAF are deliberately frozen until capture starts.
  // Keep readiness polling on the recorder's real clock, outside that page.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => Boolean(window.swarmFilm?.ready))) return;
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  throw Error("Replay initialization timed out before capture");
}
