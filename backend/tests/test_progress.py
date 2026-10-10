import json

from app.main import PROGRESS_DIRECTORY, progress_from, progressive_batches


def publish(directory, sequence, frame):
    directory.mkdir(exist_ok=True)
    (directory / f'batch-{sequence:06d}.json').write_text(json.dumps({'schema_version': 1, 'kind': 'formiai.progress.batch', 'sequence': sequence, 'processed_through_frame': frame, 'frames': []}), encoding='utf-8')


def test_progress_only_consumes_versioned_complete_batches(tmp_path):
    directory = tmp_path / PROGRESS_DIRECTORY
    directory.mkdir()
    (directory / 'manifest.json').write_text(json.dumps({'schema_version': 1, 'kind': 'formiai.progress.manifest', 'fps': 12, 'frame_count': 60}), encoding='utf-8')
    publish(directory, 1, 7)
    (directory / 'batch-000002.tmp').write_text('{', encoding='utf-8')
    publish(directory, 3, 23)
    state = progress_from(tmp_path)
    assert (state.fps, state.frame_count, state.processed_through_frame, state.batch_count) == (12, 60, 23, 2)
    assert [batch['sequence'] for batch in progressive_batches(tmp_path, 1)] == [3]
