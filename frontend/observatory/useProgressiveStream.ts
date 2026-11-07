import { useEffect, useRef, useState } from 'react';
import type { ProgressiveFrame } from '../progress';
import { acceptBatch, observedRate, type RateSample, type ReceivedState } from './model';

export type ProgressState = { fps?: number; frame_count?: number; processed_through_frame: number; batch_count: number };
type Job = { session_id?: string };
type State = {
  jobId: string;
  frames: Map<number, ProgressiveFrame>;
  progress: ProgressState;
  connected: boolean;
  gap: boolean;
  rate?: number;
  completedSession?: string;
  failure?: string;
  cancelled?: boolean;
};

// A job starts with nothing received. The server-side progress in `initial` only supplies fps and
// frame_count; it never counts as locally available frames.
const fresh = (jobId: string, initial: ProgressState): State => ({
  jobId,
  frames: new Map(),
  progress: { fps: initial.fps, frame_count: initial.frame_count, processed_through_frame: -1, batch_count: 0 },
  connected: false,
  gap: false,
});

/**
 * Owns the job's SSE connection and everything received through it. State is bound to `jobId`: a
 * different job renders as empty immediately, and events from a superseded stream are discarded.
 * Frames are keyed by their scientific frame_index and are never interpolated. `done` is read through
 * a ref so a new callback identity never reopens the stream.
 */
export function useProgressiveStream(jobId: string, initial: ProgressState, done: (sessionId: string) => void) {
  const [state, setState] = useState(() => fresh(jobId, initial));
  const view = state.jobId === jobId ? state : fresh(jobId, initial);
  const onDone = useRef(done);
  onDone.current = done;
  const initialRef = useRef(initial);
  initialRef.current = initial;

  useEffect(() => {
    let active = true;
    let received: ReceivedState = { through: -1, sequence: 0 };
    let gapSeen = false;
    const samples: { first?: RateSample; last?: RateSample } = {};
    const update = (change: (old: State) => State) => {
      if (active) setState(old => (old.jobId === jobId ? change(old) : old));
    };
    setState(fresh(jobId, initialRef.current));
    const stream = new EventSource(`/api/jobs/${jobId}/events?after=-1`);
    const data = (event: Event) => JSON.parse((event as MessageEvent).data);
    stream.onopen = () => update(old => ({ ...old, connected: true }));
    stream.onerror = () => update(old => ({ ...old, connected: false }));
    // The server reports a failed analysis as a named `error` event WITH data; the browser's own connection
    // errors reach the same listener without data and must keep the reconnect behaviour.
    stream.addEventListener('error', event => {
      if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return;
      let message = 'The analysis failed.';
      try { message = (JSON.parse(event.data) as { message?: string }).message?.trim() || message; } catch { /* keep default */ }
      stream.close();
      update(old => ({ ...old, connected: false, failure: message }));
    });
    stream.addEventListener('progress', event => {
      const manifest = data(event);
      // Only fps and frame_count are taken: the server reports its own progress before replaying batches.
      update(old => ({ ...old, progress: { ...old.progress, fps: manifest.fps ?? old.progress.fps, frame_count: manifest.frame_count ?? old.progress.frame_count } }));
    });
    stream.addEventListener('detections', event => {
      const batch = data(event);
      const result = acceptBatch(received, batch);
      received = result.state;
      if (result.verdict === 'advanced') {
        const sample = { at: performance.now(), frame: received.through };
        samples.first ??= sample;
        samples.last = sample;
      }
      const rate = observedRate(samples.first, samples.last);
      const { through, sequence } = received;
      if (result.verdict === 'gap') gapSeen = true;
      // Only the next batch in sequence becomes playable. A replay never overwrites stored frames and a
      // gapped batch is rejected (not kept pending), so no frame is playable without its predecessors.
      update(old => {
        if (result.verdict !== 'advanced') return { ...old, gap: old.gap || result.verdict === 'gap' };
        const frames = new Map(old.frames);
        batch.frames.forEach((frame: ProgressiveFrame) => frames.set(frame.frame_index, frame));
        return {
          ...old,
          frames,
          rate,
          progress: { fps: batch.fps, frame_count: batch.frame_count, processed_through_frame: through, batch_count: sequence },
        };
      });
    });
    stream.addEventListener('cancelled', () => {
      stream.close();
      update(old => ({ ...old, connected: false, cancelled: true }));
    });
    stream.addEventListener('complete', event => {
      const job = data(event) as Job;
      stream.close();
      if (!job.session_id) return update(old => ({ ...old, connected: false }));
      // With a gap the screen stays mounted so the incident remains visible; the user opens Review.
      update(old => ({ ...old, connected: false, completedSession: gapSeen ? job.session_id : undefined }));
      if (active && !gapSeen) onDone.current(job.session_id);
    });
    return () => { active = false; stream.close(); };
  }, [jobId]);

  return { frames: view.frames, progress: view.progress, connected: view.connected, gap: view.gap, rate: view.rate, completedSession: view.completedSession, failure: view.failure, cancelled: view.cancelled };
}
