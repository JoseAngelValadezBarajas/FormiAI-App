import { expect, test, type Page } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';
import { ensureClip, FPS, FRAMES } from './make-clip';

// Frontend-only synchronisation check. The clip carries each frame's index as a barcode; the mocked
// stream gives frame N a box at x = N * 4 (video pixels). Both identities are read back from PIXELS
// (the presented video frame and the overlay canvas), independently of the app's own bookkeeping.

const clip = ensureClip();
const size = statSync(clip).size;
const unexpected: string[] = [];
const posted: unknown[] = [];
const cancels: string[] = [];
const modelList = { default: 'V2-E2', models: [
  { id: 'V2-E2', label: 'V2-E2 · Experimental', experimental: true, available: true, reason: '', confidence: 0.5 },
  { id: 'OD-E2-N', label: 'OD-E2-N', experimental: false, available: true, reason: '', confidence: 0.25 },
] };

async function setup(page: Page, options: { batches: number; withoutVideoFrameCallback?: boolean; fail?: string; model?: string; autoStart?: boolean }) {
  await page.addInitScript(({ batches, fps, frames, without, fail }) => {
    if (without) delete (HTMLVideoElement.prototype as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback;
    class FakeSource {
      listeners: Record<string, ((event: MessageEvent) => void)[]> = {};
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        setTimeout(() => {
          this.onopen?.();
          const send = (type: string, payload: unknown) => (this.listeners[type] ?? []).forEach(f => f(new MessageEvent(type, { data: JSON.stringify(payload) })));
          send('progress', { fps, frame_count: frames, processed_through_frame: batches * 10 - 1, batch_count: batches });
          if (fail) { send('error', { message: fail }); return; }
          for (let sequence = 1; sequence <= batches; sequence++) {
            send('detections', {
              sequence, fps, frame_count: frames, processed_through_frame: sequence * 10 - 1,
              frames: Array.from({ length: 10 }, (_, k) => {
                const index = (sequence - 1) * 10 + k;
                return { frame_index: index, timestamp_seconds: index / fps, detections: [{ bbox: [index * 4, 100, index * 4 + 24, 140], confidence: 0.9, track_id: 1 }] };
              }),
            });
          }
        }, 50);
      }
      addEventListener(type: string, listener: (event: MessageEvent) => void) { (this.listeners[type] ??= []).push(listener); }
      close() {}
    }
    const sources: FakeSource[] = [];
    (window as unknown as { __emit: (type: string, payload: unknown) => void }).__emit = (type, payload) =>
      sources.forEach(source => (source.listeners[type] ?? []).forEach(f => f(new MessageEvent(type, { data: JSON.stringify(payload) }))));
    (window as unknown as { EventSource: unknown }).EventSource = class extends FakeSource { constructor() { super(); sources.push(this); } };
  }, { batches: options.batches, fps: FPS, frames: FRAMES, without: options.withoutVideoFrameCallback ?? false, fail: options.fail ?? '' });

  unexpected.length = 0;
  posted.length = 0;
  cancels.length = 0;
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/input-videos') return json({ videos: ['sync.mp4'] });
    if (url.pathname === '/api/models') return json(modelList);
    if (url.pathname === '/api/jobs' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      posted.push(body);
      const chosen = modelList.models.find(item => item.id === body.model);
      return json({ model: chosen, id: 'sync-job', status: 'processing', source_name: 'sync.mp4', message: '', source_video_url: '/fixtures/sync.mp4',
        progress: { fps: FPS, frame_count: FRAMES, processed_through_frame: -1, batch_count: 0 } });
    }
    if (url.pathname === '/api/input-videos/sync.mp4/video') return route.fallback();
    if (url.pathname === '/api/jobs/sync-job/cancel' && route.request().method() === 'POST') { cancels.push(url.pathname); return json({ id: 'sync-job', status: 'cancelled', source_name: 'sync.mp4', message: '', progress: {} }); }
    if (url.pathname.startsWith('/api/sessions/')) return json({ detail: 'not available in the sync harness' }, 404);
    unexpected.push(`${route.request().method()} ${url.pathname}`);
    return route.abort();
  });
  await page.route(/\/(fixtures\/sync\.mp4|api\/input-videos\/sync\.mp4\/video)$/, route => {
    const range = /bytes=(\d*)-(\d*)/.exec(route.request().headers().range ?? '');
    const bytes = readFileSync(clip);
    if (!range) return route.fulfill({ status: 200, contentType: 'video/mp4', headers: { 'Accept-Ranges': 'bytes' }, body: bytes });
    const start = Number(range[1] || 0);
    const end = Math.min(Number(range[2] || size - 1), size - 1);
    return route.fulfill({
      status: 206, contentType: 'video/mp4',
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}` },
      body: bytes.subarray(start, end + 1),
    });
  });
  await page.goto('/');
  await page.getByLabel('Video aprobado').selectOption('sync.mp4');
  if (options.model) await page.getByLabel('Modelo').selectOption(options.model);
  // Choosing a video only shows it; nothing is analysed until the button is pressed.
  await expect(page.getByLabel('Ready to analyze')).toBeVisible();
  expect(posted).toEqual([]);
  await page.getByRole('button', { name: 'Analizar video' }).click();
  await expect(page.getByLabel('Progressive observation')).toBeVisible();
  await page.waitForFunction(() => document.querySelector('video')?.readyState === 4);
  // Every mocked batch must have reached the client before any frame is checked.
  await expect(page.getByLabel('Instruments')).toContainText(`${new Intl.NumberFormat('en-US').format(options.batches * 10)} / ${FRAMES}`);
  await page.evaluate(() => {
    const video = document.querySelector('video')!;
    const overlay = document.querySelector('canvas')!;
    const scratch = document.createElement('canvas');
    const w = window as unknown as { __id: () => { video: number; overlay: number; dataset: string; drawn: string; time: number } };
    w.__id = () => {
      scratch.width = video.videoWidth; scratch.height = video.videoHeight;
      const c = scratch.getContext('2d', { willReadFrequently: true })!;
      c.drawImage(video, 0, 0);
      let videoId = 0;
      for (let b = 0; b < 10; b++) if (c.getImageData(b * 16 + 8, 8, 1, 1).data[0] > 128) videoId |= 1 << b;
      // Overlay: leftmost painted column, mapped back through the object-fit: contain geometry.
      const o = overlay.getContext('2d', { willReadFrequently: true })!;
      const data = o.getImageData(0, 0, overlay.width, overlay.height).data;
      let left = -1;
      for (let x = 0; x < overlay.width && left < 0; x++) {
        for (let y = 0; y < overlay.height; y++) if (data[(y * overlay.width + x) * 4 + 3] > 0) { left = x; break; }
      }
      let overlayId = -1;
      if (left >= 0) {
        const rect = video.getBoundingClientRect();
        const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
        const offset = (rect.width - video.videoWidth * scale) / 2;
        const cssX = left / (overlay.width / rect.width) + 0.8;
        overlayId = Math.round((cssX - offset) / scale / 4) + 0;
      }
      return { video: videoId, overlay: overlayId, dataset: overlay.dataset.frameIndex ?? '', drawn: overlay.dataset.drawn ?? '', time: video.currentTime };
    };
  });
}

type Sample = { video: number; overlay: number; dataset: string; drawn: string; time: number; media: number };

async function sampleDuringPlayback(page: Page, milliseconds: number) {
  return page.evaluate(async ms => {
    const video = document.querySelector('video')!;
    const w = window as unknown as { __id: () => Sample };
    const samples: Sample[] = [];
    // Registered after the app's own callback, so it runs after the app drew for the same presented frame.
    const tick = (_: number, meta: VideoFrameCallbackMetadata) => { samples.push({ ...w.__id(), media: meta.mediaTime }); handle = video.requestVideoFrameCallback(tick); };
    let handle = video.requestVideoFrameCallback(tick);
    video.currentTime = 0;
    await video.play();
    await new Promise(resolve => setTimeout(resolve, ms));
    video.pause();
    video.cancelVideoFrameCallback(handle);
    return samples;
  }, milliseconds);
}

async function settled(page: Page) {
  // Two animation frames plus a short wait lets seeked/timeupdate/frame callbacks finish.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)))));
  return page.evaluate(() => (window as unknown as { __id: () => Sample }).__id());
}

test.afterEach(() => expect(unexpected, 'requests that no mock answered').toEqual([]));

test('with requestVideoFrameCallback the overlay is the presented frame during playback', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await setup(page, { batches: 12 });
  const samples = await sampleDuringPlayback(page, 3000);
  expect(samples.length).toBeGreaterThan(40);
  const mismatched = samples.filter(sample => sample.overlay !== sample.video);
  console.log(`rVFC playback: ${samples.length} presented frames, ${mismatched.length} overlay mismatches`);
  expect(mismatched, JSON.stringify(mismatched.slice(0, 5))).toEqual([]);
  // The presented frame's own identity must also agree with its media timestamp (pts = n / fps).
  samples.forEach(sample => expect(sample.video).toBe(Math.round(sample.media * FPS)));
  expect(errors).toEqual([]);
});

test('paused and seeking land on the exact frame, including between frames', async ({ page }) => {
  await setup(page, { batches: 12 });
  const seek = (time: number) => page.evaluate(t => new Promise<void>(resolve => {
    const video = document.querySelector('video')!;
    video.addEventListener('seeked', () => resolve(), { once: true });
    video.currentTime = t;
  }), time);
  // Frame centres are unambiguous: the displayed frame must be exactly n and the overlay must match it.
  for (const expected of [0, 17, 41, 63, 5, 100, 119]) {
    await seek((expected + 0.5) / FPS);
    const now = await settled(page);
    expect(now, `seek to frame centre ${expected}`).toMatchObject({ video: expected, overlay: expected, dataset: String(expected), drawn: 'true' });
  }
  // Exact frame boundaries: the browser may present frame n or n-1 (its own rounding of the target), but
  // the overlay must always belong to whichever frame is actually on screen.
  for (const boundary of [17, 100, 119]) {
    await seek(boundary / FPS);
    const now = await settled(page);
    expect([boundary - 1, boundary], `boundary ${boundary}`).toContain(now.video);
    expect(now, `boundary ${boundary}`).toMatchObject({ overlay: now.video, dataset: String(now.video), drawn: 'true' });
  }
  // Arrow keys on the timeline step exactly one frame.
  await seek(30 / FPS);
  await settled(page);
  await page.getByRole('slider').focus();
  await page.keyboard.press('ArrowRight');
  expect(await settled(page)).toMatchObject({ video: 31, overlay: 31 });
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  expect(await settled(page)).toMatchObject({ video: 29, overlay: 29 });
  // Pausing after playback leaves the overlay on the frame that is on screen.
  await sampleDuringPlayback(page, 700);
  const stopped = await settled(page);
  expect(stopped.overlay).toBe(stopped.video);
});

test('playback stops at the last locally received frame and draws nothing beyond it', async ({ page }) => {
  await setup(page, { batches: 4 }); // frames 0..39 received
  const samples = await sampleDuringPlayback(page, 3000);
  expect(samples.length).toBeGreaterThan(10);
  expect(Math.max(...samples.map(sample => sample.video))).toBeLessThanOrEqual(40);
  samples.filter(sample => sample.video <= 39).forEach(sample => expect(sample.overlay).toBe(sample.video));
  const paused = await page.evaluate(() => document.querySelector('video')!.paused);
  expect(paused).toBe(true);
});

test('fallback without requestVideoFrameCallback: pause and seek are exact, playback lag is measured', async ({ page }) => {
  await setup(page, { batches: 12, withoutVideoFrameCallback: true });
  expect(await page.evaluate(() => typeof document.querySelector('video')!.requestVideoFrameCallback)).toBe('undefined');
  // No frame callback exists, so sample on a timer to measure how far the overlay lags the video.
  const lag = await page.evaluate(async () => {
    const video = document.querySelector('video')!;
    const w = window as unknown as { __id: () => Sample };
    const diffs: number[] = [];
    video.currentTime = 0;
    await video.play();
    const started = performance.now();
    while (performance.now() - started < 3000) {
      await new Promise(resolve => setTimeout(resolve, 16));
      const now = w.__id();
      if (now.overlay >= 0) diffs.push(Math.abs(now.video - now.overlay));
    }
    video.pause();
    return diffs;
  });
  const worst = Math.max(...lag);
  const exact = lag.filter(value => value === 0).length;
  console.log(`fallback playback: ${lag.length} samples, ${exact} exact, worst lag ${worst} frames`);
  test.info().annotations.push({ type: 'fallback-lag', description: `${lag.length} samples, ${exact} exact, worst ${worst} frames` });
  const settledNow = await settled(page);
  expect(settledNow.overlay).toBe(settledNow.video);
  await page.evaluate(() => new Promise<void>(resolve => {
    const video = document.querySelector('video')!;
    video.addEventListener('seeked', () => resolve(), { once: true });
    video.currentTime = 77.5 / 24;
  }));
  expect(await settled(page)).toMatchObject({ video: 77, overlay: 77 });
});

test('choosing a video starts nothing; the button starts it with V2-E2 (experimental) by default', async ({ page }) => {
  await setup(page, { batches: 1 });
  const selector = page.getByLabel('Modelo');
  await expect(selector).toHaveValue('V2-E2');
  await expect(selector.locator('option')).toHaveText(['V2-E2 · Experimental', 'OD-E2-N']);
  expect(posted).toEqual([{ source_name: 'sync.mp4', model: 'V2-E2' }]);
  await expect(page.getByText('MODEL · V2-E2 · conf 0.50').first()).toBeVisible();
  await expect(page.getByText('EXPERIMENTAL', { exact: true }).first()).toBeVisible();
});

test('OD-E2-N can be chosen: the next run sends it without the experimental label', async ({ page }) => {
  await setup(page, { batches: 1, model: 'OD-E2-N' });
  expect(posted).toEqual([{ source_name: 'sync.mp4', model: 'OD-E2-N' }]);
  await expect(page.getByText('MODEL · OD-E2-N · conf 0.25').first()).toBeVisible();
  await expect(page.getByText('EXPERIMENTAL', { exact: true })).toHaveCount(0);
});

test('a failed analysis is shown as failed, stops reconnecting and can be closed', async ({ page }) => {
  await setup(page, { batches: 0, fail: 'uv could not build formicai' });
  await expect(page.getByRole('alert', { name: 'Analysis failed' })).toContainText('The analysis stopped');
  await expect(page.getByText('● FAILED')).toBeVisible();
  await expect(page.getByText('● RECONNECTING')).toHaveCount(0);
  await page.getByText('Details').click();
  await expect(page.getByText('uv could not build formicai')).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar' }).click();
  await expect(page.getByLabel('Ready to analyze')).toBeVisible();
});

test('while analysing the dropdowns are disabled until the analysis is stopped', async ({ page }) => {
  await setup(page, { batches: 2 });
  await expect(page.getByLabel('Video aprobado')).toBeDisabled();
  await expect(page.getByLabel('Modelo')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Nueva observación' })).toBeDisabled();
  await page.getByRole('button', { name: 'Detener análisis' }).click();
  await expect.poll(() => cancels).toEqual(['/api/jobs/sync-job/cancel']);
  // Stopping is only requested; the screen waits for the server to confirm it.
  await expect(page.getByRole('button', { name: 'Deteniendo…' })).toBeDisabled();
  await expect(page.getByLabel('Video aprobado')).toBeDisabled();
  await page.evaluate(() => (window as unknown as { __emit: (t: string, p: unknown) => void }).__emit('cancelled', { id: 'sync-job', status: 'cancelled' }));
  await expect(page.getByRole('status', { name: 'Analysis cancelled' })).toContainText('not saved as a session');
  await expect(page.getByText('● CANCELLED')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Detener análisis' })).toHaveCount(0);
  await expect(page.getByLabel('Video aprobado')).toBeEnabled();
  await expect(page.getByLabel('Modelo')).toBeEnabled();
  await page.getByRole('button', { name: 'Cerrar' }).click();
  await expect(page.getByLabel('Ready to analyze')).toBeVisible();
});

test('a failed analysis also re-enables the dropdowns', async ({ page }) => {
  await setup(page, { batches: 0, fail: 'boom' });
  await expect(page.getByRole('alert', { name: 'Analysis failed' })).toBeVisible();
  await expect(page.getByLabel('Video aprobado')).toBeEnabled();
  await expect(page.getByLabel('Modelo')).toBeEnabled();
});
