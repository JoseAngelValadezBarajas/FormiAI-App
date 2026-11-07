import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { trackLabel } from '../observatory/model';
import {
  drag, drawn, frameCenterTime, handleAt, hitTest, toScreen, toVideo,
  type Box, type Handle, type Shown,
} from '../observatory/correctionsModel';
import { ZOOM_STEP, panBy, project, zoomAt, type Size, type Stage as StageSize, type View } from './viewport';

export type Tool = 'select' | 'add' | 'pan' | 'zoom';

type Draft =
  | { kind: 'draw'; start: [number, number]; box: Box | null }
  | { kind: 'drag'; handle: Handle; start: [number, number]; shown: Shown; box: Box; moved: boolean }
  | { kind: 'pan'; x: number; y: number };

const css = (element: Element, name: string, fallback: string) => getComputedStyle(element).getPropertyValue(name).trim() || fallback;
const HANDLE_PX = 9;
const idLabel = (track: number | null) => (track === null ? 'sin P-ID' : trackLabel(track));

export type StageProps = {
  videoUrl: string;
  source: Size & { fps: number };
  /** The frame being asked for. The overlay is only ever drawn for `shownFrame`, the one the browser reports. */
  frame: number;
  shownFrame: number;
  onShownFrame: (frame: number) => void;
  shown: Shown[];
  selectedKey: string | null;
  tool: Tool;
  /** Space held: the picture is dragged whatever the tool. */
  spaceHeld: boolean;
  editable: boolean;
  showBoxes: boolean;
  showIds: boolean;
  view: View;
  onView: (view: View) => void;
  onSize: (size: StageSize) => void;
  onSelect: (key: string | null) => void;
  onAdjust: (item: Shown, box: Box) => void | Promise<void>;
  onAdd: (box: Box) => void | Promise<void>;
  children?: ReactNode;
};

/**
 * The clean source video and the box overlay, placed from one projection that the zoom and pan change. Corrections
 * happen on a paused, exactly known frame, so there is no playback: the frame is reached by seeking to its centre.
 */
export function Stage(props: StageProps) {
  const { videoUrl, source, frame, shownFrame, onShownFrame, shown, selectedKey, tool, spaceHeld, editable, showBoxes, showIds, view, onView, onSize, onSelect, onAdjust, onAdd, children } = props;
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<StageSize>({ width: 0, height: 0 });
  const [draft, setDraftState] = useState<Draft | null>(null);
  // The gesture also lives in a ref: pointer events can arrive faster than React re-renders, and pointerup must
  // see the last pointermove, not the last rendered state.
  const gesture = useRef<Draft | null>(null);
  const setDraft = (next: Draft | null) => { gesture.current = next; setDraftState(next); };
  const latest = useRef({ view, size, source });
  latest.current = { view, size, source };

  const ready = shownFrame === frame && shownFrame >= 0;
  const visibleBoxes = useMemo(() => (showBoxes ? shown : []), [showBoxes, shown]);
  const selected = visibleBoxes.find(item => item.key === selectedKey);
  const p = useMemo(() => project(view, size, source), [view, size, source]);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      // The inner box: the video and the canvas are positioned inside the border, so the border must not count.
      // The canvas fills that inner box exactly and, unlike clientWidth, reports fractional sizes (kept to a hundredth).
      const rect = (canvas.current ?? element).getBoundingClientRect();
      const next = { width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100 };
      setSize(current => (current.width === next.width && current.height === next.height ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { onSize(size); }, [size, onSize]);

  useEffect(() => {
    const element = video.current;
    if (!element || !source.fps) return;
    element.pause();
    element.currentTime = frameCenterTime(frame, source.fps);
  }, [frame, source.fps]);
  // Leaving a frame drops any half-made gesture.
  useEffect(() => { setDraft(null); }, [frame]);

  // The wheel zooms around the pointer. React attaches wheel listeners as passive, so this one is native.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = (canvas.current ?? element).getBoundingClientRect();
      const { view: current, size: stage, source: src } = latest.current;
      const factor = Math.exp(-event.deltaY * 0.0015);
      onView(zoomAt(current, factor, { x: event.clientX - rect.left, y: event.clientY - rect.top }, stage, src));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [onView]);

  const draw = () => {
    const layer = canvas.current;
    const context = layer?.getContext('2d');
    if (!layer || !context || !p) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(size.width * ratio), height = Math.round(size.height * ratio);
    if (layer.width !== width || layer.height !== height) { layer.width = width; layer.height = height; }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    layer.dataset.frame = String(shownFrame);
    layer.dataset.ready = String(ready);
    layer.dataset.zoom = view.zoom.toFixed(3);
    const accent = css(layer, '--cf-v2-primary', '#67dbb4');
    const danger = css(layer, '--cf-v2-error', '#ffb4aa');
    const warn = css(layer, '--cf-v2-warning', '#eac080');
    const added = css(layer, '--cf-v2-info', '#a9c7ff');
    const surface = css(layer, '--cf-v2-surface', '#111d20');
    const muted = css(layer, '--cf-v2-outline', '#a0adb1');
    context.font = '600 10px Inter, system-ui, sans-serif';
    const stroke = (b: Box, color: string, dashed: boolean, widthPx: number) => {
      const [x1, y1, x2, y2] = toScreen(p, b);
      context.setLineDash(dashed ? [5, 4] : []);
      context.strokeStyle = color;
      context.lineWidth = widthPx;
      context.strokeRect(x1, y1, x2 - x1, y2 - y1);
      context.setLineDash([]);
      return [x1, y1, x2, y2] as Box;
    };
    const label = (b: Box, text: string, color: string) => {
      const widthPx = context.measureText(text).width + 8;
      const top = Math.max(0, b[1] - 14);
      context.fillStyle = surface;
      context.fillRect(b[0], top, widthPx, 14);
      context.fillStyle = color;
      context.fillText(text, b[0] + 4, top + 10.5);
    };
    visibleBoxes.forEach(item => {
      const live = draft?.kind === 'drag' && draft.shown.key === item.key ? draft.box : item.box;
      const isSelected = item.key === selectedKey;
      if (item.origin) stroke(item.origin, muted, true, 1);
      const color = item.status === 'rejected' ? danger : item.status === 'adjusted' ? warn : item.status === 'added' ? added : accent;
      const screenBox = stroke(live, color, item.status === 'rejected', isSelected ? 2.6 : 1.6);
      if (showIds || isSelected) {
        const tag = item.model ? `${idLabel(item.model.track_id)} ${(item.model.confidence * 100).toFixed(0)}%` : 'AÑADIDA';
        const mark = item.status === 'confirmed' ? ' ✓' : item.status === 'rejected' ? ' ✗' : item.status === 'adjusted' ? ' ↔' : '';
        label(screenBox, tag + mark, color);
      }
      if (item.status === 'rejected') {
        context.strokeStyle = danger; context.lineWidth = 1;
        context.beginPath(); context.moveTo(screenBox[0], screenBox[1]); context.lineTo(screenBox[2], screenBox[3]); context.stroke();
      }
      if (isSelected && item.status !== 'rejected') {
        context.fillStyle = color;
        ([[screenBox[0], screenBox[1]], [screenBox[2], screenBox[1]], [screenBox[0], screenBox[3]], [screenBox[2], screenBox[3]]]).forEach(([hx, hy]) => context.fillRect(hx - 3.5, hy - 3.5, 7, 7));
      }
    });
    if (draft?.kind === 'draw' && draft.box) stroke(draft.box, added, true, 1.6);
  };
  useEffect(() => draw());

  const local = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = canvas.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const toPoint = (event: PointerEvent<HTMLCanvasElement>): [number, number] | undefined => {
    if (!p) return undefined;
    const at = local(event);
    return toVideo(p, at.x, at.y);
  };

  const onDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!p || !ready) return;
    const wantsPan = event.button === 1 || tool === 'pan' || spaceHeld;
    if (event.button !== 0 && event.button !== 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (wantsPan) { event.preventDefault(); setDraft({ kind: 'pan', x: event.clientX, y: event.clientY }); return; }
    if (tool === 'zoom') {
      const at = local(event);
      onView(zoomAt(view, event.shiftKey || event.altKey ? 1 / ZOOM_STEP ** 2 : ZOOM_STEP ** 2, at, size, source));
      return;
    }
    const at = toPoint(event);
    if (!at || !editable) return;
    if (tool === 'add') { onSelect(null); setDraft({ kind: 'draw', start: at, box: null }); return; }
    if (selected && selected.status !== 'rejected') {
      const handle = handleAt(selected.box, at[0], at[1], HANDLE_PX / p.scale);
      if (handle) { setDraft({ kind: 'drag', handle, start: at, shown: selected, box: selected.box, moved: false }); return; }
    }
    const hit = hitTest(visibleBoxes, at[0], at[1]);
    onSelect(hit?.key ?? null);
    if (hit && hit.status !== 'rejected') setDraft({ kind: 'drag', handle: 'move', start: at, shown: hit, box: hit.box, moved: false });
  };

  const onMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = gesture.current;
    if (!current) return;
    if (current.kind === 'pan') {
      onView(panBy(latest.current.view, event.clientX - current.x, event.clientY - current.y, latest.current.size, latest.current.source));
      setDraft({ kind: 'pan', x: event.clientX, y: event.clientY });
      return;
    }
    const at = toPoint(event);
    if (!at || !p) return;
    if (current.kind === 'draw') setDraft({ ...current, box: drawn(current.start[0], current.start[1], at[0], at[1], source.width, source.height) });
    else {
      const next = drag(current.shown.box, current.handle, at[0] - current.start[0], at[1] - current.start[1], source.width, source.height);
      setDraft({ ...current, box: next, moved: current.moved || Math.hypot(at[0] - current.start[0], at[1] - current.start[1]) * p.scale > 3 });
    }
  };

  const onUp = async () => {
    const current = gesture.current;
    setDraft(null);
    if (!current || current.kind === 'pan') return;
    if (current.kind === 'draw') { if (current.box) await onAdd(current.box); return; }
    if (current.moved) await onAdjust(current.shown, current.box);
  };

  const mode = spaceHeld || tool === 'pan' ? 'pan' : tool;
  return (
    <div ref={box} className={`ann-stage is-${mode}${draft?.kind === 'pan' ? ' is-panning' : ''}${p && p.scale >= 3 ? ' is-pixelated' : ''}`} data-testid="stage">
      <video
        ref={video} src={videoUrl} muted preload="auto" playsInline
        style={p ? { left: p.x, top: p.y, width: source.width * p.scale, height: source.height * p.scale } : { visibility: 'hidden' }}
        onLoadedMetadata={() => { if (video.current && source.fps) video.current.currentTime = frameCenterTime(frame, source.fps); }}
        onSeeked={() => { if (video.current && source.fps) onShownFrame(Math.floor(video.current.currentTime * source.fps + 1e-6)); }}
      />
      <canvas
        ref={canvas} aria-label="Cajas de detección editables"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => void onUp()} onPointerCancel={() => setDraft(null)}
        onContextMenu={event => event.preventDefault()}
      />
      {children}
    </div>
  );
}
