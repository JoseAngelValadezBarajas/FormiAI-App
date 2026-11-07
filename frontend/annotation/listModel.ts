export type SessionModel = { id: string; label: string; experimental: boolean; confidence: number } | null;
export type Counts = { confirm: number; reject: number; adjust: number; add: number };
export type SessionItem =
  | { id: string; status: string; reviewable: false; reason: string }
  | {
    id: string; status: string; reviewable: true;
    source: { name: string; sha256: string; width: number; height: number; fps: number; frame_count: number; verified: boolean };
    model: SessionModel; frame_count: number; counts: Counts; complete_frames: number;
    last_export: { export_id: string; created_at: string } | null; last_activity: string | null;
  };
export type ReviewableItem = Extract<SessionItem, { reviewable: true }>;

export type Filter = 'all' | 'corrected' | 'untouched' | 'unverified';
export const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'corrected', label: 'Con correcciones' },
  { id: 'untouched', label: 'Sin empezar' },
  { id: 'unverified', label: 'Video sin verificar' },
];

export const totalCorrections = (counts: Counts) => counts.confirm + counts.reject + counts.adjust + counts.add;
export const hasWork = (item: ReviewableItem) => totalCorrections(item.counts) > 0 || item.complete_frames > 0;
/** A session whose video cannot be confirmed (or has no reviewable analysis) can be read but never edited. */
export const isUnverified = (item: SessionItem) => !item.reviewable || !item.source.verified;

export function matches(item: SessionItem, filter: Filter, query: string): boolean {
  const text = query.trim().toLowerCase();
  const name = item.reviewable ? item.source.name : item.id;
  if (text && !`${name} ${item.id}`.toLowerCase().includes(text)) return false;
  if (filter === 'unverified') return isUnverified(item);
  if (filter === 'corrected') return item.reviewable && hasWork(item);
  if (filter === 'untouched') return item.reviewable && !hasWork(item);
  return true;
}

/** Most recently worked on first; never-touched sessions keep their original order after them. */
export function sortByActivity(items: SessionItem[]): SessionItem[] {
  const stamp = (item: SessionItem) => (item.reviewable ? item.last_activity ?? '' : '');
  return items.map((item, index) => ({ item, index })).sort((a, b) => {
    const left = stamp(a.item), right = stamp(b.item);
    if (left !== right) return left < right ? 1 : -1;
    return a.index - b.index;
  }).map(entry => entry.item);
}

export function filterCounts(items: SessionItem[], query: string): Record<Filter, number> {
  return Object.fromEntries(FILTERS.map(f => [f.id, items.filter(item => matches(item, f.id, query)).length])) as Record<Filter, number>;
}

export function totals(items: SessionItem[]) {
  let corrections = 0, exports = 0;
  for (const item of items) {
    if (!item.reviewable) continue;
    corrections += totalCorrections(item.counts);
    if (item.last_export) exports += 1;
  }
  return { videos: items.length, corrections, exports };
}

export const progressOf = (item: ReviewableItem) => (item.frame_count > 0 ? item.complete_frames / item.frame_count : 0);
/** Digits grouped by threes with a plain space, the same on every machine (locale data differs between browsers). */
export const formatInt = (value: number) => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
