// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProgressiveFrame } from '../progress';
import { useProgressiveStream } from './useProgressiveStream';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners: Record<string, ((event: MessageEvent) => void)[]> = {};
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: (event: MessageEvent) => void) { (this.listeners[type] ??= []).push(listener); }
  close() { this.closed = true; }
  emit(type: string, payload: unknown) {
    (this.listeners[type] ?? []).forEach(listener => listener(new MessageEvent(type, { data: JSON.stringify(payload) })));
  }
}

const frame = (index: number): ProgressiveFrame => ({
  frame_index: index,
  timestamp_seconds: index / 10,
  detections: [{ bbox: [0, 0, 1, 1], confidence: 0.9, track_id: 1 }],
});
const batch = (sequence: number, from: number, to: number) => ({
  sequence, fps: 10, frame_count: 100, processed_through_frame: to,
  frames: Array.from({ length: to - from + 1 }, (_, offset) => frame(from + offset)),
});
const initial = { fps: 10, frame_count: 100, processed_through_frame: 59, batch_count: 6 };
const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

beforeEach(() => { FakeEventSource.instances = []; (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource; });
afterEach(() => { delete (globalThis as { EventSource?: unknown }).EventSource; });

describe('useProgressiveStream', () => {
  it('does not count server-side progress as locally available frames', () => {
    const { result } = renderHook(() => useProgressiveStream('a', initial, () => {}));
    expect(result.current.progress.processed_through_frame).toBe(-1);
    act(() => latest().emit('progress', { fps: 10, frame_count: 100, processed_through_frame: 80, batch_count: 8 }));
    expect(result.current.progress.processed_through_frame).toBe(-1);
    expect(result.current.progress.frame_count).toBe(100);
    act(() => latest().emit('detections', batch(1, 0, 9)));
    expect(result.current.progress.processed_through_frame).toBe(9);
    expect(result.current.frames.size).toBe(10);
  });

  it('discards the previous job state and ignores late events from its stream', () => {
    const { result, rerender } = renderHook(({ id }) => useProgressiveStream(id, initial, () => {}), { initialProps: { id: 'a' } });
    const first = latest();
    act(() => first.emit('detections', batch(1, 0, 9)));
    expect(result.current.frames.size).toBe(10);

    rerender({ id: 'b' });
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(result.current.frames.size).toBe(0);
    expect(result.current.progress.processed_through_frame).toBe(-1);
    expect(result.current.progress.batch_count).toBe(0);

    act(() => first.emit('detections', batch(2, 10, 19)));
    expect(result.current.frames.size).toBe(0);

    act(() => latest().emit('detections', batch(1, 0, 4)));
    expect(result.current.frames.size).toBe(5);
    expect(result.current.progress.processed_through_frame).toBe(4);
  });

  it('reports a gap without advancing the received watermark', () => {
    const { result } = renderHook(() => useProgressiveStream('a', initial, () => {}));
    act(() => latest().emit('detections', batch(1, 0, 9)));
    act(() => latest().emit('detections', batch(3, 20, 29)));
    expect(result.current.gap).toBe(true);
    expect(result.current.progress.processed_through_frame).toBe(9);
    expect(result.current.progress.batch_count).toBe(1);
    // The gapped batch is rejected: its frames never become playable.
    expect(result.current.frames.size).toBe(10);
    expect(result.current.frames.has(20)).toBe(false);
  });

  it('does not let a replayed batch overwrite stored frames', () => {
    const { result } = renderHook(() => useProgressiveStream('a', initial, () => {}));
    act(() => latest().emit('detections', batch(1, 0, 9)));
    const stored = result.current.frames.get(0);
    const altered = { ...batch(1, 0, 9), frames: [{ ...frame(0), detections: [] }] };
    act(() => latest().emit('detections', altered));
    expect(result.current.frames.get(0)).toBe(stored);
    expect(result.current.frames.size).toBe(10);
  });

  it('keeps the screen mounted on completion after a gap and exposes the session', () => {
    const completed: string[] = [];
    const { result } = renderHook(() => useProgressiveStream('a', initial, session => completed.push(session)));
    act(() => latest().emit('detections', batch(1, 0, 9)));
    act(() => latest().emit('detections', batch(3, 20, 29)));
    act(() => latest().emit('complete', { session_id: 's1' }));
    expect(completed).toEqual([]);
    expect(result.current.gap).toBe(true);
    expect(result.current.completedSession).toBe('s1');
  });

  it('keeps counters stable when a batch is replayed', () => {
    const { result } = renderHook(() => useProgressiveStream('a', initial, () => {}));
    act(() => latest().emit('detections', batch(1, 0, 9)));
    act(() => latest().emit('detections', batch(2, 10, 19)));
    act(() => latest().emit('detections', batch(1, 0, 9)));
    expect(result.current.gap).toBe(false);
    expect(result.current.progress.processed_through_frame).toBe(19);
    expect(result.current.progress.batch_count).toBe(2);
  });

  it('does not reopen the stream when the completion callback changes identity', () => {
    const { rerender } = renderHook(({ done }) => useProgressiveStream('a', initial, done), { initialProps: { done: () => {} } });
    rerender({ done: () => {} });
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('reports completion once and only for the active job', () => {
    const completed: string[] = [];
    const { rerender } = renderHook(({ id }) => useProgressiveStream(id, initial, session => completed.push(session)), { initialProps: { id: 'a' } });
    const first = latest();
    rerender({ id: 'b' });
    act(() => first.emit('complete', { session_id: 'stale' }));
    act(() => latest().emit('complete', { session_id: 'fresh' }));
    expect(completed).toEqual(['fresh']);
  });

  it('surfaces a failed analysis and stops reconnecting, but ignores bare connection errors', () => {
    const { result } = renderHook(() => useProgressiveStream('a', initial, () => {}));
    const source = latest();
    act(() => { source.listeners.error?.forEach(listener => listener(new Event('error') as MessageEvent)); });
    expect(result.current.failure).toBeUndefined();
    expect(source.closed).toBe(false);
    act(() => source.emit('error', { message: 'uv could not build formicai' }));
    expect(result.current.failure).toBe('uv could not build formicai');
    expect(result.current.connected).toBe(false);
    expect(source.closed).toBe(true);
  });

  it('reports a cancelled analysis and closes the stream', () => {
    const { result } = renderHook(() => useProgressiveStream('a', initial, () => {}));
    act(() => latest().emit('cancelled', { id: 'a', status: 'cancelled' }));
    expect(result.current.cancelled).toBe(true);
    expect(result.current.connected).toBe(false);
    expect(latest().closed).toBe(true);
  });
});
