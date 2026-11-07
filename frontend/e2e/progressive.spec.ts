import { expect, test } from '@playwright/test';

const source = process.env.FORMIAI_E2E_VIDEO ?? 'formiai_e2e_long.mp4';

test('progressive analysis renders real boxes, buffers, and finishes in Review', async ({ page }) => {
  const consoleErrors: string[] = [], failedRequests: string[] = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('requestfailed', request => {
    if (request.failure()?.errorText !== 'net::ERR_ABORTED') failedRequests.push(`${request.method()} ${request.url()}`);
  });
  await page.goto('/');
  await page.getByLabel('Video aprobado').selectOption(source);
  await expect(page.getByText('PROGRESSIVE OBSERVATION')).toHaveCount(0); // choosing a video starts nothing
  await page.getByRole('button', { name: 'Analizar video' }).click();
  await expect(page.getByText('PROGRESSIVE OBSERVATION')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('VIDEO ANALIZADO · REVIEW COMPLETO')).toHaveCount(0);
  await expect(page.locator('canvas').first()).toBeVisible();
  await expect.poll(async () => page.getByLabel('Instruments').innerText(), { timeout: 30_000 }).toMatch(/\b[1-9][\d,]* \/ /);
  await page.locator('video').first().evaluate(async element => {
    const video = element as HTMLVideoElement;
    video.currentTime = 0;
    await video.play();
  });
  await expect.poll(async () => page.locator('canvas').first().evaluate(canvas => {
    const context = (canvas as HTMLCanvasElement).getContext('2d');
    return context ? Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data).some(value => value !== 0) : false;
  }), { timeout: 30_000 }).toBe(true);
  // With the video paused, the overlay must belong to exactly the frame the video shows: the canvas
  // records the scientific frame_index it was drawn for, compared with the index derived from the video.
  await page.locator('video').first().evaluate(element => (element as HTMLVideoElement).pause());
  await expect.poll(async () => page.locator('canvas').first().evaluate(canvas => {
    const layer = canvas as HTMLCanvasElement;
    const video = layer.parentElement!.querySelector('video')!;
    const fps = Number(layer.dataset.fps);
    const expected = fps ? String(Math.floor(video.currentTime * fps + 1e-6)) : '';
    return { drawn: layer.dataset.drawn, frame: layer.dataset.frameIndex, expected, matches: layer.dataset.frameIndex === expected };
  }), { timeout: 10_000 }).toMatchObject({ drawn: 'true', matches: true });
  await page.screenshot({ path: 'test-results/progressive-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => page.locator('canvas').first().evaluate(canvas => {
    const video = canvas.parentElement?.querySelector('video');
    return video ? Math.abs(canvas.getBoundingClientRect().width - video.getBoundingClientRect().width) < 1 : false;
  })).toBe(true);
  await page.screenshot({ path: 'test-results/progressive-mobile.png', fullPage: true });
  await expect(page.getByText('VIDEO ANALIZADO · REVIEW COMPLETO')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('EXPORTS DISPONIBLES')).toBeVisible();
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
