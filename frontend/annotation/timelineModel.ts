import { clamp, type Annotation } from '../observatory/correctionsModel';

export type FrameRange = [start: number, end: number];

/** Contiguous runs of frame numbers, so thousands of completed frames draw as a handful of blocks. */
export function ranges(frames: Iterable<number>): FrameRange[] {
  const sorted = [...new Set(frames)].sort((a, b) => a - b);
  const result: FrameRange[] = [];
  for (const frame of sorted) {
    const last = result[result.length - 1];
    if (last && frame === last[1] + 1) last[1] = frame;
    else result.push([frame, frame]);
  }
  return result;
}

export type Lanes = { complete: FrameRange[]; corrected: number[]; queue: number[] };

export function buildLanes(complete: Iterable<number>, annotations: Annotation[], queue: { frame_index: number }[]): Lanes {
  return {
    complete: ranges(complete),
    corrected: [...new Set(annotations.map(a => a.frame_index))].sort((a, b) => a - b),
    queue: queue.map(item => item.frame_index).sort((a, b) => a - b),
  };
}

/** Frame under a pointer at `offset` px inside a track `width` px wide. */
export function frameAt(offset: number, width: number, frameCount: number): number {
  if (!(width > 0) || frameCount <= 0) return 0;
  return clamp(Math.floor((offset / width) * frameCount), 0, frameCount - 1);
}

/** Left edge, in px, of `frame` inside a track `width` px wide. */
export const frameX = (frame: number, width: number, frameCount: number) => (frameCount > 0 ? (frame / frameCount) * width : 0);

/** The thin marks are at least one device pixel wide even when a frame is a fraction of a pixel. */
export const markWidth = (width: number, frameCount: number, minimum = 2) => Math.max(minimum, frameCount > 0 ? width / frameCount : minimum);
