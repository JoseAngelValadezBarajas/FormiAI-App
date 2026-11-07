import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';
import { ensureClip, FPS, FRAMES } from './make-clip';

// Frontend-only: a faithful in-memory stand-in for the annotation API (the real contract is covered by the
// backend tests) serves the synthetic barcode clip. No backend, no Ants-2, no analysis is involved.
// Frame N has model box A at x = 4N (identity) and a fixed, uncertain box B.

test.use({ viewport: { width: 1440, height: 1000 } });
const clip = ensureClip();
const size = statSync(clip).size;
const WIDTH = 640, HEIGHT = 360;
type Box = [number, number, number, number];
const boxA = (n: number): Box => [n * 4, 100, n * 4 + 40, 140];
const BOX_B: Box = [300, 200, 360, 250];

type Annotation = { id: string; frame_index: number; kind: string; target: { bbox: Box; confidence: number; track_id: number } | null; bbox: Box | null };
type Api = { requests: string[]; bodies: Record<string, unknown>[]; annotations: Annotation[]; complete: Set<number>; exports: unknown[] };

const source = (verified: boolean) => ({ name: 'sync.mp4', sha256: 'a'.repeat(64), width: WIDTH, height: HEIGHT, fps: FPS, frame_count: FRAMES, verified });
const model = { id: 'V2-E2', label: 'V2-E2 · Experimental', experimental: true, confidence: 0.5 };
const listing = [
  { id: 's1', status: 'ready', reviewable: true, source: source(true), model, frame_count: FRAMES, counts: { confirm: 3, reject: 1, adjust: 0, add: 2 }, complete_frames: 12, last_export: { export_id: 'v0003', created_at: 'x' }, last_activity: '2026-11-06T10:00:00Z' },
  { id: 's2', status: 'ready', reviewable: true, source: { ...source(false), name: 'moved.mp4' }, model, frame_count: FRAMES, counts: { confirm: 1, reject: 0, adjust: 0, add: 0 }, complete_frames: 0, last_export: null, last_activity: '2026-11-05T10:00:00Z' },
  { id: 's3', status: 'ready', reviewable: false, reason: 'No analysis artifact' },
  { id: 's4', status: 'ready', reviewable: true, source: { ...source(true), name: 'fresh.mp4' }, model: { id: 'OD-E2-N', label: 'OD-E2-N', experimental: false, confidence: 0.25 }, frame_count: FRAMES, counts: { confirm: 0, reject: 0, adjust: 0, add: 0 }, complete_frames: 0, last_export: null, last_activity: null },
];

async function installApi(page: Page, options: { verified?: boolean } = {}): Promise<Api> {
  const api: Api = { requests: [], bodies: [], annotations: [], complete: new Set(), exports: [] };
  let counter = 0;
  const frames = Array.from({ length: FRAMES }, (_, n) => [[...boxA(n), 0.9, 1], [...BOX_B, 0.55, 2]]);
  const json = (route: import('@playwright/test').Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const same = (a: Box, b: Box) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname, method = request.method();
    api.requests.push(`${method} ${path}`);
    if (method !== 'GET' && request.postData()) api.bodies.push(request.postDataJSON());
    if (path === '/api/input-videos') return json(route, { videos: [] });
    if (path === '/api/models') return json(route, { default: 'V2-E2', models: [] });
    if (path === '/api/annotation/sessions') return json(route, { sessions: listing });
    if (path === '/api/sessions/va-001-031026-1') {
      return json(route, { id: 's1', summary: { duration_seconds: 5, mean_visible_ants: 2 }, timeline: [{ timestamp_seconds: 0, visible_ants: 2, activity_index: 0 }],
        occupancy: { grid_width: 1, grid_height: 1 }, provenance: {}, exports: [] });
    }
    if (path === '/api/sessions/s1/source-video') {
      const range = /bytes=(\d*)-(\d*)/.exec(request.headers().range ?? '');
      const bytes = readFileSync(clip);
      if (!range) return route.fulfill({ status: 200, contentType: 'video/mp4', headers: { 'Accept-Ranges': 'bytes' }, body: bytes });
      const start = Number(range[1] || 0), end = Math.min(Number(range[2] || size - 1), size - 1);
      return route.fulfill({ status: 206, contentType: 'video/mp4', headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}` }, body: bytes.subarray(start, end + 1) });
    }
    if (path === '/api/sessions/s1/review') {
      return json(route, { source: source(options.verified ?? true), confidence_floor: 0.5, detector: {}, analysis_sha256: 'b'.repeat(64), model, frames });
    }
    if (path === '/api/sessions/s1/review/state') return json(route, { annotations: api.annotations, complete_frames: [...api.complete].sort((a, b) => a - b) });
    if (path === '/api/sessions/s1/review/queue') {
      const strategy = url.searchParams.get('strategy');
      const picks = strategy === 'coverage' ? [15, 45, 75, 105] : [8, 30, 90];
      return json(route, { strategy, frames: picks.filter(i => !api.complete.has(i)).map(frame_index => ({ frame_index, reason: strategy, score: strategy === 'coverage' ? 0 : 0.42 })) });
    }
    if (path === '/api/sessions/s1/corrections' && method === 'POST') {
      const body = request.postDataJSON();
      const frame = frames[body.frame_index];
      const observation = body.target ? frame.find(o => same(o.slice(0, 4) as Box, body.target.bbox)) : undefined;
      if (body.kind !== 'add' && !observation) return json(route, { detail: 'target does not match any box the analysis produced for this frame' }, 422);
      if (body.bbox && (body.bbox[0] < 0 || body.bbox[2] > WIDTH || body.bbox[1] < 0 || body.bbox[3] > HEIGHT)) return json(route, { detail: 'bbox must lie inside the video frame' }, 422);
      const target = observation ? { bbox: observation.slice(0, 4) as Box, confidence: observation[4] as number, track_id: observation[5] as number } : null;
      api.annotations = api.annotations.filter(a => !(target && a.target && same(a.target.bbox, target.bbox) && a.frame_index === body.frame_index));
      const made: Annotation = { id: `ann${++counter}`, frame_index: body.frame_index, kind: body.kind, target, bbox: body.bbox ?? null };
      api.annotations.push(made);
      return json(route, made, 201);
    }
    const one = /^\/api\/sessions\/s1\/corrections\/(\w+)(\/restore)?$/.exec(path);
    if (one) {
      const found = api.annotations.find(a => a.id === one[1]);
      if (method === 'PATCH' && found) { found.bbox = request.postDataJSON().bbox; return json(route, found); }
      if (method === 'DELETE' && found) { api.annotations = api.annotations.filter(a => a !== found); return json(route, { deleted: found.id }); }
    }
    const complete = /^\/api\/sessions\/s1\/review\/frames\/(\d+)\/complete$/.exec(path);
    if (complete && method === 'PUT') {
      const value = request.postDataJSON().complete;
      if (value) api.complete.add(Number(complete[1])); else api.complete.delete(Number(complete[1]));
      return json(route, { frame_index: Number(complete[1]), complete: value });
    }
    if (path === '/api/sessions/s1/exports' && method === 'GET') return json(route, { exports: api.exports });
    if (path === '/api/sessions/s1/exports' && method === 'POST') {
      const manifest = { export_id: `v000${api.exports.length + 1}`, created_at: 'now', counts: { annotations: api.annotations.length, complete_frames: api.complete.size },
        files: { 'annotations.jsonl': { sha256: 'c'.repeat(64), bytes: 1 }, 'frames.jsonl': { sha256: 'd'.repeat(64), bytes: 1 } } };
      api.exports.push(manifest);
      return json(route, manifest, 201);
    }
    return route.abort();
  });
  return api;
}

const CANVAS = 'canvas[aria-label="Cajas de detección editables"]';
const canvasEl = (page: Page) => page.locator(CANVAS);

async function open(page: Page, options: { verified?: boolean } = {}) {
  const api = await installApi(page, options);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#/anotacion/s1');
  await expect(page.getByLabel('Espacio de anotación')).toBeVisible();
  try {
    await page.waitForFunction(selector => document.querySelector<HTMLCanvasElement>(selector)?.dataset.ready === 'true', CANVAS, { timeout: 8000 });
  } catch (error) {
    const state = await page.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>('[data-testid="stage"] video');
      const c = document.querySelector<HTMLCanvasElement>('[data-testid="stage"] canvas');
      return JSON.stringify({ video: v && { readyState: v.readyState, error: v.error?.message, time: v.currentTime, src: v.currentSrc }, dataset: c?.dataset, text: document.body.innerText.slice(0, 300) });
    });
    throw new Error(`workspace never became ready: ${state} | page errors: ${errors.join(' || ')} | requests: ${api.requests.join(' ; ')} | ${error}`);
  }
  return api;
}

const videoEl = (page: Page) => page.locator('[data-testid="stage"] video');
/** Where a source-video box sits on the page. The video element is placed by the same projection the overlay uses. */
async function client(page: Page, box: Box) {
  return page.evaluate(([b]) => {
    const video = document.querySelector<HTMLVideoElement>('[data-testid="stage"] video')!;
    const r = video.getBoundingClientRect();
    const scale = r.width / video.videoWidth;
    return { x1: r.left + b[0] * scale, y1: r.top + b[1] * scale, x2: r.left + b[2] * scale, y2: r.top + b[3] * scale, scale };
  }, [box] as [Box]);
}
async function dragBox(page: Page, box: Box, dx: number, dy: number) {
  const r = await client(page, box);
  const cx = (r.x1 + r.x2) / 2, cy = (r.y1 + r.y2) / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx / 2, cy + dy / 2, { steps: 4 });
  await page.mouse.move(cx + dx, cy + dy, { steps: 4 });
  await page.mouse.up();
}
async function clickBox(page: Page, box: Box) {
  const r = await client(page, box);
  await page.mouse.click((r.x1 + r.x2) / 2, (r.y1 + r.y2) / 2);
}
async function frameState(page: Page) {
  return page.evaluate(selector => {
    const video = document.querySelector<HTMLVideoElement>('[data-testid="stage"] video')!;
    const overlay = document.querySelector<HTMLCanvasElement>(selector)!;
    const scratch = document.createElement('canvas');
    scratch.width = video.videoWidth; scratch.height = video.videoHeight;
    const c = scratch.getContext('2d', { willReadFrequently: true })!;
    c.drawImage(video, 0, 0);
    let shownByVideo = 0;
    for (let b = 0; b < 10; b++) if (c.getImageData(b * 16 + 8, 8, 1, 1).data[0] > 128) shownByVideo |= 1 << b;
    // Overlay identity from pixels: leftmost painted column inside box A's row band (labels sit above it).
    const vr = video.getBoundingClientRect(), cr = overlay.getBoundingClientRect();
    const scale = vr.width / video.videoWidth;
    const ratio = overlay.width / cr.width;
    const data = overlay.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, overlay.width, overlay.height).data;
    const top = Math.max(0, Math.floor((vr.top - cr.top + 108 * scale) * ratio)), bottom = Math.min(overlay.height, Math.floor((vr.top - cr.top + 132 * scale) * ratio));
    let left = -1;
    for (let x = 0; x < overlay.width && left < 0; x++) {
      for (let y = top; y < bottom; y++) if (data[(y * overlay.width + x) * 4 + 3] > 0) { left = x; break; }
    }
    const byOverlay = left < 0 ? -1 : Math.round((((left / ratio) + cr.left - vr.left + 0.8) / scale) / 4) + 0;
    return { video: shownByVideo, overlay: byOverlay, dataset: overlay.dataset.frame, ready: overlay.dataset.ready };
  }, CANVAS);
}
async function settled(page: Page, frame: number) {
  await page.waitForFunction(([selector, n]) => document.querySelector<HTMLCanvasElement>(selector as string)?.dataset.frame === String(n)
    && document.querySelector<HTMLCanvasElement>(selector as string)?.dataset.ready === 'true', [CANVAS, frame]);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
/** Types a frame into "Ir al frame", commits it and leaves the field, so the global shortcuts apply again. */
async function toFrame(page: Page, frame: number) {
  const input = page.getByLabel('Ir al frame');
  await input.fill(String(frame));
  await input.press('Enter');
  await input.blur();
  await settled(page, frame);
}
const writes = (api: Api) => api.requests.filter(r => !r.startsWith('GET'));
const zoomOf = async (page: Page) => Number(await canvasEl(page).getAttribute('data-zoom'));
const paintedPixels = (locator: Locator) => locator.evaluate((canvas: HTMLCanvasElement) => {
  const data = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height).data;
  let painted = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
  return painted;
});

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }); });

test('the overlay always belongs to the frame the video really shows', async ({ page }) => {
  await open(page);
  for (const target of [1, 11, 12, 59, 100, 119, 3, 0]) {
    await toFrame(page, target);
    expect(await frameState(page), `frame ${target}`).toMatchObject({ video: target, overlay: target, dataset: String(target), ready: 'true' });
  }
  await page.getByRole('button', { name: 'Avanzar 10 frames' }).click();
  await settled(page, 10);
  expect(await frameState(page)).toMatchObject({ video: 10, overlay: 10 });
  await page.getByRole('button', { name: 'Frame anterior' }).click();
  await settled(page, 9);
  expect(await frameState(page)).toMatchObject({ video: 9, overlay: 9 });
  // Keyboard stepping, Shift for ten frames, clamped at both ends.
  await page.keyboard.press('Shift+ArrowRight');
  await settled(page, 19);
  await page.keyboard.press('ArrowLeft');
  await settled(page, 18);
  expect(await frameState(page)).toMatchObject({ video: 18, overlay: 18 });
  await toFrame(page, 0);
  await page.keyboard.press('ArrowLeft');
  await settled(page, 0);
});

test('the overlay still belongs to the shown frame when the picture is zoomed and panned', async ({ page }) => {
  await open(page);
  const at = await client(page, boxA(0));
  await page.mouse.move((at.x1 + at.x2) / 2, (at.y1 + at.y2) / 2);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -300);
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(2);
  for (const target of [0, 1, 2, 3, 4]) {
    await page.keyboard.press(target === 0 ? 'Escape' : 'ArrowRight');
    await settled(page, target);
    const state = await frameState(page);
    expect(state.video, `video at ${target}`).toBe(target);
    expect(state.dataset).toBe(String(target));
  }
});

test('reject and confirm send the exact box the user was shown, for the frame on screen', async ({ page }) => {
  const api = await open(page);
  await toFrame(page, 20);
  await clickBox(page, boxA(20));
  await expect(page.getByRole('status').filter({ hasText: 'Seleccionada' })).toContainText('P-001');
  await page.getByRole('button', { name: 'Rechazar' }).click();
  await expect.poll(() => api.annotations.map(a => `${a.frame_index}:${a.kind}`)).toEqual(['20:reject']);
  expect(api.annotations[0].target).toEqual({ bbox: boxA(20), confidence: 0.9, track_id: 1 });
  await expect(page.getByText('1 rechazadas')).toBeVisible();
  // The same box can be re-decided from the keyboard; the newer decision replaces the older one.
  await page.keyboard.press('c');
  await expect.poll(() => api.annotations.map(a => a.kind)).toEqual(['confirm']);
  await expect(page.getByText('1 confirmadas')).toBeVisible();
  await expect(page.getByText('0 rechazadas')).toBeVisible();
  // A frame change drops the selection, so a key press cannot act on a box that is no longer shown.
  await page.getByRole('button', { name: 'Frame siguiente' }).click();
  await settled(page, 21);
  await page.keyboard.press('r');
  expect(api.annotations).toHaveLength(1);
});

test('dragging a model box adjusts it once, then moves that same adjustment; the box never leaves the frame', async ({ page }) => {
  const api = await open(page);
  await toFrame(page, 30);
  const scale = (await client(page, boxA(30))).scale;
  const pageHeight = () => page.evaluate(() => document.documentElement.scrollHeight);
  const heightBefore = await pageHeight();
  await dragBox(page, boxA(30), 40 * scale, 30 * scale);
  expect(await pageHeight()).toBe(heightBefore); // selecting must not shift the layout under the pointer
  await expect.poll(() => api.annotations.map(a => a.kind)).toEqual(['adjust']);
  const first = api.annotations[0].bbox!;
  expect(first[0]).toBeCloseTo(boxA(30)[0] + 40, 0);
  expect(first[1]).toBeCloseTo(boxA(30)[1] + 30, 0);
  expect(first[2] - first[0]).toBeCloseTo(40, 0);  // a move keeps the size
  expect(api.annotations[0].target?.bbox).toEqual(boxA(30)); // the original is kept as evidence
  await expect(page.getByText('1 ajustadas')).toBeVisible(); // the screen has caught up with the server
  await dragBox(page, first as Box, 20 * scale, 0);
  await expect.poll(() => api.annotations[0].bbox![0]).toBeCloseTo(first[0] + 20, 0);
  expect(writes(api).filter(r => r.startsWith('PATCH'))).toHaveLength(1);
  expect(api.annotations).toHaveLength(1);
  // Far outside the frame: the box is clamped, never sent out of bounds.
  await expect(page.getByText('1 ajustadas')).toBeVisible();
  await dragBox(page, api.annotations[0].bbox as Box, -3000, -3000);
  await expect.poll(() => api.annotations[0].bbox![0]).toBe(0);
  expect(api.annotations[0].bbox![1]).toBe(0);
});

test('while zoomed in, a drag moves the box by the right number of video pixels', async ({ page }) => {
  const api = await open(page);
  await toFrame(page, 30);
  const at = await client(page, boxA(30));
  await page.mouse.move((at.x1 + at.x2) / 2, (at.y1 + at.y2) / 2);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -300);
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(4);
  const scale = (await client(page, boxA(30))).scale;
  expect(scale).toBeGreaterThan(at.scale * 4);
  await dragBox(page, boxA(30), 8 * scale, 5 * scale); // 8 x 5 video pixels, however large the zoom
  await expect.poll(() => api.annotations.map(a => a.kind)).toEqual(['adjust']);
  const [x1, y1] = api.annotations[0].bbox!;
  expect(x1).toBeCloseTo(boxA(30)[0] + 8, 0);
  expect(y1).toBeCloseTo(boxA(30)[1] + 5, 0);
});

test('a corner handle resizes the selected box', async ({ page }) => {
  const api = await open(page);
  await toFrame(page, 40);
  await clickBox(page, boxA(40));
  const r = await client(page, boxA(40));
  await page.mouse.move(r.x2, r.y2);
  await page.mouse.down();
  await page.mouse.move(r.x2 + 20 * r.scale, r.y2 + 10 * r.scale, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => api.annotations.map(a => a.kind)).toEqual(['adjust']);
  const [x1, y1, x2, y2] = api.annotations[0].bbox!;
  expect([x1, y1]).toEqual(boxA(40).slice(0, 2));
  expect(x2).toBeCloseTo(boxA(40)[2] + 20, 0);
  expect(y2).toBeCloseTo(boxA(40)[3] + 10, 0);
});

test('adding an ant draws a box inside the frame, selects it, and returns to selection mode', async ({ page }) => {
  const api = await open(page);
  await toFrame(page, 50);
  await page.keyboard.press('a');
  await expect(page.getByRole('button', { name: 'Añadir hormiga (A)' })).toHaveAttribute('aria-pressed', 'true');
  const from = await client(page, [20, 250, 20, 250]);
  const to = await client(page, [90, 320, 90, 320]);
  await page.mouse.move(from.x1, from.y1);
  await page.mouse.down();
  await page.mouse.move(to.x1, to.y1, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => api.annotations.map(a => a.kind)).toEqual(['add']);
  const [x1, y1, x2, y2] = api.annotations[0].bbox!;
  expect([Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)]).toEqual([20, 250, 90, 320]);
  await expect(page.getByRole('button', { name: 'Seleccionar y mover (V)' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status').filter({ hasText: 'Seleccionada' })).toContainText('caja añadida');
  // A rectangle that is too small is ignored rather than stored (and add mode stays on).
  await page.keyboard.press('a');
  await page.mouse.move(from.x1 + 300, from.y1 - 100);
  await page.mouse.down();
  await page.mouse.move(from.x1 + 301, from.y1 - 99);
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect(api.annotations).toHaveLength(1);
  // Dragging out of the frame is clamped to the frame edge.
  const edge = await client(page, [600, 300, 600, 300]);
  await page.mouse.move(edge.x1, edge.y1);
  await page.mouse.down();
  await page.mouse.move(edge.x1 + 400, edge.y1 + 400, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => api.annotations.length).toBe(2);
  const clamped = api.annotations[1].bbox!;
  expect(clamped[0]).toBeCloseTo(600, -1);
  expect(clamped[1]).toBeCloseTo(300, -1);
  expect([clamped[2], clamped[3]]).toEqual([WIDTH, HEIGHT]);
});

test('undo reverts creates, moves and deletions in order, and the frame-complete toggle', async ({ page }) => {
  const api = await open(page);
  await toFrame(page, 60);
  await clickBox(page, boxA(60));
  await page.getByRole('button', { name: 'Rechazar' }).click();
  await expect.poll(() => api.annotations.length).toBe(1);
  await page.getByRole('button', { name: 'Frame completo' }).click();
  await expect.poll(() => [...api.complete]).toEqual([60]);
  await page.getByRole('button', { name: 'Deshacer' }).click(); // frame complete
  await expect.poll(() => [...api.complete]).toEqual([]);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z'); // the rejection
  await expect.poll(() => api.annotations.length).toBe(0);
  await expect(page.getByRole('button', { name: 'Deshacer' })).toBeDisabled();
});

test('the review queue lists frames, navigates both ways and drops frames once complete', async ({ page }) => {
  const api = await open(page);
  const queue = page.getByLabel('Cola de revisión');
  await expect(queue.getByRole('button', { name: /Frame 8 incierto/ })).toBeVisible();
  await queue.getByRole('button', { name: /Frame 30/ }).click();
  await settled(page, 30);
  await queue.getByRole('button', { name: 'Siguiente' }).click();
  await settled(page, 90);
  await queue.getByRole('button', { name: 'Anterior' }).click();
  await settled(page, 30);
  await page.keyboard.press('n');
  await settled(page, 90);
  await page.keyboard.press('p');
  await settled(page, 30);
  await page.keyboard.press('f');
  await expect.poll(() => [...api.complete]).toEqual([30]);
  await expect(queue.getByRole('button', { name: /Frame 30/ })).toHaveCount(0);
  await queue.getByRole('button', { name: 'Cobertura', exact: true }).click();
  await expect(queue.getByRole('button', { name: /Frame 45 cobertura/ })).toBeVisible();
  await expect(queue.getByRole('button', { name: 'Cobertura', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('exporting shows the versioned result with links to its files', async ({ page }) => {
  const api = await open(page);
  await expect(page.getByRole('button', { name: 'Exportar correcciones' })).toBeDisabled();
  await toFrame(page, 5);
  await page.keyboard.press('f');
  await expect.poll(() => [...api.complete]).toEqual([5]);
  await page.getByRole('button', { name: 'Exportar correcciones' }).click();
  await expect(page.getByText('Exportación v0001 creada.')).toBeVisible();
  const links = page.getByLabel('Última exportación').getByRole('link');
  await expect(links).toHaveCount(3);
  await expect(links.first()).toHaveAttribute('href', '/api/sessions/s1/exports/v0001/manifest.json');
});

test('server refusals are shown and nothing changes on screen', async ({ page }) => {
  const api = await open(page);
  await toFrame(page, 70);
  // The mock rejects boxes it never produced; provoke the refusal with a one-off 422.
  await page.route('**/api/sessions/s1/corrections', route => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ detail: 'target does not match any box the analysis produced for this frame' }) }), { times: 1 });
  await clickBox(page, boxA(70));
  await page.getByRole('button', { name: 'Rechazar' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'does not match any box' })).toBeVisible();
  expect(api.annotations).toEqual([]);
  await expect(page.getByText('0 rechazadas')).toBeVisible();
});

test('an unverified source blocks every editing control', async ({ page }) => {
  const api = await open(page, { verified: false });
  await expect(page.getByRole('alert').filter({ hasText: 'SHA-256' })).toBeVisible();
  for (const name of ['Seleccionar y mover (V)', 'Añadir hormiga (A)', 'Frame completo', 'Exportar correcciones']) await expect(page.getByRole('button', { name })).toBeDisabled();
  await toFrame(page, 10);
  await clickBox(page, boxA(10));
  await expect(page.getByRole('button', { name: 'Rechazar' })).toHaveCount(0); // nothing could be selected
  await page.keyboard.press('r');
  await page.keyboard.press('f');
  await page.keyboard.press('a');
  expect(writes(api)).toEqual([]);
  // Looking is still allowed: zoom and pan are not edits.
  await page.keyboard.press('+');
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(1);
});

test('zoom: buttons, keys, fit and actual pixels, and the minimap only while zoomed in', async ({ page }) => {
  await open(page);
  const fitWidth = (await videoEl(page).boundingBox())!.width;
  expect(await zoomOf(page)).toBe(1);
  await expect(page.getByLabel('Minimapa: arrastre para mover la vista')).toHaveCount(0);
  await page.getByRole('button', { name: 'Acercar' }).click();
  await expect.poll(() => zoomOf(page)).toBeCloseTo(1.25, 2);
  await expect(page.getByLabel('Nivel de zoom')).toHaveText('ZOOM 125 %');
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await expect.poll(() => zoomOf(page)).toBeCloseTo(1.25 ** 3, 2);
  await expect(page.getByLabel('Minimapa: arrastre para mover la vista')).toBeVisible();
  await page.getByRole('button', { name: 'Alejar' }).click();
  await expect.poll(() => zoomOf(page)).toBeCloseTo(1.25 ** 2, 2);
  await page.keyboard.press('1');
  // 100 % is one video pixel per screen pixel, but never smaller than fit: this small clip fits larger than 640 px.
  const video = await videoEl(page).boundingBox();
  expect(video!.width).toBeCloseTo(Math.max(WIDTH, fitWidth), 0);
  await page.keyboard.press('0');
  expect(await zoomOf(page)).toBe(1);
  await expect(page.getByLabel('Minimapa: arrastre para mover la vista')).toHaveCount(0);
  await page.getByRole('button', { name: 'Acercar' }).click();
  await page.getByRole('button', { name: 'Ajustar' }).click();
  expect(await zoomOf(page)).toBe(1);
});

test('the wheel zooms around the pointer and the picture can be panned and recentred from the minimap', async ({ page }) => {
  await open(page);
  const before = await client(page, [300, 200, 300, 200]);
  await page.mouse.move(before.x1, before.y1);
  await page.mouse.wheel(0, -400);
  await expect.poll(() => zoomOf(page)).toBeGreaterThan(1.2);
  const after = await client(page, [300, 200, 300, 200]);
  expect(after.x1).toBeCloseTo(before.x1, 0); // the pixel under the pointer did not move
  expect(after.y1).toBeCloseTo(before.y1, 0);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -300);
  // Space + drag pans the picture by the pointer's travel.
  const start = await videoEl(page).boundingBox();
  await page.keyboard.down(' ');
  await page.mouse.move(before.x1, before.y1);
  await page.mouse.down();
  await page.mouse.move(before.x1 + 60, before.y1 + 30, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up(' ');
  const moved = await videoEl(page).boundingBox();
  expect(moved!.x - start!.x).toBeCloseTo(60, 0);
  expect(moved!.y - start!.y).toBeCloseTo(30, 0);
  // Clicking the minimap puts that part of the frame at the centre of the stage.
  const minimap = page.getByLabel('Minimapa: arrastre para mover la vista');
  const box = (await minimap.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.1);
  const stage = (await page.getByTestId('stage').boundingBox())!;
  const centre = await page.evaluate(([cx, cy]) => {
    const v = document.querySelector<HTMLVideoElement>('[data-testid="stage"] video')!.getBoundingClientRect();
    return { x: (cx - v.left) / (v.width / 640), y: (cy - v.top) / (v.height / 360) };
  }, [stage.x + stage.width / 2, stage.y + stage.height / 2]);
  expect(centre.x).toBeGreaterThan(640 * 0.8);
  expect(centre.y).toBeLessThan(360 * 0.3);
});

test('the zoom tool zooms in on click and out on Shift-click', async ({ page }) => {
  await open(page);
  await page.keyboard.press('z');
  await expect(page.getByRole('button', { name: 'Zoom (Z)' })).toHaveAttribute('aria-pressed', 'true');
  const at = await client(page, [300, 200, 300, 200]);
  await page.mouse.click(at.x1, at.y1);
  await expect.poll(() => zoomOf(page)).toBeCloseTo(1.25 ** 2, 2);
  await page.keyboard.down('Shift');
  await page.mouse.click(at.x1, at.y1);
  await page.keyboard.up('Shift');
  await expect.poll(() => zoomOf(page)).toBe(1);
});

test('the timeline seeks by click and drag, and the go-to field clamps to the video', async ({ page }) => {
  await open(page);
  const lanes = page.getByTestId('timeline-canvas');
  const box = (await lanes.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + 10);
  await expect.poll(() => canvasEl(page).getAttribute('data-frame')).toBe(String(Math.floor(FRAMES * 0.5)));
  await page.mouse.move(box.x + box.width * 0.25, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + 10, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole('slider', { name: 'Posición en el video' })).toHaveAttribute('aria-valuenow', String(Math.floor(FRAMES * 0.75)));
  await page.getByLabel('Ir al frame').fill('9999');
  await page.getByLabel('Ir al frame').press('Enter');
  await settled(page, FRAMES - 1);
  await expect(page.getByLabel('Ir al frame')).toHaveValue(String(FRAMES - 1));
  await page.getByLabel('Ir al frame').fill('not a number');
  await page.getByLabel('Ir al frame').press('Enter');
  await expect(page.getByLabel('Ir al frame')).toHaveValue(String(FRAMES - 1));
});

test('the tool column is one tab stop with arrow-key navigation, and shortcuts do not fire while typing', async ({ page }) => {
  const api = await open(page);
  const tools = page.getByRole('toolbar', { name: 'Herramientas' });
  const select = tools.getByRole('button', { name: 'Seleccionar y mover (V)' });
  await select.focus();
  await page.keyboard.press('ArrowDown');
  await expect(tools.getByRole('button', { name: 'Añadir hormiga (A)' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(tools.getByRole('button', { name: 'Mostrar identificadores (I)' })).toBeFocused();
  // Typing in the go-to field must not trigger tools or decisions.
  await toFrame(page, 3);
  await page.getByLabel('Ir al frame').fill('rf');
  expect(writes(api)).toEqual([]);
  await expect(tools.getByRole('button', { name: 'Seleccionar y mover (V)' })).toHaveAttribute('aria-pressed', 'true');
});

test('boxes can be hidden and brought back', async ({ page }) => {
  await open(page);
  await toFrame(page, 20);
  expect(await paintedPixels(canvasEl(page))).toBeGreaterThan(0);
  await page.keyboard.press('b');
  await expect(page.getByRole('button', { name: 'Mostrar cajas (B)' })).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => paintedPixels(canvasEl(page))).toBe(0);
  await page.keyboard.press('b');
  await expect.poll(() => paintedPixels(canvasEl(page))).toBeGreaterThan(0);
});

test('the shortcuts dialog opens with ?, lists the keys, and blocks them until it closes', async ({ page }) => {
  const api = await open(page);
  await toFrame(page, 12);
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Atajos de teclado' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Marcar frame completo')).toBeVisible();
  await expect(dialog.locator('kbd').first()).toBeVisible();
  await page.keyboard.press('f');
  expect(api.complete.size).toBe(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.keyboard.press('f');
  await expect.poll(() => [...api.complete]).toEqual([12]);
});

test('the corrections harness never reaches anything it does not mock', async ({ page }) => {
  const api = await open(page);
  expect(api.requests.every(r => /\/api\//.test(r))).toBe(true);
  expect(await page.evaluate(() => performance.getEntriesByType('resource').map(e => e.name).filter(n => !n.startsWith(location.origin)))).toEqual([]);
});

test.describe('list of analysed videos', () => {
  test('shows each video with its progress, filters and searches, and opens the workspace', async ({ page }) => {
    await installApi(page);
    await page.goto('/#/anotacion');
    await expect(page.getByRole('heading', { name: 'Videos analizados', exact: true })).toBeVisible();
    const table = page.getByRole('table', { name: 'Videos analizados' });
    await expect(table.getByRole('row')).toHaveCount(5); // header + 4
    await expect(table.getByRole('rowheader').first()).toContainText('sync.mp4'); // most recent activity first
    await expect(page.getByRole('button', { name: /Todos · 4/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: /Con correcciones · 2/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Sin empezar · 1/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Video sin verificar · 2/ })).toBeVisible();
    await expect(table.getByText('✓ VERIFICADO').first()).toBeVisible();
    await expect(table.getByText('! NO COINCIDE')).toBeVisible();
    await expect(table.getByText('! SIN ANÁLISIS')).toBeVisible();
    await expect(table.getByLabel('Frames completos de sync.mp4')).toHaveAttribute('aria-valuenow', String(Math.round((12 / FRAMES) * 100)));
    await expect(table.getByText('experimental')).toHaveCount(2);

    await page.getByRole('button', { name: /Sin empezar/ }).click();
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table.getByRole('rowheader')).toContainText('fresh.mp4');
    await expect(table.getByRole('link', { name: 'Empezar: fresh.mp4' })).toHaveAttribute('href', '#/anotacion/s4');
    await page.getByRole('button', { name: /Todos/ }).click();
    await page.getByLabel('Buscar por nombre de video').fill('MOVED');
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table.getByRole('link', { name: 'Solo lectura: moved.mp4' })).toBeVisible();
    await page.getByLabel('Buscar por nombre de video').fill('zzz');
    await expect(table.getByText('Ningún video coincide con el filtro.')).toBeVisible();
    await page.getByLabel('Buscar por nombre de video').fill('');

    await table.getByRole('link', { name: 'Abrir: sync.mp4' }).click();
    await expect(page).toHaveURL(/#\/anotacion\/s1$/);
    await expect(page.getByLabel('Espacio de anotación')).toBeVisible();
    await page.getByRole('link', { name: '← Videos' }).click();
    await expect(page.getByRole('heading', { name: 'Videos analizados', exact: true })).toBeVisible();
  });

  test('the section links navigate between pages and mark the current one', async ({ page }) => {
    await installApi(page);
    await page.goto('/#/anotacion');
    const nav = page.getByRole('navigation', { name: 'Secciones' });
    await expect(nav.getByRole('link', { name: 'Anotación' })).toHaveAttribute('aria-current', 'page');
    await nav.getByRole('link', { name: 'Observatorio' }).click();
    await expect(nav.getByRole('link', { name: 'Observatorio' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByLabel('Video aprobado')).toBeVisible();
    await nav.getByRole('link', { name: 'Review' }).click();
    await expect(page.getByText('CORREGIR DETECCIONES')).toBeVisible();
    await page.getByRole('link', { name: 'Abrir en Anotación →' }).click();
    await expect(page.getByLabel('Espacio de anotación')).toBeVisible();
  });

  test('an empty list and a failed load say so', async ({ page }) => {
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/annotation/sessions') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [] }) });
      if (path === '/api/input-videos') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ videos: [] }) });
      if (path === '/api/models') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ default: 'V2-E2', models: [] }) });
      return route.abort();
    });
    await page.goto('/#/anotacion');
    await expect(page.getByText('Todavía no hay videos analizados.')).toBeVisible();
    await page.unroute('**/api/**');
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/annotation/sessions') return route.fulfill({ status: 500, body: 'database is locked' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ videos: [], default: 'V2-E2', models: [] }) });
    });
    await page.reload();
    await expect(page.getByText('No se pudo cargar la lista')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
  });
});
