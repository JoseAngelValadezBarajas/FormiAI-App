import { useEffect, useRef, type PointerEvent } from 'react';
import type { Shown } from '../observatory/correctionsModel';
import { centerOn, visibleRect, type Size, type Stage, type View } from './viewport';

const WIDTH = 200;
const css = (element: Element, name: string, fallback: string) => getComputedStyle(element).getPropertyValue(name).trim() || fallback;

/** Where the stage is looking inside the whole frame. Dragging it moves the view. Only shown while zoomed in. */
export function Minimap({ source, stage, view, shown, onView }: { source: Size; stage: Stage; view: View; shown: Shown[]; onView: (view: View) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const height = Math.round((WIDTH * source.height) / source.width);
  const dragging = useRef(false);

  useEffect(() => {
    const layer = canvas.current;
    const context = layer?.getContext('2d');
    if (!layer || !context) return;
    const ratio = window.devicePixelRatio || 1;
    layer.width = WIDTH * ratio; layer.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, WIDTH, height);
    const k = WIDTH / source.width;
    const accent = css(layer, '--cf-v2-primary', '#67dbb4');
    const danger = css(layer, '--cf-v2-error', '#ffb4aa');
    const warn = css(layer, '--cf-v2-warning', '#eac080');
    const added = css(layer, '--cf-v2-info', '#a9c7ff');
    shown.forEach(item => {
      context.strokeStyle = item.status === 'rejected' ? danger : item.status === 'adjusted' ? warn : item.status === 'added' ? added : accent;
      context.lineWidth = 1;
      const [x1, y1, x2, y2] = item.box;
      context.strokeRect(x1 * k, y1 * k, Math.max(2, (x2 - x1) * k), Math.max(2, (y2 - y1) * k));
    });
    const rect = visibleRect(view, stage, source);
    if (rect) {
      context.fillStyle = `color-mix(in srgb, ${warn} 18%, transparent)`;
      context.strokeStyle = warn;
      context.lineWidth = 1.5;
      context.fillRect(rect[0] * k, rect[1] * k, (rect[2] - rect[0]) * k, (rect[3] - rect[1]) * k);
      context.strokeRect(rect[0] * k, rect[1] * k, (rect[2] - rect[0]) * k, (rect[3] - rect[1]) * k);
    }
  });

  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onView(centerOn(view, ((event.clientX - rect.left) / rect.width) * source.width, ((event.clientY - rect.top) / rect.height) * source.height, source));
  };
  return (
    <canvas
      ref={canvas} className="ann-minimap" aria-label="Minimapa: arrastre para mover la vista" style={{ width: WIDTH, height }}
      onPointerDown={event => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); move(event); }}
      onPointerMove={event => { if (dragging.current) move(event); }}
      onPointerUp={() => { dragging.current = false; }}
      onPointerCancel={() => { dragging.current = false; }}
    />
  );
}
