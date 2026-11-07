import hashlib
import json
import types

import pytest
from fastapi.testclient import TestClient

from app import corrections, main
from app.storage import Store

VIDEO = b'synthetic clip bytes'
SOURCE = {'width': 640, 'height': 360}


def make_analysis(path, sha):
    frames = []
    for index in range(40):
        boxes = [{'bbox': {'x1': 10.0, 'y1': 10.0, 'x2': 60.0, 'y2': 50.0}, 'confidence': 0.9, 'track_id': 1, 'frame_index': index},
                 {'bbox': {'x1': 100.0, 'y1': 100.0, 'x2': 160.0, 'y2': 150.0}, 'confidence': 0.52 if index in (5, 6, 20) else 0.8,
                  'track_id': 2, 'frame_index': index}]
        frames.append({'frame_index': index, 'observations': boxes, 'timestamp_seconds': index / 10, 'visible_ants': 2})
    analysis = {'frames': frames, 'thresholds': {'confidence': 0.5},
                'detector': {'role': 'experimental_v2_e2_epoch45', 'sha256': 'f' * 64, 'experiment': 'V2-E2 epoch 45 (experimental)'},
                'source': {'path': str(path.parent.parent / 'clip.mp4'), 'sha256': sha, 'widthPx': 640, 'heightPx': 360, 'fps': 10.0, 'frameCount': 40}}
    (path / 'analysis.json').write_text(json.dumps(analysis), encoding='utf-8')


def tree(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file()}


@pytest.fixture
def api(tmp_path, monkeypatch):
    research = tmp_path / 'research'
    run = research / 'artifacts' / 'run1'
    run.mkdir(parents=True)
    (research / 'clip.mp4').write_bytes(VIDEO)
    make_analysis(run, hashlib.sha256(VIDEO).hexdigest())
    store = Store(tmp_path / 'data' / 'formiai.sqlite3')
    store.session('s1', run)
    monkeypatch.setattr(main, 'research', research.resolve())
    monkeypatch.setattr(main, 'store', store)
    monkeypatch.setattr(main, 'data_dir', tmp_path / 'data')
    return types.SimpleNamespace(client=TestClient(main.app), research=research, run=run, tmp=tmp_path, store=store)


BOX_A = {'bbox': [10.0, 10.0, 60.0, 50.0]}
BOX_B = {'bbox': [100.0, 100.0, 160.0, 150.0]}


def post(api, body, session='s1'):
    return api.client.post(f'/api/sessions/{session}/corrections', json=body)


def test_review_serves_compact_frames_and_a_verified_source(api):
    body = api.client.get('/api/sessions/s1/review').json()
    assert body['source']['verified'] is True and body['source']['frame_count'] == 40
    assert body['frames'][0][0] == [10.0, 10.0, 60.0, 50.0, 0.9, 1] and len(body['frames']) == 40
    assert api.client.get('/api/sessions/s1/source-video').content == VIDEO
    assert api.client.get('/api/sessions/nope/review').status_code == 404


def test_unverified_source_blocks_every_write_but_not_reading(api):
    (api.research / 'clip.mp4').write_bytes(b'a different file')
    assert api.client.get('/api/sessions/s1/review').json()['source']['verified'] is False
    assert post(api, {'kind': 'reject', 'frame_index': 0, 'target': BOX_A}).status_code == 409
    assert api.client.get('/api/sessions/s1/source-video').status_code == 409
    assert api.client.post('/api/sessions/s1/exports').status_code == 409


def test_each_kind_is_stored_with_a_snapshot_of_what_the_user_saw(api):
    reject = post(api, {'kind': 'reject', 'frame_index': 3, 'target': BOX_A}).json()
    assert reject['target'] == {'bbox': [10.0, 10.0, 60.0, 50.0], 'confidence': 0.9, 'track_id': 1} and reject['bbox'] is None
    adjust = post(api, {'kind': 'adjust', 'frame_index': 3, 'target': BOX_B, 'bbox': [101, 101, 161, 151]}).json()
    assert adjust['bbox'] == [101.0, 101.0, 161.0, 151.0] and adjust['target']['confidence'] == 0.8
    add = post(api, {'kind': 'add', 'frame_index': 3, 'bbox': [200, 200, 240, 240]}).json()
    assert add['target'] is None and add['kind'] == 'add'
    state = api.client.get('/api/sessions/s1/review/state').json()
    assert [a['kind'] for a in state['annotations']] == ['reject', 'adjust', 'add']


@pytest.mark.parametrize('body', [
    {'kind': 'reject', 'frame_index': 3, 'target': {'bbox': [11, 10, 60, 50]}},       # not a box the analysis produced
    {'kind': 'reject', 'frame_index': 99, 'target': BOX_A},                           # frame outside the analysis
    {'kind': 'reject', 'frame_index': 3},                                             # no target
    {'kind': 'add', 'frame_index': 3, 'bbox': [0, 0, 700, 100]},                      # outside the video frame
    {'kind': 'add', 'frame_index': 3, 'bbox': [10, 10, 12, 12]},                      # smaller than 4 px
    {'kind': 'add', 'frame_index': 3, 'bbox': [50, 50, 20, 20]},                      # inverted
    {'kind': 'add', 'frame_index': 3, 'bbox': [1, 2, 3]},                             # malformed
    {'kind': 'add', 'frame_index': 3, 'bbox': [1, 2, 30, 'x']},
    {'kind': 'adjust', 'frame_index': 3, 'target': BOX_A},                            # adjust needs a new box
    {'kind': 'delete', 'frame_index': 3},                                             # unknown kind
    {'kind': 'add', 'frame_index': True, 'bbox': [10, 10, 50, 50]},
    {'kind': 'add', 'frame_index': 3, 'bbox': [10, 10, 50, 50], 'note': 'x' * 501},
])
def test_invalid_corrections_are_refused_and_nothing_is_stored(api, body):
    assert post(api, body).status_code == 422
    assert api.client.get('/api/sessions/s1/review/state').json()['annotations'] == []


def test_a_newer_decision_on_the_same_box_replaces_the_older_one(api):
    first = post(api, {'kind': 'reject', 'frame_index': 3, 'target': BOX_A}).json()
    second = post(api, {'kind': 'confirm', 'frame_index': 3, 'target': BOX_A}).json()
    annotations = api.client.get('/api/sessions/s1/review/state').json()['annotations']
    assert [a['id'] for a in annotations] == [second['id']]
    # Undoing the newer decision brings the older one back, so undo is lossless.
    assert api.client.delete(f"/api/sessions/s1/corrections/{second['id']}").status_code == 200
    assert api.client.post(f"/api/sessions/s1/corrections/{first['id']}/restore").json()['kind'] == 'reject'
    assert [a['kind'] for a in api.client.get('/api/sessions/s1/review/state').json()['annotations']] == ['reject']


def test_move_delete_and_restore(api):
    add = post(api, {'kind': 'add', 'frame_index': 4, 'bbox': [200, 200, 240, 240]}).json()
    moved = api.client.patch(f"/api/sessions/s1/corrections/{add['id']}", json={'bbox': [210, 205, 260, 250]}).json()
    assert moved['bbox'] == [210.0, 205.0, 260.0, 250.0] and moved['updated_at'] >= add['updated_at']
    assert api.client.patch(f"/api/sessions/s1/corrections/{add['id']}", json={'bbox': [0, 0, 5000, 5]}).status_code == 422
    confirm = post(api, {'kind': 'confirm', 'frame_index': 4, 'target': BOX_A}).json()
    assert api.client.patch(f"/api/sessions/s1/corrections/{confirm['id']}", json={'bbox': [10, 10, 60, 50]}).status_code == 422
    assert api.client.delete(f"/api/sessions/s1/corrections/{add['id']}").status_code == 200
    assert api.client.delete(f"/api/sessions/s1/corrections/{add['id']}").status_code == 404
    assert api.client.post(f"/api/sessions/s1/corrections/{add['id']}/restore").json()['bbox'] == [210.0, 205.0, 260.0, 250.0]


def test_queue_prefers_uncertain_frames_spaced_apart_and_skips_completed_ones(api):
    first = api.client.get('/api/sessions/s1/review/queue?strategy=uncertain').json()['frames']
    assert [item['frame_index'] for item in first] == [5, 20]  # frame 6 is a near-duplicate of 5 (gap = fps / 2)
    assert all(item['reason'] == 'uncertain' and item['score'] > 0 for item in first)
    assert api.client.put('/api/sessions/s1/review/frames/5/complete', json={'complete': True}).status_code == 200
    assert [i['frame_index'] for i in api.client.get('/api/sessions/s1/review/queue?strategy=uncertain').json()['frames']] == [6, 20]
    coverage = api.client.get('/api/sessions/s1/review/queue?strategy=coverage&limit=4').json()['frames']
    assert [i['frame_index'] for i in coverage] == [15, 25, 35]  # evenly spread; frame 5 is already complete
    assert api.client.get('/api/sessions/s1/review/queue?strategy=magic').status_code == 422
    assert api.client.put('/api/sessions/s1/review/frames/99/complete', json={'complete': True}).status_code == 422


def test_export_is_versioned_checksummed_immutable_and_outside_the_research_root(api):
    assert api.client.post('/api/sessions/s1/exports').status_code == 422  # nothing to export yet
    post(api, {'kind': 'reject', 'frame_index': 3, 'target': BOX_A})
    post(api, {'kind': 'adjust', 'frame_index': 3, 'target': BOX_B, 'bbox': [101, 101, 161, 151]})
    post(api, {'kind': 'add', 'frame_index': 3, 'bbox': [200, 200, 240, 240]})
    post(api, {'kind': 'confirm', 'frame_index': 7, 'target': BOX_A})
    api.client.put('/api/sessions/s1/review/frames/3/complete', json={'complete': True})
    before = tree(api.research)
    manifest = api.client.post('/api/sessions/s1/exports').json()
    assert manifest['export_id'] == 'v0001' and manifest['counts'] == {'confirm': 1, 'reject': 1, 'adjust': 1, 'add': 1, 'annotations': 4, 'complete_frames': 1}
    assert manifest['source']['sha256'] == hashlib.sha256(VIDEO).hexdigest() and manifest['model']['detector']['sha256'] == 'f' * 64
    assert manifest['analysis_sha256'] == hashlib.sha256((api.run / 'analysis.json').read_bytes()).hexdigest()
    folder = api.tmp / 'data' / 'exports' / 's1' / 'v0001'
    for name, info in manifest['files'].items():
        assert hashlib.sha256((folder / name).read_bytes()).hexdigest() == info['sha256']
    frames = [json.loads(line) for line in (folder / 'frames.jsonl').read_text().splitlines()]
    assert len(frames) == 1 and frames[0]['frame_index'] == 3 and frames[0]['rejected'] == [[10.0, 10.0, 60.0, 50.0]]
    assert [(b['origin'], b['bbox']) for b in frames[0]['boxes']] == [('adjusted', [101.0, 101.0, 161.0, 151.0]), ('added', [200.0, 200.0, 240.0, 240.0])]
    assert tree(api.research) == before  # the research root and the analysis are untouched
    second = api.client.post('/api/sessions/s1/exports').json()
    assert second['export_id'] == 'v0002'
    assert [m['export_id'] for m in api.client.get('/api/sessions/s1/exports').json()['exports']] == ['v0001', 'v0002']
    assert api.client.get('/api/sessions/s1/exports/v0001/manifest.json').json()['export_id'] == 'v0001'
    assert api.client.get('/api/sessions/s1/exports/v0001/secrets.txt').status_code == 404
    assert api.client.get('/api/sessions/s1/exports/..%2F..%2Fv0001/manifest.json').status_code == 404


def test_unreviewed_boxes_of_a_complete_frame_are_labelled_as_such(api):
    api.client.put('/api/sessions/s1/review/frames/9/complete', json={'complete': True})
    manifest = api.client.post('/api/sessions/s1/exports').json()
    frame = json.loads((api.tmp / 'data' / 'exports' / 's1' / manifest['export_id'] / 'frames.jsonl').read_text().splitlines()[0])
    assert {b['origin'] for b in frame['boxes']} == {'model_unreviewed'} and len(frame['boxes']) == 2
    assert api.client.put('/api/sessions/s1/review/frames/9/complete', json={'complete': False}).json()['complete'] is False
    assert corrections.CorrectionStore(api.store.path).complete_frames('s1') == []


def test_annotation_list_reports_progress_per_analysed_video(api):
    bad = api.tmp / 'research' / 'artifacts' / 'broken'
    bad.mkdir(parents=True)
    api.store.session('s2', bad)
    before = api.client.get('/api/annotation/sessions').json()['sessions']
    first = next(s for s in before if s['id'] == 's1')
    assert first['reviewable'] is True and first['frame_count'] == 40 and first['source']['verified'] is True
    assert first['counts'] == {'confirm': 0, 'reject': 0, 'adjust': 0, 'add': 0}
    assert first['complete_frames'] == 0 and first['last_export'] is None and first['last_activity'] is None
    assert first['model']['id'] if first['model'] else True
    broken = next(s for s in before if s['id'] == 's2')
    assert broken['reviewable'] is False and broken['reason']

    post(api, {'kind': 'reject', 'frame_index': 0, 'target': BOX_A})
    post(api, {'kind': 'confirm', 'frame_index': 1, 'target': BOX_A})
    api.client.put('/api/sessions/s1/review/frames/0/complete', json={'complete': True})
    api.client.post('/api/sessions/s1/exports')
    after = next(s for s in api.client.get('/api/annotation/sessions').json()['sessions'] if s['id'] == 's1')
    assert after['counts'] == {'confirm': 1, 'reject': 1, 'adjust': 0, 'add': 0}
    assert after['complete_frames'] == 1 and after['last_activity']
    assert after['last_export']['export_id'] == 'v0001'


def test_annotation_list_flags_a_video_that_no_longer_matches(api):
    (api.research / 'clip.mp4').write_bytes(b'a different file')
    item = api.client.get('/api/annotation/sessions').json()['sessions'][0]
    assert item['reviewable'] is True and item['source']['verified'] is False
