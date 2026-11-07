import { describe, expect, it } from 'vitest';
import { filterCounts, formatInt, hasWork, isUnverified, matches, progressOf, sortByActivity, totals, type ReviewableItem, type SessionItem } from './listModel';

const make = (id: string, over: Partial<ReviewableItem> = {}): ReviewableItem => ({
  id, status: 'ready', reviewable: true,
  source: { name: `${id}.mp4`, sha256: 'a'.repeat(64), width: 1920, height: 1080, fps: 60, frame_count: 1000, verified: true },
  model: null, frame_count: 1000, counts: { confirm: 0, reject: 0, adjust: 0, add: 0 }, complete_frames: 0, last_export: null, last_activity: null, ...over,
});
const broken: SessionItem = { id: 'broken', status: 'ready', reviewable: false, reason: 'no analysis' };
const worked = make('worked', { counts: { confirm: 3, reject: 1, adjust: 0, add: 2 }, complete_frames: 250, last_activity: '2026-11-06T10:00:00Z', last_export: { export_id: 'v0001', created_at: 'x' } });
const completeOnly = make('complete-only', { complete_frames: 5, last_activity: '2026-11-07T10:00:00Z' });
const fresh = make('fresh');
const unverified = make('unverified', { source: { ...fresh.source, name: 'unverified.mp4', verified: false } });
const all: SessionItem[] = [fresh, worked, completeOnly, unverified, broken];

describe('classification', () => {
  it('counts a frame marked complete as work even without boxes', () => {
    expect(hasWork(completeOnly)).toBe(true);
    expect(hasWork(fresh)).toBe(false);
  });
  it('treats a session without a reviewable analysis as unverified', () => {
    expect(isUnverified(broken)).toBe(true);
    expect(isUnverified(unverified)).toBe(true);
    expect(isUnverified(worked)).toBe(false);
  });
});

describe('matches', () => {
  it('filters by state', () => {
    expect(all.filter(i => matches(i, 'corrected', '')).map(i => i.id)).toEqual(['worked', 'complete-only']);
    expect(all.filter(i => matches(i, 'untouched', '')).map(i => i.id)).toEqual(['fresh', 'unverified']);
    expect(all.filter(i => matches(i, 'unverified', '')).map(i => i.id)).toEqual(['unverified', 'broken']);
    expect(all.filter(i => matches(i, 'all', '')).length).toBe(5);
  });
  it('searches by video name or id, ignoring case and spaces around the query', () => {
    expect(all.filter(i => matches(i, 'all', '  WORK ')).map(i => i.id)).toEqual(['worked']);
    expect(all.filter(i => matches(i, 'all', 'broken')).map(i => i.id)).toEqual(['broken']);
  });
  it('combines the search with the filter', () => {
    expect(all.filter(i => matches(i, 'corrected', 'fresh'))).toEqual([]);
  });
});

describe('sortByActivity', () => {
  it('puts the most recently worked on first and keeps the rest in order', () => {
    expect(sortByActivity(all).map(i => i.id)).toEqual(['complete-only', 'worked', 'fresh', 'unverified', 'broken']);
  });
  it('does not mutate its input', () => {
    const copy = [...all];
    sortByActivity(all);
    expect(all).toEqual(copy);
  });
});

describe('summaries', () => {
  it('counts each filter for the chips', () => {
    expect(filterCounts(all, '')).toEqual({ all: 5, corrected: 2, untouched: 2, unverified: 2 });
  });
  it('totals videos, corrections and exports', () => {
    expect(totals(all)).toEqual({ videos: 5, corrections: 6, exports: 1 });
  });
  it('measures progress as completed frames over all frames, safe at zero', () => {
    expect(progressOf(worked)).toBe(0.25);
    expect(progressOf(make('empty', { frame_count: 0 }))).toBe(0);
  });
  it('writes thousands with a plain space', () => {
    expect(formatInt(3746)).toBe('3 746');
    expect(formatInt(12)).toBe('12');
  });
});
