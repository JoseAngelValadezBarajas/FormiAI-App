// Zoom and pan for the annotation stage. Everything is expressed in SOURCE-VIDEO pixels: the view is "which video
// pixel sits at the centre of the stage, and how much larger than fit-to-stage is it drawn". Both the video and the
// box overlay are placed from the same projection, so they can never drift apart.
import { containRect } from '../observatory/model';
import { clamp, toVideo, type Box, type Projection } from '../observatory/correctionsModel';

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 32;
export const ZOOM_STEP = 1.25;

export type View = { zoom: number; cx: number; cy: number };
export type Stage = { width: number; height: number };
export type Size = { width: number; height: number };

export const fitView = (source: Size): View => ({ zoom: 1, cx: source.width / 2, cy: source.height / 2 });

/** The projection (video px -> stage px) for a view, or undefined while the stage or the video has no size. */
export function project(view: View, stage: Stage, source: Size): Projection | undefined {
  const base = containRect(stage.width, stage.height, source.width, source.height);
  if (!base) return undefined;
  const scale = base.scale * view.zoom;
  return { x: stage.width / 2 - view.cx * scale, y: stage.height / 2 - view.cy * scale, scale };
}

/** Keeps the zoom in range and the centre on the video; fit-to-stage always re-centres. */
export function clampView(view: View, source: Size): View {
  const zoom = clamp(view.zoom, MIN_ZOOM, MAX_ZOOM);
  if (zoom === MIN_ZOOM) return fitView(source);
  return { zoom, cx: clamp(view.cx, 0, source.width), cy: clamp(view.cy, 0, source.height) };
}

/** Zoom by `factor` keeping the video pixel under `at` (stage px) exactly where it is. */
export function zoomAt(view: View, factor: number, at: { x: number; y: number }, stage: Stage, source: Size): View {
  const before = project(view, stage, source);
  if (!before) return view;
  const zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  if (zoom === view.zoom) return view;
  const [vx, vy] = toVideo(before, at.x, at.y);
  const scale = before.scale / view.zoom * zoom;
  return clampView({ zoom, cx: vx - (at.x - stage.width / 2) / scale, cy: vy - (at.y - stage.height / 2) / scale }, source);
}

/** Zoom around the centre of the stage (the zoom buttons and keys). */
export const zoomCentre = (view: View, factor: number, stage: Stage, source: Size) =>
  zoomAt(view, factor, { x: stage.width / 2, y: stage.height / 2 }, stage, source);

/** Drag the picture by (dx, dy) stage pixels. */
export function panBy(view: View, dx: number, dy: number, stage: Stage, source: Size): View {
  const p = project(view, stage, source);
  if (!p) return view;
  return clampView({ ...view, cx: view.cx - dx / p.scale, cy: view.cy - dy / p.scale }, source);
}

/** Put a video pixel at the centre of the stage (used by the minimap). */
export const centerOn = (view: View, vx: number, vy: number, source: Size): View => clampView({ ...view, cx: vx, cy: vy }, source);

/** The part of the video that is on screen, in video pixels. */
export function visibleRect(view: View, stage: Stage, source: Size): Box | undefined {
  const p = project(view, stage, source);
  if (!p) return undefined;
  const [x1, y1] = toVideo(p, 0, 0);
  const [x2, y2] = toVideo(p, stage.width, stage.height);
  return [clamp(x1, 0, source.width), clamp(y1, 0, source.height), clamp(x2, 0, source.width), clamp(y2, 0, source.height)];
}

/** A view in which 1 video pixel is exactly 1 stage pixel (what "100 %" means to a person). */
export function actualPixels(view: View, stage: Stage, source: Size): View {
  const base = containRect(stage.width, stage.height, source.width, source.height);
  return base ? clampView({ ...view, zoom: 1 / base.scale }, source) : view;
}

/** A view that frames `box` with some air around it, never closer than MAX_ZOOM. */
export function frameBox(box: Box, stage: Stage, source: Size, margin = 4): View {
  const base = containRect(stage.width, stage.height, source.width, source.height);
  if (!base) return fitView(source);
  const w = Math.max(1, box[2] - box[0]) * margin, h = Math.max(1, box[3] - box[1]) * margin;
  const zoom = Math.min(stage.width / w, stage.height / h) / base.scale;
  return clampView({ zoom, cx: (box[0] + box[2]) / 2, cy: (box[1] + box[3]) / 2 }, source);
}

export const zoomPercent = (view: View) => Math.round(view.zoom * 100);
