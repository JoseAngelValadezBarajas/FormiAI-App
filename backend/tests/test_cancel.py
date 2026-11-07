import os
import subprocess
import sys
import time
import types

import pytest
from fastapi.testclient import TestClient

from app import main
from app.storage import Store

# A stand-in analysis that, like `uv run`, starts a nested process and then keeps running.
PARENT = '''
import pathlib, subprocess, sys, time
pids = pathlib.Path(sys.argv[1])
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
pids.write_text(f"{__import__('os').getpid()} {child.pid}")
time.sleep(120)
'''


def alive(pid: int) -> bool:
    if os.name == 'nt':
        out = subprocess.run(['tasklist', '/FI', f'PID eq {pid}', '/NH'], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def wait_for(condition, seconds=20):
    deadline = time.time() + seconds
    while time.time() < deadline:
        value = condition()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError('condition not met in time')


@pytest.fixture
def live(tmp_path, monkeypatch):
    research = tmp_path / 'research'
    (research / 'artifacts' / 'product_runs').mkdir(parents=True)
    (research / 'clip.mp4').write_bytes(b'synthetic')
    script = tmp_path / 'parent.py'
    script.write_text(PARENT, encoding='utf-8')
    pids = tmp_path / 'pids.txt'
    store = Store(tmp_path / 'data' / 'formiai.sqlite3')
    monkeypatch.setattr(main, 'research', research.resolve())
    monkeypatch.setattr(main, 'runs_root', (research / 'artifacts' / 'product_runs').resolve())
    monkeypatch.setattr(main, 'store', store)
    monkeypatch.setattr(main, 'data_dir', tmp_path / 'data')
    monkeypatch.setattr(main, 'build_command', lambda *args, **kwargs: [sys.executable, str(script), str(pids)])
    client = TestClient(main.app)
    spawned: list[int] = []
    yield types.SimpleNamespace(client=client, store=store, pids=pids, spawned=spawned)
    for pid in spawned:  # never leave a sleeper behind, even if an assertion failed
        if alive(pid):
            subprocess.run(['taskkill', '/PID', str(pid), '/F'] if os.name == 'nt' else ['kill', '-9', str(pid)], capture_output=True)


def start(live):
    job = live.client.post('/api/jobs', json={'source_name': 'clip.mp4', 'model': 'OD-E2-N'}).json()
    parent, child = map(int, wait_for(lambda: live.pids.is_file() and live.pids.read_text().strip() or None).split())
    live.spawned += [parent, child]
    return job, parent, child


def test_cancel_stops_the_analysis_and_everything_it_spawned(live):
    job, parent, child = start(live)
    assert alive(parent) and alive(child)
    response = live.client.post(f"/api/jobs/{job['id']}/cancel")
    assert response.status_code == 200 and response.json()['status'] == 'cancelled'
    wait_for(lambda: not alive(parent) and not alive(child))
    time.sleep(0.5)  # the runner thread must not overwrite the state with a failure
    row = live.store.get_job(job['id'])
    assert row['status'] == 'cancelled' and 'Cancelled by the user' in row['message']
    assert row['session_id'] is None


def test_a_cancelled_video_can_be_analysed_again_and_cancel_is_idempotent(live):
    job, parent, child = start(live)
    assert live.client.post(f"/api/jobs/{job['id']}/cancel").json()['status'] == 'cancelled'
    assert live.client.post(f"/api/jobs/{job['id']}/cancel").json()['status'] == 'cancelled'
    assert live.store.processing_for_source('clip.mp4') is None
    live.pids.unlink()
    again, *_ = start(live)
    assert again['id'] != job['id']
    live.client.post(f"/api/jobs/{again['id']}/cancel")


def test_cancel_rejects_unknown_and_finished_jobs(live):
    assert live.client.post('/api/jobs/missing/cancel').status_code == 404
    live.store.job('done', 'complete', 'clip.mp4', main.runs_root / 'done', [])
    assert live.client.post('/api/jobs/done/cancel').status_code == 409


def test_event_stream_announces_the_cancellation(live):
    job, *_ = start(live)
    live.client.post(f"/api/jobs/{job['id']}/cancel")
    with live.client.stream('GET', f"/api/jobs/{job['id']}/events") as response:
        text = ''.join(response.iter_text())
    assert 'event: cancelled' in text and 'event: complete' not in text and 'event: error' not in text
