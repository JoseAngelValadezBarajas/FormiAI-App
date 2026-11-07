import { describe, expect, it } from 'vitest';
import { drag, drawn, frameCenterTime, handleAt, hitTest, neighbour, shownBoxes, stepFrame, summary, toScreen, toVideo, type Annotation, type Box, type ModelBox } from './correctionsModel';

const model = (bbox: Box, confidence = 0.9): ModelBox => ({ bbox, confidence, track_id: 1 });
const ann = (partial: Partial<Annotation> & Pick<Annotation, 'kind'>): Annotation => ({ id: 'x', frame_index: 0, target: null, bbox: null, ...partial });

describe('projection', () => {
  const p = { x: 20, y: 10, scale: 0.5 };
  it('round-trips between video and screen coordinates', () => {
    const screen = toScreen(p, [100, 200, 300, 400]);
    expect(screen).toEqual([70, 110, 170, 210]);
    expect(toVideo(p, 70, 110)).toEqual([100, 200]);
  });
});

describe('shownBoxes', () => {
  const a: Box = [10, 10, 60, 50], b: Box = [100, 100, 160, 150];
  it('applies each decision to the box it targets and appends added boxes', () => {
    const shown = shownBoxes([model(a), model(b)], [
      ann({ id: '1', kind: 'reject', target: { bbox: a, confidence: 0.9, track_id: 1 } }),
      ann({ id: '2', kind: 'adjust', target: { bbox: b, confidence: 0.9, track_id: 1 }, bbox: [101, 101, 161, 151] }),
      ann({ id: '3', kind: 'add', bbox: [200, 200, 240, 240] }),
    ]);
    expect(shown.map(s => s.status)).toEqual(['rejected', 'adjusted', 'added']);
    expect(shown[1].box).toEqual([101, 101, 161, 151]);
    expect(shown[1].origin).toEqual(b);
    expect(shown[2].model).toBeNull();
  });
  it('leaves undecided boxes untouched', () => {
    expect(shownBoxes([model(a)], []).map(s => s.status)).toEqual(['untouched']);
    expect(shownBoxes([model(a)], [ann({ kind: 'confirm', target: { bbox: a, confidence: 0.9, track_id: 1 } })])[0].status).toBe('confirmed');
  });
});

describe('hit testing', () => {
  it('prefers the smallest box where boxes overlap', () => {
    const shown = shownBoxes([model([0, 0, 100, 100]), model([40, 40, 60, 60])], []);
    expect(hitTest(shown, 50, 50)?.box).toEqual([40, 40, 60, 60]);
    expect(hitTest(shown, 10, 10)?.box).toEqual([0, 0, 100, 100]);
    expect(hitTest(shown, 500, 500)).toBeUndefined();
  });
  it('finds corner handles before the body', () => {
    const box: Box = [100, 100, 200, 200];
    expect(handleAt(box, 101, 99, 6)).toBe('nw');
    expect(handleAt(box, 199, 201, 6)).toBe('se');
    expect(handleAt(box, 150, 150, 6)).toBe('move');
    expect(handleAt(box, 400, 400, 6)).toBeNull();
  });
});

describe('dragging', () => {
  it('moves a box without leaving the frame', () => {
    expect(drag([10, 10, 60, 50], 'move', -100, -100, 640, 360)).toEqual([0, 0, 50, 40]);
    expect(drag([590, 320, 630, 350], 'move', 100, 100, 640, 360)).toEqual([600, 330, 640, 360]);
  });
  it('resizes from a corner and never collapses below the minimum', () => {
    expect(drag([100, 100, 200, 200], 'se', 30, 20, 640, 360)).toEqual([100, 100, 230, 220]);
    expect(drag([100, 100, 200, 200], 'nw', 500, 500, 640, 360)).toEqual([196, 196, 200, 200]);
    expect(drag([100, 100, 200, 200], 'se', 9999, 9999, 640, 360)).toEqual([100, 100, 640, 360]);
  });
  it('turns a drawn rectangle into a box only when it is big enough, in any drag direction', () => {
    expect(drawn(50, 60, 10, 20, 640, 360)).toEqual([10, 20, 50, 60]);
    expect(drawn(10, 10, 12, 12, 640, 360)).toBeNull();
    expect(drawn(600, 300, 900, 900, 640, 360)).toEqual([600, 300, 640, 360]);
  });
});

describe('navigation and counts', () => {
  it('seeks to the frame centre so the displayed frame is unambiguous', () => {
    expect(Math.floor(frameCenterTime(17, 24) * 24 + 1e-6)).toBe(17);
    expect(Math.floor(frameCenterTime(59, 59.976101354167646) * 59.976101354167646 + 1e-6)).toBe(59);
  });
  it('clamps stepping to the analysed range', () => {
    expect(stepFrame(2, -10, 100)).toBe(0);
    expect(stepFrame(95, 10, 100)).toBe(99);
  });
  it('walks the review queue in both directions', () => {
    const queue = [{ frame_index: 40 }, { frame_index: 5 }, { frame_index: 20 }];
    expect(neighbour(queue, 5, 1)).toBe(20);
    expect(neighbour(queue, 20, -1)).toBe(5);
    expect(neighbour(queue, 40, 1)).toBeUndefined();
    expect(neighbour(queue, 5, -1)).toBeUndefined();
  });
  it('counts annotations by kind', () => {
    expect(summary([ann({ kind: 'add' }), ann({ kind: 'add' }), ann({ kind: 'reject' })])).toEqual({ confirm: 0, reject: 1, adjust: 0, add: 2 });
  });
});
