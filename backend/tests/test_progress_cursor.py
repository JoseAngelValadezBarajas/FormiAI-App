"""Reproduces the SSE cursor defect: a batch published after the cursor already passed its sequence.

`job_events` advances `cursor` to the highest sequence it sent and `progressive_batches(run, cursor)` only
returns sequences above it, so a lower sequence that appears later is never delivered on the same stream.
The client treats the missing sequence as a gap (see frontend `acceptBatch`).
"""
import json
import threading
import time

import pytest
from fastapi.testclient import TestClient

from app import main
from app.storage import Store


def publish(directory, sequence):
    directory.mkdir(exist_ok=True)
    body = {'schema_version': 1, 'kind': 'formiai.progress.batch', 'sequence': sequence,
            'processed_through_frame': sequence * 10 - 1, 'frames': []}
    temporary = directory / f'batch-{sequence:06d}.tmp'
    temporary.write_text(json.dumps(body), encoding='utf-8')
    temporary.replace(directory / f'batch-{sequence:06d}.json')  # same atomic publish as the writer


def delivered_sequences(client, job_id):
    sequences = []
    with client.stream('GET', f'/api/jobs/{job_id}/events') as response:
        for line in response.iter_lines():
            if line.startswith('id: '):
                sequences.append(int(line[4:]))
    return sequences


@pytest.fixture
def job(tmp_path, monkeypatch):
    # Everything lives under tmp_path: a private store and run directory; the research root is not touched.
    store = Store(tmp_path / 'data' / 'formiai.sqlite3')
    run = tmp_path / 'run'
    run.mkdir()
    store.job('late-batch', 'processing', 'synthetic.mp4', run, [])
    monkeypatch.setattr(main, 'store', store)
    return store, run


def test_in_order_batches_are_all_delivered(job):
    store, run = job
    directory = run / main.PROGRESS_DIRECTORY
    for sequence in (1, 2, 3):
        publish(directory, sequence)
    threading.Timer(0.6, store.update_job, args=('late-batch', 'complete', 'done', 'late-batch')).start()
    assert delivered_sequences(TestClient(main.app), 'late-batch') == [1, 2, 3]


@pytest.mark.xfail(strict=True, reason='cursor advances past a sequence that is published later; it is never delivered')
def test_batch_published_after_the_cursor_passed_it_is_still_delivered(job):
    store, run = job
    directory = run / main.PROGRESS_DIRECTORY
    publish(directory, 1)
    publish(directory, 3)  # sequence 2 is absent for now

    def late():
        time.sleep(0.7)  # the stream has polled several times and its cursor is at 3
        publish(directory, 2)
        time.sleep(0.7)
        store.update_job('late-batch', 'complete', 'done', 'late-batch')

    worker = threading.Thread(target=late)
    worker.start()
    sequences = delivered_sequences(TestClient(main.app), 'late-batch')
    worker.join()
    assert 2 in sequences, f'sequence 2 was published but the stream delivered {sequences}'
