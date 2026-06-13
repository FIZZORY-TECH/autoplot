/**
 * P1.2 perf probe — measures requestAnimationFrame throughput while
 * ChartCanvas is rendering 600 bars + grid + axes + last-price guideline.
 *
 * Pass/fail criterion (per A7): >= 50 fps sustained over a 2-second window.
 * The empty-canvas budget for THIS step (no chart-type renderer yet) should
 * easily clear 60 fps; this guards against regressions in P1.3+.
 */

import { test, expect } from "@playwright/test";

test("ChartCanvas hits >= 50 fps with 600 bars + grid + axes", async ({ page }) => {
  await page.goto("/");
  // Give the canvas time to mount + load 600 bars.
  await page.waitForSelector("canvas");
  await page.waitForTimeout(500);

  const fps = await page.evaluate(async () => {
    return await new Promise<number>((resolve) => {
      let frames = 0;
      let firstTs = 0;
      let lastTs = 0;
      const tick = (now: number) => {
        if (!firstTs) firstTs = now;
        lastTs = now;
        frames += 1;
        if (now - firstTs >= 2000) {
          const elapsed = (lastTs - firstTs) / 1000;
          resolve(frames / elapsed);
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });

  console.log(`[P1.2 perf] ${fps.toFixed(1)} fps`);
  // Note: in CI on a slow runner this floor may need to drop. On dev/M1 we
  // should easily hit 60. The A7 escalation threshold is <50.
  expect(fps).toBeGreaterThanOrEqual(50);
});
