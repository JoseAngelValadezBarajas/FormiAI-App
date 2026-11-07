import { describe, expect, it } from 'vitest';
import type { ProgressiveFrame } from '../progress';
import { acceptBatch, analyzedFrames, binDetections, containRect, cursorRatio, formatClock, observedRate, progressRatio, snapMediaTime, trackLabel } from './model';

const frame = (index: number, count: number): ProgressiveFrame => ({
  frame_index: index,
  timestamp_seconds: index / 10,
  detections: Array.from({ length: count }, (_, track) => ({ bbox: [0, 0, 1, 1] as [number, number, number, number], confidence: 0.9, track_id: track })),
});

describe('observatory clock and labels', () => {
  it('formats mm:ss.cc and clamps invalid input', () => {
    expect(formatClock(6.36)).toBe('00:06.36');
    expect(formatClock(40.74)).toBe('00:40.74');
    expect(formatClock(125.5)).toBe('02:05.50');
    expect(formatClock(-3)).toBe('00:00.00');
    expect(formatClock(Number.NaN)).toBe('00:00.00');
  });

  it('labels provisional tracks as P-NNN', () => {
    expect(trackLabel(1)).toBe('P-001');
    expect(trackLabel(1234)).toBe('P-1234');
  });
});

describe('observatory progress', () => {
  it('counts frames with results and never exceeds the declared total', () => {
    expect(analyzedFrames(381, 2445)).toEqual({ analyzed: 382, total: 2445 });
    expect(analyzedFrames(-1, 2445)).toEqual({ analyzed: 0, total: 2445 });
    expect(analyzedFrames(9999, 100)).toEqual({ analyzed: 100, total: 100 });
    expect(analyzedFrames(5, undefined)).toEqual({ analyzed: 6, total: undefined });
  });

  it('has no ratio until the total is known', () => {
    expect(progressRatio(381, 2445)).toBeCloseTo(382 / 2445);
    expect(progressRatio(50, undefined)).toBe(0);
  });
});

describe('observatory timeline bins', () => {
  it('averages only frames with results and marks pending bins', () => {
    const frames = new Map([[0, frame(0, 2)], [1, frame(1, 4)], [2, frame(2, 6)]]);
    const bins = binDetections(frames, 8, 2, 4);
    expect(bins).toHaveLength(4);
    expect(bins[0]).toEqual({ mean: 3, analyzed: true });
    expect(bins[1]).toEqual({ mean: 6, analyzed: true });
    expect(bins[2]).toEqual({ mean: 0, analyzed: false });
    expect(bins[3]).toEqual({ mean: 0, analyzed: false });
  });

  it('returns nothing without a frame count', () => {
    expect(binDetections(new Map(), undefined, -1)).toEqual([]);
    expect(binDetections(new Map(), 0, -1)).toEqual([]);
  });
});

describe('observed rate', () => {
  it('reports the delivery rate between two batch arrivals', () => {
    expect(observedRate({ at: 1000, frame: 10 }, { at: 3000, frame: 60 })).toBe(25);
  });

  it('stays undefined when evidence is insufficient', () => {
    expect(observedRate(undefined, { at: 3000, frame: 60 })).toBeUndefined();
    expect(observedRate({ at: 1000, frame: 10 }, { at: 1200, frame: 60 })).toBeUndefined();
    expect(observedRate({ at: 1000, frame: 60 }, { at: 3000, frame: 60 })).toBeUndefined();
  });
});

describe('cursor ratio', () => {
  it('clamps to the video range', () => {
    expect(cursorRatio(10, 40)).toBe(0.25);
    expect(cursorRatio(-1, 40)).toBe(0);
    expect(cursorRatio(50, 40)).toBe(1);
    expect(cursorRatio(5, 0)).toBe(0);
  });
});

describe('contain rect', () => {
  it('letterboxes a wide video inside a taller box', () => {
    expect(containRect(1000, 600, 1000, 400)).toEqual({ x: 0, y: 100, width: 1000, height: 400, scale: 1 });
  });

  it('pillarboxes a tall video inside a wider box', () => {
    expect(containRect(1000, 400, 400, 400)).toEqual({ x: 300, y: 0, width: 400, height: 400, scale: 1 });
  });

  it('has no rect before metadata is known', () => {
    expect(containRect(1000, 400, 0, 0)).toBeUndefined();
    expect(containRect(0, 400, 100, 100)).toBeUndefined();
  });
});

describe('local batch receipt', () => {
  it('advances only on the next contiguous sequence', () => {
    const start = { through: -1, sequence: 0 };
    const first = acceptBatch(start, { sequence: 1, processed_through_frame: 9 });
    expect(first).toEqual({ state: { through: 9, sequence: 1 }, verdict: 'advanced' });
    expect(acceptBatch(first.state, { sequence: 2, processed_through_frame: 19 }).state).toEqual({ through: 19, sequence: 2 });
  });

  it('reports a gap without advancing', () => {
    const state = { through: 9, sequence: 1 };
    expect(acceptBatch(state, { sequence: 3, processed_through_frame: 29 })).toEqual({ state, verdict: 'gap' });
  });

  it('treats a repeated batch as a replay', () => {
    const state = { through: 19, sequence: 2 };
    expect(acceptBatch(state, { sequence: 1, processed_through_frame: 9 })).toEqual({ state, verdict: 'replay' });
    expect(acceptBatch(state, { sequence: 2, processed_through_frame: 19 }).verdict).toBe('replay');
  });
});

describe('snapMediaTime', () => {
  it('maps a six-decimal mediaTime to its own frame', () => {
    // 0.083333 is frame 2 at 24 fps after rounding; unsnapped it would floor to frame 1.
    expect(Math.floor(snapMediaTime(0.083333, 24) * 24 + 1e-6)).toBe(2);
    expect(Math.floor(0.083333 * 24 + 1e-6)).toBe(1);
  });
  it('leaves times that are not at a frame boundary alone', () => {
    expect(snapMediaTime(0.1, 24)).toBe(0.1);
    expect(Math.floor(snapMediaTime((41 + 0.5) / 24, 24) * 24 + 1e-6)).toBe(41);
  });
});
