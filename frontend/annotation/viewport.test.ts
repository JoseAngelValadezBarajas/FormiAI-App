import { describe, expect, it } from 'vitest';
import { toScreen, toVideo } from '../observatory/correctionsModel';
import {
  MAX_ZOOM, actualPixels, centerOn, clampView, fitView, frameBox, panBy, project, visibleRect, zoomAt, zoomCentre, zoomPercent,
} from './viewport';

const source = { width: 1920, height: 1080 };
const stage = { width: 1000, height: 600 };

describe('project', () => {
  it('fits the whole video, centred, when zoom is 1', () => {
    const p = project(fitView(source), stage, source)!;
    expect(p.scale).toBeCloseTo(1000 / 1920, 10);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo((600 - 1080 * p.scale) / 2, 6);
  });
  it('is undefined while the stage or the video has no size', () => {
    expect(project(fitView(source), { width: 0, height: 0 }, source)).toBeUndefined();
    expect(project(fitView(source), stage, { width: 0, height: 0 })).toBeUndefined();
  });
  it('round-trips between video and stage coordinates at any zoom', () => {
    const view = { zoom: 6, cx: 700, cy: 300 };
    const p = project(view, stage, source)!;
    const [vx, vy] = toVideo(p, 123, 456);
    const box = toScreen(p, [vx, vy, vx, vy]);
    expect(box[0]).toBeCloseTo(123, 6);
    expect(box[1]).toBeCloseTo(456, 6);
  });
});

describe('zoomAt', () => {
  it('keeps the video pixel under the cursor where it is', () => {
    for (const at of [{ x: 100, y: 80 }, { x: 900, y: 500 }, { x: 500, y: 300 }]) {
      const start = zoomCentre(fitView(source), 3, stage, source);
      const before = project(start, stage, source)!;
      const anchor = toVideo(before, at.x, at.y);
      const next = zoomAt(start, 2, at, stage, source);
      const after = project(next, stage, source)!;
      const back = toScreen(after, [anchor[0], anchor[1], anchor[0], anchor[1]]);
      expect(back[0]).toBeCloseTo(at.x, 4);
      expect(back[1]).toBeCloseTo(at.y, 4);
    }
  });
  it('never zooms out past fit or in past the maximum, and re-centres at fit', () => {
    const panned = { zoom: 2, cx: 300, cy: 200 };
    expect(zoomCentre(panned, 0.01, stage, source)).toEqual(fitView(source));
    expect(zoomCentre(panned, 1e9, stage, source).zoom).toBe(MAX_ZOOM);
    expect(zoomCentre(fitView(source), 0.5, stage, source)).toEqual(fitView(source));
  });
  it('returns the same view when nothing can change', () => {
    const atMax = { zoom: MAX_ZOOM, cx: 10, cy: 10 };
    expect(zoomAt(atMax, 2, { x: 5, y: 5 }, stage, source)).toBe(atMax);
  });
});

describe('panBy', () => {
  it('moves the picture with the pointer', () => {
    const view = { zoom: 4, cx: 960, cy: 540 };
    const before = project(view, stage, source)!;
    const next = panBy(view, 50, -20, stage, source);
    const after = project(next, stage, source)!;
    expect(after.x - before.x).toBeCloseTo(50, 6);
    expect(after.y - before.y).toBeCloseTo(-20, 6);
  });
  it('cannot carry the centre off the video', () => {
    const far = panBy({ zoom: 4, cx: 960, cy: 540 }, -1e9, 1e9, stage, source);
    expect(far.cx).toBe(1920);
    expect(far.cy).toBe(0);
  });
  it('does nothing at fit', () => {
    expect(panBy(fitView(source), 100, 100, stage, source)).toEqual(fitView(source));
  });
});

describe('visibleRect and the minimap', () => {
  it('is the whole video at fit', () => {
    const rect = visibleRect(fitView(source), stage, source)!;
    [0, 0, 1920, 1080].forEach((value, index) => expect(rect[index]).toBeCloseTo(value, 6));
  });
  it('shrinks with zoom around the centre', () => {
    const [x1, y1, x2, y2] = visibleRect({ zoom: 4, cx: 960, cy: 540 }, stage, source)!;
    expect((x1 + x2) / 2).toBeCloseTo(960, 6);
    expect((y1 + y2) / 2).toBeCloseTo(540, 6);
    expect(x2 - x1).toBeCloseTo(1920 / 4, 6);
  });
  it('centerOn puts a video pixel in the middle of the stage', () => {
    const view = centerOn({ zoom: 5, cx: 0, cy: 0 }, 400, 250, source);
    const p = project(view, stage, source)!;
    expect(toScreen(p, [400, 250, 400, 250])[0]).toBeCloseTo(stage.width / 2, 6);
    expect(toScreen(p, [400, 250, 400, 250])[1]).toBeCloseTo(stage.height / 2, 6);
  });
});

describe('actualPixels and frameBox', () => {
  it('actual pixels make one video pixel one stage pixel', () => {
    const view = actualPixels(fitView(source), stage, source);
    expect(project(view, stage, source)!.scale).toBeCloseTo(1, 10);
  });
  it('frames a box with air around it and clamps the zoom', () => {
    const view = frameBox([900, 500, 960, 540], stage, source);
    const p = project(view, stage, source)!;
    const [x1, y1, x2, y2] = toScreen(p, [900, 500, 960, 540]);
    expect(x1).toBeGreaterThan(0); expect(x2).toBeLessThan(stage.width);
    expect(y1).toBeGreaterThan(0); expect(y2).toBeLessThan(stage.height);
    expect(frameBox([10, 10, 11, 11], stage, source).zoom).toBeLessThanOrEqual(MAX_ZOOM);
  });
});

describe('clampView and labels', () => {
  it('clamps a wild view', () => {
    expect(clampView({ zoom: 99, cx: -5, cy: 5000 }, source)).toEqual({ zoom: MAX_ZOOM, cx: 0, cy: 1080 });
  });
  it('shows the zoom relative to fit as a whole percentage', () => {
    expect(zoomPercent(fitView(source))).toBe(100);
    expect(zoomPercent({ zoom: 4, cx: 0, cy: 0 })).toBe(400);
    expect(zoomPercent({ zoom: 1.25, cx: 0, cy: 0 })).toBe(125);
  });
});
