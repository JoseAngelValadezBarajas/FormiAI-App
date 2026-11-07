import { useCallback, useEffect, useRef, useState } from 'react';
import type { Annotation, Box, ModelBox } from './correctionsModel';

export type ReviewSource = { name: string; sha256: string; width: number; height: number; fps: number; frame_count: number; verified: boolean };
export type ReviewData = {
  source: ReviewSource; confidence_floor: number; model: { id: string; label: string; experimental: boolean; confidence: number } | null;
  frames: ModelBox[][];
};
type RawBox = [number, number, number, number, number, number | null];
type RawReview = Omit<ReviewData, 'frames'> & { frames: RawBox[][] };
// The server sends boxes as compact arrays; the rest of the app works with named fields.
const decode = (raw: RawReview): ReviewData => ({
  ...raw,
  frames: raw.frames.map(frame => frame.map(([x1, y1, x2, y2, confidence, track_id]) => ({ bbox: [x1, y1, x2, y2] as Box, confidence, track_id }))),
});
export type QueueItem = { frame_index: number; reason: string; score: number };
export type Strategy = 'uncertain' | 'coverage';
export type ExportManifest = { export_id: string; created_at: string; counts: Record<string, number>; files: Record<string, { sha256: string; bytes: number }> };
type Undo = { label: string; run: () => Promise<unknown> };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).detail; } catch { detail = await response.text().catch(() => ''); }
    throw new Error(typeof detail === 'string' && detail ? detail : `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/**
 * Loads one session's reviewable analysis and keeps the reviewer's annotations in step with the server.
 * The server is the source of truth: every action is sent first and the local list only changes with its answer,
 * so what is on screen is always what would be exported. Undo is built from server calls too.
 */
export function useCorrections(sessionId: string) {
  const base = `/api/sessions/${sessionId}`;
  const [review, setReview] = useState<ReviewData>();
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [complete, setComplete] = useState<Set<number>>(new Set());
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [strategy, setStrategy] = useState<Strategy>('uncertain');
  const [exported, setExported] = useState<ExportManifest[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [undoDepth, setUndoDepth] = useState(0);
  const undo = useRef<Undo[]>([]);

  const track = (items: Undo[]) => { undo.current = items; setUndoDepth(items.length); };
  const push = (item: Undo) => track([...undo.current, item].slice(-50));
  const refreshState = useCallback(async () => {
    const state = await call<{ annotations: Annotation[]; complete_frames: number[] }>(`${base}/review/state`);
    setAnnotations(state.annotations);
    setComplete(new Set(state.complete_frames));
  }, [base]);
  const refreshQueue = useCallback(async (which: Strategy) => {
    setQueue((await call<{ frames: QueueItem[] }>(`${base}/review/queue?strategy=${which}&limit=50`)).frames);
  }, [base]);

  useEffect(() => {
    let active = true;
    setReview(undefined); setAnnotations([]); setQueue([]); setError(''); track([]);
    Promise.all([call<RawReview>(`${base}/review`).then(decode), call<{ annotations: Annotation[]; complete_frames: number[] }>(`${base}/review/state`),
      call<{ frames: QueueItem[] }>(`${base}/review/queue?strategy=uncertain&limit=50`), call<{ exports: ExportManifest[] }>(`${base}/exports`)])
      .then(([data, state, q, ex]) => {
        if (!active) return;
        setReview(data); setAnnotations(state.annotations); setComplete(new Set(state.complete_frames)); setQueue(q.frames); setExported(ex.exports);
      }).catch(reason => { if (active) setError(String(reason.message ?? reason)); });
    return () => { active = false; };
  }, [base]);

  // Actions run strictly one after another, in the order they were requested: rapid keystrokes must neither
  // interleave their server round-trips nor be dropped while an earlier one is still in flight.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const act = useCallback(<T,>(work: () => Promise<T>): Promise<T | undefined> => {
    pending.current += 1; setBusy(true);
    const run = chain.current.then(async () => {
      setError('');
      try { return await work(); } catch (reason) { setError((reason as Error).message); return undefined; }
    }).finally(() => { pending.current -= 1; if (pending.current === 0) setBusy(false); });
    chain.current = run;
    return run;
  }, []);

  const create = (body: { kind: Annotation['kind']; frame_index: number; target?: { bbox: Box }; bbox?: Box }) => act(async () => {
    const made = await call<Annotation>(`${base}/corrections`, json('POST', body));
    await refreshState();
    push({ label: `deshacer ${body.kind}`, run: async () => { await call(`${base}/corrections/${made.id}`, { method: 'DELETE' }); await refreshState(); } });
    return made;
  });
  const move = (annotation: Annotation, bbox: Box) => act(async () => {
    const before = annotation.bbox;
    await call(`${base}/corrections/${annotation.id}`, json('PATCH', { bbox }));
    await refreshState();
    if (before) push({ label: 'deshacer movimiento', run: async () => { await call(`${base}/corrections/${annotation.id}`, json('PATCH', { bbox: before })); await refreshState(); } });
  });
  const remove = (annotation: Annotation) => act(async () => {
    await call(`${base}/corrections/${annotation.id}`, { method: 'DELETE' });
    await refreshState();
    push({ label: 'deshacer borrado', run: async () => { await call(`${base}/corrections/${annotation.id}/restore`, { method: 'POST' }); await refreshState(); } });
  });
  const setFrameComplete = (frame: number, value: boolean) => act(async () => {
    await call(`${base}/review/frames/${frame}/complete`, json('PUT', { complete: value }));
    await refreshState();
    push({ label: 'deshacer frame completo', run: async () => { await call(`${base}/review/frames/${frame}/complete`, json('PUT', { complete: !value })); await refreshState(); } });
    await refreshQueue(strategy);
  });
  const undoLast = () => act(async () => {
    const last = undo.current[undo.current.length - 1];
    if (!last) return;
    await last.run();
    track(undo.current.slice(0, -1));
  });
  const chooseStrategy = (which: Strategy) => act(async () => { setStrategy(which); await refreshQueue(which); });
  const exportNow = () => act(async () => {
    const manifest = await call<ExportManifest>(`${base}/exports`, { method: 'POST' });
    setExported(list => [...list, manifest]);
    return manifest;
  });

  return { review, annotations, complete, queue, strategy, exported, error, busy, canUndo: undoDepth > 0, create, move, remove, setFrameComplete, undoLast, chooseStrategy, exportNow, refreshQueue: () => refreshQueue(strategy) };
}
