"""Human corrections of an analysis: storage, validation, review queue and versioned export.

Corrections are separate human annotations. They never modify the analysis artifacts, the source video or
anything under the research root. A correction always references a box the user was actually shown (matched
against the analysis, never trusted blindly) or a new box drawn by the user inside the video frame.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

KINDS = ('confirm', 'reject', 'adjust', 'add')
MIN_BOX_PX = 4.0
MATCH_TOLERANCE_PX = 1e-3
UNCERTAIN_BAND = 0.15
EXPORT_FILES = ('annotations.jsonl', 'frames.jsonl', 'manifest.json')
SEMANTICS = (
    'annotations.jsonl: every active human action. confirm = the shown box is a correct ant; reject = false positive; '
    'adjust = same ant, corrected box; add = ant the model missed. frames.jsonl: only frames the reviewer declared '
    'COMPLETE; for those, `boxes` is the full set of ants (model boxes not rejected, with adjustments, plus added '
    'boxes) and anything outside them is background; `rejected` lists false positives. Frames not declared complete '
    'carry partial labels only and must not be treated as fully labelled. Boxes are pixel xyxy in source-video '
    'coordinates. Track ids are provisional and are not part of the labels.'
)
LIMITATIONS = (
    'No annotator identity is recorded. Boxes come from the model run identified in `model`, restricted to tracked '
    'observations (detections the tracker left unassigned were never shown). The export is a snapshot and immutable.'
)


class CorrectionError(ValueError):
    """A request that would store something untrue or malformed."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class ReviewData:
    frames: list[list[dict]]
    source: dict
    confidence_floor: float
    detector: dict
    analysis_sha256: str


_review_cache: dict[tuple[str, int, int], ReviewData] = {}
_hash_cache: dict[tuple[str, int, int], str] = {}


def cached_sha256(path: Path) -> str:
    stat = path.stat()
    key = (str(path.resolve()), stat.st_size, stat.st_mtime_ns)
    if key not in _hash_cache:
        _hash_cache[key] = sha256_file(path)
    return _hash_cache[key]


def load_review(run: Path) -> ReviewData:
    path = run / 'analysis.json'
    stat = path.stat()
    key = (str(path.resolve()), stat.st_size, stat.st_mtime_ns)
    if key in _review_cache:
        return _review_cache[key]
    analysis = json.loads(path.read_text(encoding='utf-8'))
    frames: list[list[dict]] = []
    for position, frame in enumerate(analysis['frames']):
        if int(frame['frame_index']) != position:
            raise CorrectionError('analysis frames are not contiguous from 0')
        frames.append([
            {'bbox': [float(o['bbox'][k]) for k in ('x1', 'y1', 'x2', 'y2')], 'confidence': float(o['confidence']),
             'track_id': o.get('track_id')} for o in frame['observations']])
    data = ReviewData(frames=frames, source=analysis['source'], confidence_floor=float(analysis['thresholds']['confidence']),
                      detector=analysis['detector'], analysis_sha256=cached_sha256(path))
    _review_cache.clear()  # one analysis in memory is enough; frames are large
    _review_cache[key] = data
    return data


def source_info(data: ReviewData, research: Path) -> dict:
    """The clean source video behind this analysis, and whether it is provably the analysed file."""
    declared = Path(data.source['path'])
    info = {'name': declared.name, 'sha256': data.source['sha256'], 'width': int(data.source['widthPx']),
            'height': int(data.source['heightPx']), 'fps': float(data.source['fps']),
            'frame_count': int(data.source['frameCount']), 'verified': False}
    candidate = (research / declared.name).resolve()
    try:
        candidate.relative_to(research.resolve())
    except ValueError:
        return info
    if candidate.is_file():
        info['verified'] = cached_sha256(candidate) == data.source['sha256']
    return info


def box_key(box: list[float]) -> tuple[float, ...]:
    return tuple(round(v, 3) for v in box)


def find_observation(data: ReviewData, frame_index: int, target: dict) -> dict:
    if not 0 <= frame_index < len(data.frames):
        raise CorrectionError('frame_index is outside the analysis')
    wanted = target.get('bbox')
    if not isinstance(wanted, list) or len(wanted) != 4:
        raise CorrectionError('target.bbox must have 4 numbers')
    for observation in data.frames[frame_index]:
        if all(abs(a - float(b)) <= MATCH_TOLERANCE_PX for a, b in zip(observation['bbox'], wanted)):
            return observation
    raise CorrectionError('target does not match any box the analysis produced for this frame')


def validate_box(box: object, source: dict) -> list[float]:
    if not isinstance(box, list) or len(box) != 4 or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in box):
        raise CorrectionError('bbox must be [x1, y1, x2, y2] numbers')
    x1, y1, x2, y2 = (float(v) for v in box)
    if not all(v == v and abs(v) != float('inf') for v in (x1, y1, x2, y2)):
        raise CorrectionError('bbox must be finite')
    if x1 < 0 or y1 < 0 or x2 > source['width'] or y2 > source['height']:
        raise CorrectionError('bbox must lie inside the video frame')
    if x2 - x1 < MIN_BOX_PX or y2 - y1 < MIN_BOX_PX:
        raise CorrectionError(f'bbox must be at least {MIN_BOX_PX:g} px on each side')
    return [x1, y1, x2, y2]


class CorrectionStore:
    """SQLite persistence next to the product database; annotations are soft-deleted so undo is lossless."""

    def __init__(self, path: Path) -> None:
        self.path = path
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS annotations (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, frame_index INTEGER NOT NULL, '
                       'kind TEXT NOT NULL, target_json TEXT, bbox_json TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)')
            db.execute('CREATE INDEX IF NOT EXISTS annotations_session ON annotations(session_id, frame_index)')
            db.execute('CREATE TABLE IF NOT EXISTS frame_reviews (session_id TEXT NOT NULL, frame_index INTEGER NOT NULL, complete INTEGER NOT NULL, '
                       'updated_at TEXT NOT NULL, PRIMARY KEY (session_id, frame_index))')

    def connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.path)

    @staticmethod
    def _row(row: tuple) -> dict:
        return {'id': row[0], 'frame_index': row[1], 'kind': row[2], 'target': json.loads(row[3]) if row[3] else None,
                'bbox': json.loads(row[4]) if row[4] else None, 'note': row[5], 'created_at': row[6], 'updated_at': row[7]}

    _COLUMNS = 'id, frame_index, kind, target_json, bbox_json, note, created_at, updated_at'

    def active(self, session_id: str, frame_index: int | None = None) -> list[dict]:
        sql = f'SELECT {self._COLUMNS} FROM annotations WHERE session_id=? AND deleted_at IS NULL'
        args: list = [session_id]
        if frame_index is not None:
            sql += ' AND frame_index=?'
            args.append(frame_index)
        with self.connect() as db:
            return [self._row(r) for r in db.execute(sql + ' ORDER BY frame_index, created_at', args)]

    def get(self, session_id: str, annotation_id: str, include_deleted: bool = False) -> dict | None:
        sql = f'SELECT {self._COLUMNS} FROM annotations WHERE session_id=? AND id=?'
        if not include_deleted:
            sql += ' AND deleted_at IS NULL'
        with self.connect() as db:
            row = db.execute(sql, (session_id, annotation_id)).fetchone()
        return self._row(row) if row else None

    def create(self, session_id: str, data: ReviewData, source: dict, body: dict) -> dict:
        kind, frame_index = body.get('kind'), body.get('frame_index')
        if kind not in KINDS:
            raise CorrectionError(f'kind must be one of {KINDS}')
        if not isinstance(frame_index, int) or isinstance(frame_index, bool):
            raise CorrectionError('frame_index must be an integer')
        target = bbox = None
        if kind == 'add':
            if not 0 <= frame_index < len(data.frames):
                raise CorrectionError('frame_index is outside the analysis')
            bbox = validate_box(body.get('bbox'), source)
        else:
            observation = find_observation(data, frame_index, body.get('target') or {})
            target = {'bbox': observation['bbox'], 'confidence': observation['confidence'], 'track_id': observation['track_id']}
            if kind == 'adjust':
                bbox = validate_box(body.get('bbox'), source)
        note = body.get('note')
        if note is not None and (not isinstance(note, str) or len(note) > 500):
            raise CorrectionError('note must be text of at most 500 characters')
        stamp = now()
        annotation_id = uuid.uuid4().hex
        with self.connect() as db:
            if target is not None:  # one active decision per shown box: the newest replaces the previous one
                for existing in self.active(session_id, frame_index):
                    if existing['target'] and box_key(existing['target']['bbox']) == box_key(target['bbox']):
                        db.execute('UPDATE annotations SET deleted_at=? WHERE id=?', (stamp, existing['id']))
            db.execute('INSERT INTO annotations VALUES (?,?,?,?,?,?,?,?,?,NULL)',
                       (annotation_id, session_id, frame_index, kind, json.dumps(target) if target else None,
                        json.dumps(bbox) if bbox else None, note, stamp, stamp))
        return self.get(session_id, annotation_id) or {}

    def move(self, session_id: str, source: dict, annotation_id: str, bbox: object) -> dict:
        current = self.get(session_id, annotation_id)
        if not current:
            raise CorrectionError('unknown annotation')
        if current['kind'] not in ('add', 'adjust'):
            raise CorrectionError('only add and adjust annotations carry a box')
        checked = validate_box(bbox, source)
        with self.connect() as db:
            db.execute('UPDATE annotations SET bbox_json=?, updated_at=? WHERE id=?', (json.dumps(checked), now(), annotation_id))
        return self.get(session_id, annotation_id) or {}

    def delete(self, session_id: str, annotation_id: str) -> bool:
        with self.connect() as db:
            return db.execute('UPDATE annotations SET deleted_at=? WHERE session_id=? AND id=? AND deleted_at IS NULL',
                              (now(), session_id, annotation_id)).rowcount == 1

    def restore(self, session_id: str, annotation_id: str) -> dict:
        existing = self.get(session_id, annotation_id, include_deleted=True)
        if not existing:
            raise CorrectionError('unknown annotation')
        with self.connect() as db:
            if existing['target']:  # restoring must not leave two active decisions on the same box
                for other in self.active(session_id, existing['frame_index']):
                    if other['target'] and box_key(other['target']['bbox']) == box_key(existing['target']['bbox']):
                        db.execute('UPDATE annotations SET deleted_at=? WHERE id=?', (now(), other['id']))
            db.execute('UPDATE annotations SET deleted_at=NULL, updated_at=? WHERE id=?', (now(), annotation_id))
        return self.get(session_id, annotation_id) or {}

    def set_complete(self, session_id: str, frame_index: int, complete: bool, frame_count: int) -> None:
        if not 0 <= frame_index < frame_count:
            raise CorrectionError('frame_index is outside the analysis')
        with self.connect() as db:
            if complete:
                db.execute('INSERT OR REPLACE INTO frame_reviews VALUES (?,?,1,?)', (session_id, frame_index, now()))
            else:
                db.execute('DELETE FROM frame_reviews WHERE session_id=? AND frame_index=?', (session_id, frame_index))

    def complete_frames(self, session_id: str) -> list[int]:
        with self.connect() as db:
            return [r[0] for r in db.execute('SELECT frame_index FROM frame_reviews WHERE session_id=? AND complete=1 ORDER BY frame_index', (session_id,))]

    def counts(self, session_id: str) -> dict[str, int]:
        with self.connect() as db:
            rows = db.execute('SELECT kind, COUNT(*) FROM annotations WHERE session_id=? AND deleted_at IS NULL GROUP BY kind', (session_id,)).fetchall()
        result = {kind: 0 for kind in KINDS}
        result.update({kind: total for kind, total in rows if kind in result})
        return result

    def last_activity(self, session_id: str) -> str | None:
        with self.connect() as db:
            stamps = [db.execute('SELECT MAX(updated_at) FROM annotations WHERE session_id=?', (session_id,)).fetchone()[0],
                      db.execute('SELECT MAX(updated_at) FROM frame_reviews WHERE session_id=?', (session_id,)).fetchone()[0]]
        stamps = [stamp for stamp in stamps if stamp]
        return max(stamps) if stamps else None


def review_queue(data: ReviewData, complete: set[int], strategy: str, limit: int, fps: float) -> list[dict]:
    """Frames worth a human look. `uncertain`: low-confidence boxes; `coverage`: evenly spread frames to catch omissions."""
    if strategy not in ('uncertain', 'coverage'):
        raise CorrectionError('strategy must be uncertain or coverage')
    limit = max(1, min(limit, 500))
    count = len(data.frames)
    gap = max(1, round(fps / 2))
    if strategy == 'coverage':
        step = max(1, count // limit)
        picks = [i for i in range(step // 2, count, step) if i not in complete][:limit]
        return [{'frame_index': i, 'reason': 'coverage', 'score': 0.0} for i in picks]
    ceiling = data.confidence_floor + UNCERTAIN_BAND
    scored = []
    for index, boxes in enumerate(data.frames):
        if index in complete:
            continue
        score = sum(ceiling - b['confidence'] for b in boxes if b['confidence'] < ceiling)
        if score > 0:
            scored.append((score, index))
    chosen: list[tuple[float, int]] = []
    for score, index in sorted(scored, key=lambda item: (-item[0], item[1])):
        if all(abs(index - other) >= gap for _, other in chosen):  # neighbouring frames are near-duplicates
            chosen.append((score, index))
        if len(chosen) == limit:
            break
    return [{'frame_index': i, 'reason': 'uncertain', 'score': round(s, 4)} for s, i in chosen]


def final_boxes(data: ReviewData, frame_index: int, active: list[dict]) -> tuple[list[dict], list[list[float]]]:
    """Full set of ants and rejected boxes for one frame after applying the reviewer's actions."""
    by_target = {box_key(a['target']['bbox']): a for a in active if a['target']}
    boxes, rejected = [], []
    for observation in data.frames[frame_index]:
        action = by_target.get(box_key(observation['bbox']))
        if action and action['kind'] == 'reject':
            rejected.append(observation['bbox'])
        elif action and action['kind'] == 'adjust':
            boxes.append({'bbox': action['bbox'], 'origin': 'adjusted', 'model_bbox': observation['bbox'], 'confidence': observation['confidence']})
        elif action and action['kind'] == 'confirm':
            boxes.append({'bbox': observation['bbox'], 'origin': 'model_confirmed', 'confidence': observation['confidence']})
        else:
            boxes.append({'bbox': observation['bbox'], 'origin': 'model_unreviewed', 'confidence': observation['confidence']})
    boxes += [{'bbox': a['bbox'], 'origin': 'added', 'confidence': None} for a in active if a['kind'] == 'add']
    return boxes, rejected


def write_export(root: Path, session_id: str, data: ReviewData, source: dict, active: list[dict], complete: list[int],
                 model_record: dict | None) -> dict:
    """Write an immutable, checksummed export. Raises CorrectionError if there is nothing to export."""
    if not source['verified']:
        raise CorrectionError('the source video is not verified against the analysis; refusing to export labels')
    if not active and not complete:
        raise CorrectionError('there are no corrections or completed frames to export')
    base = root / session_id
    base.mkdir(parents=True, exist_ok=True)
    number = 1 + max([int(p.name[1:]) for p in base.iterdir() if p.is_dir() and p.name[1:].isdigit() and p.name.startswith('v')] or [0])
    export_id = f'v{number:04d}'
    staging = base / f'.{export_id}.tmp'
    staging.mkdir()
    fps = source['fps']
    annotations = [{'annotation_id': a['id'], 'frame_index': a['frame_index'], 'kind': a['kind'], 'original': a['target'],
                    'bbox': a['bbox'], 'note': a['note'], 'created_at': a['created_at'], 'updated_at': a['updated_at']} for a in active]
    by_frame: dict[int, list[dict]] = {}
    for a in active:
        by_frame.setdefault(a['frame_index'], []).append(a)
    frames = []
    for index in complete:
        boxes, rejected = final_boxes(data, index, by_frame.get(index, []))
        frames.append({'frame_index': index, 'timestamp_seconds': index / fps, 'boxes': boxes, 'rejected': rejected})
    for name, rows in (('annotations.jsonl', annotations), ('frames.jsonl', frames)):
        (staging / name).write_text(''.join(json.dumps(row, separators=(',', ':')) + '\n' for row in rows), encoding='utf-8')
    counts = {kind: sum(1 for a in active if a['kind'] == kind) for kind in KINDS}
    manifest = {
        'schema_version': 1, 'kind': 'formiai.corrections.export', 'export_id': export_id, 'created_at': now(),
        'session_id': session_id, 'source': {k: source[k] for k in ('name', 'sha256', 'width', 'height', 'fps', 'frame_count')},
        'analysis_sha256': data.analysis_sha256, 'model': {'detector': data.detector, 'formiai': model_record},
        'counts': {**counts, 'annotations': len(annotations), 'complete_frames': len(frames)},
        'files': {name: {'sha256': sha256_file(staging / name), 'bytes': (staging / name).stat().st_size} for name in EXPORT_FILES[:2]},
        'semantics': SEMANTICS, 'limitations': LIMITATIONS,
    }
    (staging / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    os.replace(staging, base / export_id)
    return manifest


def list_exports(root: Path, session_id: str) -> list[dict]:
    base = root / session_id
    if not base.is_dir():
        return []
    result = []
    for folder in sorted(p for p in base.iterdir() if p.is_dir() and not p.name.startswith('.')):
        try:
            result.append(json.loads((folder / 'manifest.json').read_text(encoding='utf-8')))
        except (OSError, ValueError):
            continue
    return result
