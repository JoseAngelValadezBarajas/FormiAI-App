import type { ProgressiveFrame } from '../progress';

/** mm:ss.cc, matching the Figma clock ("00:06.36"). Negative and non-finite values clamp to zero. */
export function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const centis = Math.floor(safe * 100 + 1e-6);
  const minutes = Math.floor(centis / 6000);
  const rest = centis - minutes * 6000;
  const whole = Math.floor(rest / 100);
  return `${String(minutes).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(rest - whole * 100).padStart(2, '0')}`;
}

/** Provisional track label. P-ID is a computer-vision track id, never a biological identity. */
export const trackLabel = (trackId: number) => `P-${String(trackId).padStart(3, '0')}`;

/** Frames with a published result over the declared total; the total is unknown until the manifest arrives. */
export function analyzedFrames(processedThrough: number, frameCount?: number) {
  const analyzed = Math.max(0, processedThrough + 1);
  const total = frameCount && frameCount > 0 ? frameCount : undefined;
  return { analyzed: total ? Math.min(analyzed, total) : analyzed, total };
}

export function progressRatio(processedThrough: number, frameCount?: number): number {
  const { analyzed, total } = analyzedFrames(processedThrough, frameCount);
  return total ? Math.min(1, analyzed / total) : 0;
}

export type TimelineBin = { mean: number; analyzed: boolean };

/**
 * Mean detections per analyzed frame inside each bin. A bin is `analyzed` once its first frame has a
 * published result; frames without a result never contribute, so nothing is interpolated.
 */
export function binDetections(
  frames: ReadonlyMap<number, ProgressiveFrame>,
  frameCount: number | undefined,
  processedThrough: number,
  binCount = 42,
): TimelineBin[] {
  if (!frameCount || frameCount <= 0 || binCount <= 0) return [];
  const size = frameCount / binCount;
  return Array.from({ length: binCount }, (_, index) => {
    const start = Math.floor(index * size);
    const end = Math.max(start + 1, Math.floor((index + 1) * size));
    let sum = 0;
    let seen = 0;
    for (let frame = start; frame < Math.min(end, frameCount); frame += 1) {
      const result = frames.get(frame);
      if (result) { sum += result.detections.length; seen += 1; }
    }
    return { mean: seen ? sum / seen : 0, analyzed: start <= processedThrough };
  });
}

export type RateSample = { at: number; frame: number };

/**
 * Frames analyzed per second between two batch arrivals as observed by this client. It is a delivery
 * rate, not a GPU benchmark; undefined until two samples at least `minimumMs` apart exist.
 */
export function observedRate(first: RateSample | undefined, last: RateSample | undefined, minimumMs = 500): number | undefined {
  if (!first || !last) return undefined;
  const elapsed = last.at - first.at;
  const frames = last.frame - first.frame;
  return elapsed >= minimumMs && frames > 0 ? (frames / elapsed) * 1000 : undefined;
}

/** Normalized x position (0..1) of a time within the video, clamped. */
export const cursorRatio = (time: number, duration: number) => (duration > 0 ? Math.max(0, Math.min(1, time / duration)) : 0);

export type ContentRect = { x: number; y: number; width: number; height: number; scale: number };

/** Where `object-fit: contain` actually paints the video inside its element box; boxes must be drawn there. */
export function containRect(boxWidth: number, boxHeight: number, videoWidth: number, videoHeight: number): ContentRect | undefined {
  if (!(boxWidth > 0 && boxHeight > 0 && videoWidth > 0 && videoHeight > 0)) return undefined;
  const scale = Math.min(boxWidth / videoWidth, boxHeight / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return { x: (boxWidth - width) / 2, y: (boxHeight - height) / 2, width, height, scale };
}

export type ReceivedState = { through: number; sequence: number };
export type BatchVerdict = 'advanced' | 'replay' | 'gap';

/**
 * Local receipt of progressive batches. Only a batch that is exactly the next sequence advances the
 * received watermark; a repeated one is a harmless replay and a skipped one is a gap that must not be
 * presented as continuous progress. The server's own `progress` event never advances this state.
 */
export function acceptBatch(
  state: ReceivedState,
  batch: { sequence: number; processed_through_frame: number },
): { state: ReceivedState; verdict: BatchVerdict } {
  if (batch.sequence <= state.sequence) return { state, verdict: 'replay' };
  if (batch.sequence !== state.sequence + 1) return { state, verdict: 'gap' };
  return { state: { through: Math.max(state.through, batch.processed_through_frame), sequence: batch.sequence }, verdict: 'advanced' };
}

/**
 * requestVideoFrameCallback reports `mediaTime` rounded to six decimals (e.g. frame 2 at 24 fps is
 * 0.083333, i.e. 1.999992 frames), which `floor(time * fps + 1e-6)` would assign to the previous frame.
 * Times within 1e-3 frame of a frame boundary are snapped to it; anything else is returned unchanged.
 */
export const snapMediaTime = (time: number, fps: number) => {
  const scaled = time * fps;
  const nearest = Math.round(scaled);
  return Math.abs(scaled - nearest) < 1e-3 ? nearest / fps : time;
};
