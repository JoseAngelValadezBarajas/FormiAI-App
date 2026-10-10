export type ProgressiveDetection = { bbox: [number, number, number, number]; confidence: number; track_id: number };
export type ProgressiveFrame = { frame_index: number; timestamp_seconds: number; detections: ProgressiveDetection[] };

// A box belongs only to its decoded scientific frame; adjacent-frame interpolation is forbidden.
export const frameAtTime = (frames: Map<number, ProgressiveFrame>, time: number, fps: number) => frames.get(Math.floor(time * fps + 1e-6));
export const canPlayFrame = (time: number, fps: number, processedThrough: number) => Math.floor(time * fps + 1e-6) <= processedThrough;
