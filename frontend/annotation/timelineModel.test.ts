import { describe, expect, it } from 'vitest';
import type { Annotation } from '../observatory/correctionsModel';
import { buildLanes, frameAt, frameX, markWidth, ranges } from './timelineModel';

const note = (frame_index: number): Annotation => ({ id: `a${frame_index}`, frame_index, kind: 'reject', target: null, bbox: null });

describe('ranges', () => {
  it('merges contiguous frames and keeps gaps', () => {
    expect(ranges([5, 3, 4, 10, 11, 20])).toEqual([[3, 5], [10, 11], [20, 20]]);
  });
  it('ignores duplicates and handles an empty set', () => {
    expect(ranges([2, 2, 2])).toEqual([[2, 2]]);
    expect(ranges([])).toEqual([]);
    expect(ranges(new Set([1, 2]))).toEqual([[1, 2]]);
  });
});

describe('buildLanes', () => {
  it('summarises completion, corrected frames and the queue', () => {
    const lanes = buildLanes(new Set([1, 2, 3, 9]), [note(7), note(7), note(2)], [{ frame_index: 40 }, { frame_index: 8 }]);
    expect(lanes).toEqual({ complete: [[1, 3], [9, 9]], corrected: [2, 7], queue: [8, 40] });
  });
});

describe('frameAt and frameX', () => {
  it('maps a pointer offset to a frame and clamps at both ends', () => {
    expect(frameAt(0, 1000, 3746)).toBe(0);
    expect(frameAt(500, 1000, 3746)).toBe(1873);
    expect(frameAt(1000, 1000, 3746)).toBe(3745);
    expect(frameAt(-50, 1000, 3746)).toBe(0);
    expect(frameAt(5000, 1000, 3746)).toBe(3745);
  });
  it('is safe without a size or frames', () => {
    expect(frameAt(10, 0, 100)).toBe(0);
    expect(frameAt(10, 100, 0)).toBe(0);
  });
  it('places a frame inside the track and agrees with frameAt', () => {
    for (const frame of [0, 1, 1223, 3745]) {
      const x = frameX(frame, 818, 3746);
      expect(frameAt(x + 0.01, 818, 3746)).toBe(frame);
    }
  });
});

describe('markWidth', () => {
  it('never draws a mark thinner than the minimum', () => {
    expect(markWidth(818, 3746)).toBe(2);
    expect(markWidth(818, 100)).toBeCloseTo(8.18, 6);
  });
});
