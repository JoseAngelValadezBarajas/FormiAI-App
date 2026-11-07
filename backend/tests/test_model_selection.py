import dataclasses
import hashlib
import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main
from app.model_registry import MODELS, V2_E2_RUNNER, V2_E2_SHA256, availability, build_command
from app.models import CreateJobRequest
from app.storage import Store

FROZEN = '9f162701b70a298646f98c9acb130277f3794a6037c285e07b27ef44c733a7c2'


def test_registry_declares_identity_and_operating_confidence():
    assert V2_E2_SHA256 == FROZEN
    v2, od = MODELS['V2-E2'], MODELS['OD-E2-N']
    assert (v2.experimental, v2.confidence, v2.sha256) == (True, 0.50, FROZEN)
    assert (od.experimental, od.confidence) == (False, 0.25)
    assert 'Experimental' in v2.label and 'Experimental' not in od.label


def test_request_defaults_to_v2_e2_and_rejects_unknown_models():
    assert CreateJobRequest.model_validate({'source_name': 'a.mp4'}).model == 'V2-E2'
    assert CreateJobRequest.model_validate({'source_name': 'a.mp4', 'model': 'OD-E2-N'}).model == 'OD-E2-N'
    with pytest.raises(ValueError):
        CreateJobRequest.model_validate({'source_name': 'a.mp4', 'model': 'weights/other.pt'})


def test_commands_carry_the_right_model_and_confidence(tmp_path):
    source, output, progress = tmp_path / 's.mp4', tmp_path / 'o', tmp_path / 'o' / 'p'
    od = build_command(MODELS['OD-E2-N'], source, output, progress, 'cpu', tmp_path, {})
    assert od[od.index('--detector-role') + 1] == 'own_colony' and od[od.index('--confidence') + 1] == '0.25'
    v2 = build_command(MODELS['V2-E2'], source, output, progress, 'cpu', tmp_path, {'FORMIAI_V2_E2_CHECKPOINT': str(tmp_path / 'm.pt')})
    assert str(V2_E2_RUNNER) in v2 and 'own_colony' not in v2 and 'formicai' not in v2[:4]
    assert v2[v2.index('--confidence') + 1] == '0.5' and v2[v2.index('--sha256') + 1] == FROZEN
    assert v2[v2.index('--checkpoint') + 1] == str(tmp_path / 'm.pt')


def test_availability_requires_the_frozen_sha(tmp_path):
    checkpoint = tmp_path / 'm.pt'
    environ = {'FORMIAI_V2_E2_CHECKPOINT': str(checkpoint)}
    assert availability(MODELS['V2-E2'], tmp_path, environ) == (False, 'V2-E2 checkpoint not found')
    checkpoint.write_bytes(b'not the frozen checkpoint')
    assert availability(MODELS['V2-E2'], tmp_path, environ)[0] is False
    matching = dataclasses.replace(MODELS['V2-E2'], sha256=hashlib.sha256(b'not the frozen checkpoint').hexdigest())
    assert availability(matching, tmp_path, environ) == (True, '')
    assert availability(MODELS['OD-E2-N'], tmp_path, {}) == (True, '')


@pytest.fixture
def api(tmp_path, monkeypatch):
    research = tmp_path / 'research'
    (research / 'artifacts' / 'product_runs').mkdir(parents=True)
    (research / 'clip.mp4').write_bytes(b'synthetic')
    store = Store(tmp_path / 'data' / 'formiai.sqlite3')
    started = []
    monkeypatch.setattr(main, 'research', research.resolve())
    monkeypatch.setattr(main, 'runs_root', (research / 'artifacts' / 'product_runs').resolve())
    monkeypatch.setattr(main, 'store', store)
    monkeypatch.setattr(main, 'data_dir', tmp_path / 'data')
    monkeypatch.setattr(main.threading, 'Thread', lambda target, daemon: types.SimpleNamespace(start=lambda: started.append(target)))
    monkeypatch.delenv('FORMIAI_V2_E2_CHECKPOINT', raising=False)
    return types.SimpleNamespace(client=TestClient(main.app), store=store, started=started, tmp=tmp_path)


def test_models_endpoint_lists_v2_e2_as_default_experimental(api):
    body = api.client.get('/api/models').json()
    assert body['default'] == 'V2-E2'
    by_id = {item['id']: item for item in body['models']}
    assert by_id['V2-E2']['experimental'] is True and by_id['V2-E2']['available'] is False
    assert by_id['OD-E2-N']['experimental'] is False and by_id['OD-E2-N']['available'] is True


def test_job_with_unavailable_v2_e2_is_refused_and_never_falls_back(api):
    response = api.client.post('/api/jobs', json={'source_name': 'clip.mp4'})
    assert response.status_code == 409 and 'V2-E2' in response.text
    assert api.store.processing_jobs() == [] and api.started == []


def test_job_records_the_selected_model_before_it_starts(api, monkeypatch):
    checkpoint = api.tmp / 'v2.pt'
    checkpoint.write_bytes(b'verified bytes')
    monkeypatch.setenv('FORMIAI_V2_E2_CHECKPOINT', str(checkpoint))
    monkeypatch.setitem(MODELS, 'V2-E2', dataclasses.replace(MODELS['V2-E2'], sha256=hashlib.sha256(b'verified bytes').hexdigest()))
    job = api.client.post('/api/jobs', json={'source_name': 'clip.mp4'}).json()
    assert job['model']['id'] == 'V2-E2' and job['model']['experimental'] is True and job['model']['confidence'] == 0.5
    command = json.loads(api.store.get_job(job['id'])['command_json'])
    assert str(V2_E2_RUNNER) in command and command[command.index('--confidence') + 1] == '0.5'
    # The record sits beside the run, not inside it: Ants-2 needs an empty output directory.
    run = Path(api.store.get_job(job['id'])['output_dir'])
    assert not run.exists() and main.model_record_path(run).is_file()
    # Same video, other model, while the first is running: refused rather than silently reused.
    assert api.client.post('/api/jobs', json={'source_name': 'clip.mp4', 'model': 'OD-E2-N'}).status_code == 409
    assert api.client.post('/api/jobs', json={'source_name': 'clip.mp4', 'model': 'V2-E2'}).json()['id'] == job['id']


def test_od_e2_n_job_keeps_its_command_and_confidence(api):
    job = api.client.post('/api/jobs', json={'source_name': 'clip.mp4', 'model': 'OD-E2-N'}).json()
    command = json.loads(api.store.get_job(job['id'])['command_json'])
    assert command[:4] == ['uv', 'run', 'formicai', 'analyze-video']
    assert command[command.index('--detector-role') + 1] == 'own_colony' and command[command.index('--confidence') + 1] == '0.25'
    assert job['model']['experimental'] is False


def load_runner():
    spec = importlib.util.spec_from_file_location('experimental_v2_e2', V2_E2_RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fake_formicai(monkeypatch):
    registry, calls = {}, {}

    def original(role):
        return (Path('original.pt'), 'original-sha')

    def analyze(config):
        calls['config'] = config
        return types.SimpleNamespace(summary=types.SimpleNamespace(total_frames=3))

    runner = types.SimpleNamespace(resolve_detector_role=original, VideoAnalysisConfig=lambda **kw: kw, analyze_video=analyze)
    spec_module = types.SimpleNamespace(DETECTOR_REGISTRY=registry, DetectorSpec=lambda **kw: types.SimpleNamespace(**kw))
    package = types.ModuleType('formicai')
    detection = types.ModuleType('formicai.detection')
    analysis = types.ModuleType('formicai.video_analysis')
    detection.spec = spec_module
    analysis.runner = runner
    for name, module in {'formicai': package, 'formicai.detection': detection, 'formicai.detection.spec': spec_module,
                         'formicai.video_analysis': analysis, 'formicai.video_analysis.runner': runner}.items():
        monkeypatch.setitem(sys.modules, name, module)
    return registry, calls, runner


def test_runner_registers_the_experimental_role_in_memory_only(tmp_path, monkeypatch):
    registry, calls, runner = fake_formicai(monkeypatch)
    checkpoint = tmp_path / 'v2.pt'
    checkpoint.write_bytes(b'verified bytes')
    sha = hashlib.sha256(b'verified bytes').hexdigest()
    module = load_runner()
    assert module.main(['--video', 'v.mp4', '--output', 'o', '--progress-dir', 'p', '--checkpoint', str(checkpoint),
                        '--sha256', sha, '--confidence', '0.5', '--device', 'cpu']) == 0
    spec = registry[module.ROLE]
    assert (spec.status, spec.confidence, spec.sha256, spec.image_size, spec.iou, spec.end2end) == ('experimental', 0.5, sha, 640, 0.7, False)
    assert 'experimental' in spec.experiment
    assert calls['config']['detector_role'] == module.ROLE and calls['config']['confidence'] == 0.5
    assert runner.resolve_detector_role(module.ROLE) == (checkpoint, sha)
    assert runner.resolve_detector_role('own_colony') == (Path('original.pt'), 'original-sha')


def test_runner_aborts_on_sha_mismatch_before_touching_ants_2(tmp_path, monkeypatch):
    for name in [n for n in sys.modules if n.startswith('formicai')]:
        monkeypatch.delitem(sys.modules, name)
    monkeypatch.setitem(sys.modules, 'formicai', None)  # any import of Ants-2 would raise ImportError
    checkpoint = tmp_path / 'other.pt'
    checkpoint.write_bytes(b'a different model')
    module = load_runner()
    common = ['--video', 'v.mp4', '--output', 'o', '--progress-dir', 'p', '--sha256', FROZEN, '--confidence', '0.5']
    with pytest.raises(ValueError, match='SHA256 mismatch'):
        module.main(common + ['--checkpoint', str(checkpoint)])
    with pytest.raises(FileNotFoundError):
        module.main(common + ['--checkpoint', str(tmp_path / 'missing.pt')])


def test_restart_marks_unfinished_jobs_failed_so_the_video_can_be_analysed_again(api):
    run = main.runs_root / 'stale'
    api.store.job('stale', 'processing', 'clip.mp4', run, [])
    main.bootstrap()
    row = api.store.get_job('stale')
    assert row['status'] == 'failed' and 'Interrupted' in row['message']
    assert api.store.processing_for_source('clip.mp4') is None


def test_approved_video_can_be_previewed_before_analysis(api):
    assert api.client.get('/api/input-videos/clip.mp4/video').content == b'synthetic'
    assert api.client.get('/api/input-videos/missing.mp4/video').status_code == 404
    assert api.client.get('/api/input-videos/clip.txt/video').status_code == 404
    assert api.client.get('/api/input-videos/..%2Foutside.mp4/video').status_code == 404
    assert api.store.processing_jobs() == []  # watching a video never starts an analysis
