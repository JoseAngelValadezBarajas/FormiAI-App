// Pure geometry and bookkeeping for the correction tool. Boxes are [x1, y1, x2, y2] in SOURCE-VIDEO pixels;
// the screen is only ever a projection of them through the video's object-fit: contain rectangle.
export type Box = [number, number, number, number];
export type ModelBox = { bbox: Box; confidence: number; track_id: number | null };
export type Annotation = {
  id: string; frame_index: number; kind: 'confirm' | 'reject' | 'adjust' | 'add';
  target: { bbox: Box; confidence: number; track_id: number | null } | null; bbox: Box | null;
};
export type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'move';
export type Projection = { x: number; y: number; scale: number };
export type Shown = {
  key: string; box: Box; origin: Box | null; status: 'untouched' | 'confirmed' | 'rejected' | 'adjusted' | 'added';
  annotationId: string | null; model: ModelBox | null;
};

export const MIN_BOX = 4;
export const frameCenterTime = (frame: number, fps: number) => (frame + 0.5) / fps;
export const boxKey = (box: Box) => box.map(v => v.toFixed(3)).join(',');
export const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export const toScreen = (p: Projection, [x1, y1, x2, y2]: Box): Box => [p.x + x1 * p.scale, p.y + y1 * p.scale, p.x + x2 * p.scale, p.y + y2 * p.scale];
export const toVideo = (p: Projection, x: number, y: number): [number, number] => [(x - p.x) / p.scale, (y - p.y) / p.scale];

export const normalize = (x1: number, y1: number, x2: number, y2: number): Box => [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
export const area = ([x1, y1, x2, y2]: Box) => Math.max(0, x2 - x1) * Math.max(0, y2 - y1);

/** What the reviewer sees for one frame: model boxes with their decision applied, plus boxes they added. */
export function shownBoxes(frame: ModelBox[], annotations: Annotation[]): Shown[] {
  const byTarget = new Map(annotations.filter(a => a.target).map(a => [boxKey(a.target!.bbox), a]));
  const shown: Shown[] = frame.map(model => {
    const action = byTarget.get(boxKey(model.bbox));
    if (!action) return { key: `m:${boxKey(model.bbox)}`, box: model.bbox, origin: null, status: 'untouched', annotationId: null, model };
    if (action.kind === 'adjust' && action.bbox) return { key: `m:${boxKey(model.bbox)}`, box: action.bbox, origin: model.bbox, status: 'adjusted', annotationId: action.id, model };
    return { key: `m:${boxKey(model.bbox)}`, box: model.bbox, origin: null, status: action.kind === 'reject' ? 'rejected' : 'confirmed', annotationId: action.id, model };
  });
  annotations.filter(a => a.kind === 'add' && a.bbox).forEach(a => shown.push({ key: `a:${a.id}`, box: a.bbox!, origin: null, status: 'added', annotationId: a.id, model: null }));
  return shown;
}

/** Topmost box under a point; when boxes overlap, the smallest one wins so small ants stay reachable. */
export function hitTest(boxes: Shown[], x: number, y: number): Shown | undefined {
  return boxes.filter(({ box: [x1, y1, x2, y2] }) => x >= x1 && x <= x2 && y >= y1 && y <= y2).sort((a, b) => area(a.box) - area(b.box))[0];
}

export function handleAt(box: Box, x: number, y: number, tolerance: number): Handle | null {
  const [x1, y1, x2, y2] = box;
  const near = (a: number, b: number) => Math.abs(a - x) <= tolerance && Math.abs(b - y) <= tolerance;
  if (near(x1, y1)) return 'nw';
  if (near(x2, y1)) return 'ne';
  if (near(x1, y2)) return 'sw';
  if (near(x2, y2)) return 'se';
  return x >= x1 && x <= x2 && y >= y1 && y <= y2 ? 'move' : null;
}

/** Move or resize a box by (dx, dy) video pixels without leaving the frame or collapsing below MIN_BOX. */
export function drag(box: Box, handle: Handle, dx: number, dy: number, width: number, height: number): Box {
  let [x1, y1, x2, y2] = box;
  if (handle === 'move') {
    const w = x2 - x1, h = y2 - y1;
    x1 = clamp(x1 + dx, 0, width - w); y1 = clamp(y1 + dy, 0, height - h);
    return [x1, y1, x1 + w, y1 + h];
  }
  if (handle === 'nw' || handle === 'sw') x1 = clamp(x1 + dx, 0, x2 - MIN_BOX); else x2 = clamp(x2 + dx, x1 + MIN_BOX, width);
  if (handle === 'nw' || handle === 'ne') y1 = clamp(y1 + dy, 0, y2 - MIN_BOX); else y2 = clamp(y2 + dy, y1 + MIN_BOX, height);
  return [x1, y1, x2, y2];
}

/** A drawn rectangle becomes a box only if it stays inside the frame and is large enough. */
export function drawn(startX: number, startY: number, endX: number, endY: number, width: number, height: number): Box | null {
  const [x1, y1, x2, y2] = normalize(clamp(startX, 0, width), clamp(startY, 0, height), clamp(endX, 0, width), clamp(endY, 0, height));
  return x2 - x1 >= MIN_BOX && y2 - y1 >= MIN_BOX ? [x1, y1, x2, y2] : null;
}

export const stepFrame = (frame: number, delta: number, frameCount: number) => clamp(frame + delta, 0, Math.max(0, frameCount - 1));

export function neighbour(queue: { frame_index: number }[], frame: number, direction: 1 | -1): number | undefined {
  const frames = queue.map(item => item.frame_index).sort((a, b) => a - b);
  return direction === 1 ? frames.find(value => value > frame) : [...frames].reverse().find(value => value < frame);
}

export function summary(annotations: Annotation[]) {
  const counts = { confirm: 0, reject: 0, adjust: 0, add: 0 };
  annotations.forEach(a => { counts[a.kind] += 1; });
  return counts;
}
