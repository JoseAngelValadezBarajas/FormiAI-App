import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatClock } from '../observatory/model';
import { frameAt, frameX, markWidth, type Lanes } from './timelineModel';

const css = (element: Element, name: string, fallback: string) => getComputedStyle(element).getPropertyValue(name).trim() || fallback;
const ROW = 22, GAP = 8, HEIGHT = ROW * 3 + GAP * 2;
const LABELS = ['Frames completos', 'Con correcciones', 'Cola de revisión'];

/** Three lanes over the whole video (completed, corrected, queued) and a playhead; click or drag to seek. */
export function Timeline({ frameCount, fps, frame, lanes, onSeek }: { frameCount: number; fps: number; frame: number; lanes: Lanes; onSeek: (frame: number) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const dragging = useRef(false);

  useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const measure = () => setWidth(Math.round(element.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const layer = canvas.current;
    const context = layer?.getContext('2d');
    if (!layer || !context || width <= 0) return;
    const ratio = window.devicePixelRatio || 1;
    layer.width = width * ratio; layer.height = HEIGHT * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, HEIGHT);
    const track = css(layer, '--cf-v2-surface-container', '#263235');
    const accent = css(layer, '--cf-v2-primary', '#67dbb4');
    const warn = css(layer, '--cf-v2-warning', '#eac080');
    const info = css(layer, '--cf-v2-info', '#a9c7ff');
    for (let lane = 0; lane < 3; lane++) {
      context.fillStyle = track;
      context.beginPath(); context.roundRect(0, lane * (ROW + GAP), width, ROW, 4); context.fill();
    }
    context.fillStyle = accent;
    lanes.complete.forEach(([start, end]) => {
      const x = frameX(start, width, frameCount);
      context.fillRect(x, 0, Math.max(2, frameX(end + 1, width, frameCount) - x), ROW);
    });
    context.fillStyle = warn;
    const mark = markWidth(width, frameCount);
    lanes.corrected.forEach(f => context.fillRect(frameX(f, width, frameCount), ROW + GAP, mark, ROW));
    context.fillStyle = info;
    lanes.queue.forEach(f => { context.beginPath(); context.arc(frameX(f, width, frameCount) + mark / 2, 2 * (ROW + GAP) + ROW / 2, 4.5, 0, Math.PI * 2); context.fill(); });
    const x = frameX(frame, width, frameCount) + markWidth(width, frameCount) / 2;
    context.fillStyle = warn;
    context.fillRect(x - 1, -2, 2, HEIGHT + 2);
    context.beginPath(); context.arc(x, 0, 4, 0, Math.PI * 2); context.fill();
  }, [width, frameCount, frame, lanes]);

  const seek = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onSeek(frameAt(event.clientX - rect.left, rect.width, frameCount));
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    // Arrow keys step the frame (handled globally) so only Home and End are local here.
    if (event.key === 'Home') { event.preventDefault(); onSeek(0); }
    else if (event.key === 'End') { event.preventDefault(); onSeek(frameCount - 1); }
  };
  const axis = [0, 1 / 3, 2 / 3, 1].map(ratio => formatClock((frameCount / fps) * ratio));

  return (
    <div className="ann-timeline">
      <ul className="ann-lane-labels" aria-hidden="true">{LABELS.map(label => <li key={label}>{label}</li>)}</ul>
      <div
        role="slider" tabIndex={0} aria-label="Posición en el video" aria-valuemin={0} aria-valuemax={Math.max(0, frameCount - 1)} aria-valuenow={frame}
        aria-valuetext={`Frame ${frame}, ${formatClock(frame / fps)}`} className="ann-lanes" onKeyDown={onKey} ref={wrap}
      >
        <canvas
          ref={canvas} style={{ width: '100%', height: HEIGHT }} data-testid="timeline-canvas"
          onPointerDown={event => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); seek(event); }}
          onPointerMove={event => { if (dragging.current) seek(event); }}
          onPointerUp={() => { dragging.current = false; }}
          onPointerCancel={() => { dragging.current = false; }}
        />
        <div className="ann-axis" aria-hidden="true">{axis.map((text, index) => <span key={index}>{text}</span>)}</div>
      </div>
    </div>
  );
}
