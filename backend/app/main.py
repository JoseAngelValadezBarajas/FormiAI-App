from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import subprocess
import threading
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse

from .media import PRESENTATION_PROVENANCE, PRESENTATION_VIDEO, MediaPreparationError, prepare_presentation_media, presentation_ready
from .corrections import EXPORT_FILES, CorrectionError, CorrectionStore, list_exports, load_review, review_queue, source_info, write_export
from .model_registry import DEFAULT_MODEL, MODEL_RECORD, MODELS, availability, build_command, record
from .models import AnalysisSession, AnalysisSummary, AvailableExport, CreateJobRequest, PresentationVideo, ProcessingJob, ProgressState, Provenance, SpatialOccupancy, TimelineSample
from .storage import Store

research = Path(os.environ.get('FORMIAI_RESEARCH_ROOT', r'C:\Dev\Ants-2')).resolve()
runs_root = (research / 'artifacts' / 'product_runs').resolve()
analysis_device = os.environ.get('FORMIAI_DEVICE', 'cuda:0')
store = Store(Path(os.environ.get('FORMIAI_DATA_DIR', Path.cwd().parent / 'data')) / 'formiai.sqlite3')
app = FastAPI(title='FormiAI Product Adapter')
ARTIFACT_NAMES = ('analyzed_video.mp4', PRESENTATION_VIDEO, PRESENTATION_PROVENANCE, 'occupancy_heatmap.png', 'activity_timeline.csv', 'analysis.json', 'analysis_summary.md', 'video_analysis.predictions.jsonl', 'video_analysis_tracks.tracks.jsonl', 'video_analysis.run.json', 'video_analysis_tracks.run.json')
PROGRESS_DIRECTORY = 'formiai_progress'
jobs_lock = threading.Lock()
running_processes: dict[str, subprocess.Popen] = {}
cancelled_jobs: set[str] = set()


def terminate_tree(process: subprocess.Popen) -> None:
    """Stop the analysis and everything it spawned (`uv run` starts nested processes)."""
    if process.poll() is not None:
        return
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True, check=False)
    else:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
data_dir = store.path.parent


def model_record_path(run: Path) -> Path:
    # Outside the run directory: Ants-2 requires its output directory to be empty at start.
    return run.parent / f'{run.name}.{MODEL_RECORD}'


def model_record_of(run: Path) -> dict | None:
    try:
        return json.loads(model_record_path(run).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def safe_under(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def session_from(session_id: str, run: Path, status: str = 'ready') -> AnalysisSession:
    analysis_path = run / 'analysis.json'
    if not analysis_path.exists():
        raise HTTPException(404, 'No configured analysis artifact')
    analysis = json.loads(analysis_path.read_text(encoding='utf-8'))
    summary = analysis['summary']
    presentation = None
    if presentation_ready(run):
        media = json.loads((run / PRESENTATION_PROVENANCE).read_text(encoding='utf-8'))
        presentation = PresentationVideo(name=PRESENTATION_VIDEO, url=f'/api/sessions/{session_id}/artifacts/{PRESENTATION_VIDEO}', source_name=media['source_name'], source_sha256=media['source_sha256'], presentation_sha256=media['presentation_sha256'])
    exports = [AvailableExport(name=name, url=f'/api/sessions/{session_id}/artifacts/{name}') for name in ARTIFACT_NAMES if (run / name).is_file() and (name != PRESENTATION_VIDEO or presentation)]
    return AnalysisSession(id=session_id, status=status, summary=AnalysisSummary(total_frames=summary['total_frames'], duration_seconds=summary['duration_seconds'], mean_visible_ants=summary['mean_visible_ants'], total_detections=summary['total_detections']), timeline=[TimelineSample(timestamp_seconds=item['timestamp_seconds'], visible_ants=item['visible_ants'], activity_index=item['activity_index']) for item in analysis['activity_timeline']], occupancy=SpatialOccupancy(grid_width=analysis['spatial_heatmap']['grid_width'], grid_height=analysis['spatial_heatmap']['grid_height'], heatmap_url=f'/api/sessions/{session_id}/artifacts/occupancy_heatmap.png'), provenance=Provenance(detector=analysis['detector'], tracker=analysis['tracker'], thresholds=analysis['thresholds'], source_sha256=analysis['source']['sha256'], model=model_record_of(run)), presentation_video=presentation, exports=exports)


def register_ready_session(session_id: str, run: Path) -> None:
    prepare_presentation_media(run)
    store.session(session_id, run)


def progress_from(run: Path) -> ProgressState:
    """Read only complete batches published by atomic rename in Ants-2."""
    directory = run / PROGRESS_DIRECTORY
    manifest = directory / 'manifest.json'
    if not manifest.is_file():
        return ProgressState()
    try:
        metadata = json.loads(manifest.read_text(encoding='utf-8'))
        batches = sorted(directory.glob('batch-*.json'))
        completed = -1
        valid = 0
        for path in batches:
            batch = json.loads(path.read_text(encoding='utf-8'))
            if batch.get('schema_version') != 1 or batch.get('kind') != 'formiai.progress.batch':
                continue
            completed = max(completed, int(batch['processed_through_frame']))
            valid += 1
        return ProgressState(fps=float(metadata['fps']), frame_count=int(metadata['frame_count']),
                             processed_through_frame=completed, batch_count=valid)
    except (OSError, ValueError, KeyError, TypeError):
        return ProgressState()


def progressive_batches(run: Path, after: int) -> list[dict]:
    directory = run / PROGRESS_DIRECTORY
    result: list[dict] = []
    for path in sorted(directory.glob('batch-*.json')):
        try:
            batch = json.loads(path.read_text(encoding='utf-8'))
            sequence = int(batch['sequence'])
            if sequence > after and batch.get('schema_version') == 1 and batch.get('kind') == 'formiai.progress.batch':
                result.append(batch)
        except (OSError, ValueError, KeyError, TypeError):
            # A .json is expected to be complete due to os.replace; malformed files are never events.
            continue
    return result


def job_response(row: dict) -> ProcessingJob:
    return ProcessingJob(id=row['id'], status=row['status'], source_name=row['source_name'],
                         session_id=row['session_id'], message=row['message'],
                         source_video_url=f"/api/jobs/{row['id']}/source-video",
                         progress=progress_from(Path(row['output_dir'])), model=model_record_of(Path(row['output_dir'])))


@app.on_event('startup')
def bootstrap() -> None:
    historical = research / 'artifacts' / 'analysis' / 'va_001_031026_1'
    if (historical / 'analysis.json').is_file():
        try:
            register_ready_session('va-001-031026-1', historical)
        except MediaPreparationError:
            store.session('va-001-031026-1', historical, 'failed')
    for job in store.processing_jobs():
        output = Path(job['output_dir'])
        if safe_under(output, runs_root) and (output / 'analysis.json').is_file():
            try:
                register_ready_session(job['id'], output)
                store.update_job(job['id'], 'complete', 'Recovered completed artifact after server restart.', job['id'])
            except MediaPreparationError as error:
                store.update_job(job['id'], 'failed', f'Presentation media failed: {error}')
        else:
            # Jobs run as threads of this process, so none can still be running at startup: nothing would
            # ever register its result. Leaving it 'processing' would also block re-analysing the same video.
            store.update_job(job['id'], 'failed', 'Interrupted: the server restarted before the analysis finished.')


@app.get('/api/input-videos/{name}/video')
def input_video(name: str) -> FileResponse:
    """Lets the user watch an approved research-root video before choosing to analyse it."""
    if not re.fullmatch(r'[A-Za-z0-9_.-]+\.mp4', name):
        raise HTTPException(404, 'Unknown video')
    source = (research / name).resolve()
    if not safe_under(source, research) or not source.is_file():
        raise HTTPException(404, 'Approved source video is unavailable')
    return FileResponse(source, media_type='video/mp4')


@app.get('/api/models')
def list_models() -> dict:
    items = []
    for choice in MODELS.values():
        usable, reason = availability(choice, data_dir, os.environ)
        items.append({'id': choice.id, 'label': choice.label, 'experimental': choice.experimental,
                      'confidence': choice.confidence, 'available': usable, 'reason': reason})
    return {'default': DEFAULT_MODEL, 'models': items}


@app.get('/api/input-videos')
def inputs() -> dict:
    return {'videos': [path.name for path in research.glob('*.mp4') if path.is_file()]}


@app.get('/api/sessions/{session_id}', response_model=AnalysisSession)
def get_session(session_id: str) -> AnalysisSession:
    row = store.get_session(session_id)
    if not row:
        raise HTTPException(404, 'Unknown session')
    return session_from(session_id, Path(row['artifact_dir']), row['status'])


@app.post('/api/jobs', response_model=ProcessingJob, status_code=202)
def create_job(request: CreateJobRequest) -> ProcessingJob:
    source = (research / request.source_name).resolve()
    if not safe_under(source, research) or not source.is_file():
        raise HTTPException(404, 'Input video is not an approved research-root video')
    choice = MODELS[request.model]
    active = store.processing_for_source(source.name)
    if active:
        running = (model_record_of(Path(active['output_dir'])) or {}).get('id', 'OD-E2-N')  # jobs before the selector only ran OD-E2-N
        if running != choice.id:
            raise HTTPException(409, f'This video is already being analysed with {running or "another model"}')
        return job_response(active)
    usable, reason = availability(choice, data_dir, os.environ)
    if not usable:
        raise HTTPException(409, f'{choice.id} is unavailable: {reason}')
    job_id = uuid.uuid4().hex
    output = (runs_root / job_id).resolve()
    command = build_command(choice, source, output, output / PROGRESS_DIRECTORY, analysis_device, data_dir, os.environ)
    model_record_path(output).parent.mkdir(parents=True, exist_ok=True)
    model_record_path(output).write_text(json.dumps(record(choice), indent=2), encoding='utf-8')
    store.job(job_id, 'processing', source.name, output, command)

    def execute() -> None:
        try:
            group = {} if os.name == 'nt' else {'start_new_session': True}
            with jobs_lock:
                if job_id in cancelled_jobs:
                    return
                process = subprocess.Popen(command, cwd=research, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **group)
                running_processes[job_id] = process
            stdout, stderr = process.communicate()
            with jobs_lock:
                running_processes.pop(job_id, None)
                was_cancelled = job_id in cancelled_jobs
            if was_cancelled:
                return  # the cancel request already recorded the final state
            log = (stdout + b'\n' + stderr).decode('utf-8', errors='replace')[-4000:]
            if process.returncode == 0 and (output / 'analysis.json').is_file():
                register_ready_session(job_id, output)
                store.update_job(job_id, 'complete', log, job_id)
            else:
                store.update_job(job_id, 'failed', log)
        except Exception as error:
            with jobs_lock:
                running_processes.pop(job_id, None)
                was_cancelled = job_id in cancelled_jobs
            if not was_cancelled:
                store.update_job(job_id, 'failed', f'Runner or presentation-media exception: {error}')

    threading.Thread(target=execute, daemon=True).start()
    return job_response(store.get_job(job_id))


@app.post('/api/jobs/{job_id}/cancel', response_model=ProcessingJob)
def cancel_job(job_id: str) -> ProcessingJob:
    """Stop a running analysis. Partial files stay in the run directory but are never registered as a session."""
    row = store.get_job(job_id)
    if not row:
        raise HTTPException(404, 'Unknown job')
    if row['status'] == 'cancelled':
        return job_response(row)
    if row['status'] != 'processing':
        raise HTTPException(409, f"Job is already {row['status']}")
    with jobs_lock:
        cancelled_jobs.add(job_id)  # set before terminating so the runner thread never records a failure
        process = running_processes.get(job_id)
    if process:
        terminate_tree(process)
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            raise HTTPException(500, 'The analysis process did not stop')
    store.update_job(job_id, 'cancelled', 'Cancelled by the user before the analysis finished.')
    return job_response(store.get_job(job_id))


@app.get('/api/jobs/{job_id}', response_model=ProcessingJob)
def get_job(job_id: str) -> ProcessingJob:
    row = store.get_job(job_id)
    if not row:
        raise HTTPException(404, 'Unknown job')
    return job_response(row)


@app.get('/api/jobs/{job_id}/source-video')
def source_video(job_id: str) -> FileResponse:
    row = store.get_job(job_id)
    if not row:
        raise HTTPException(404, 'Unknown job')
    source = (research / row['source_name']).resolve()
    if not safe_under(source, research) or not source.is_file():
        raise HTTPException(404, 'Approved source video is unavailable')
    return FileResponse(source, media_type='video/mp4')


@app.get('/api/jobs/{job_id}/events')
async def job_events(job_id: str, request: Request, after: int = Query(-1, ge=-1)) -> StreamingResponse:
    """SSE replay stream. Event id is the immutable progress batch sequence."""
    row = store.get_job(job_id)
    if not row:
        raise HTTPException(404, 'Unknown job')
    try:
        cursor = max(after, int(request.headers.get('last-event-id', '-1')))
    except ValueError:
        cursor = after
    run = Path(row['output_dir'])

    async def events():
        nonlocal cursor
        yield f"event: progress\ndata: {json.dumps(progress_from(run).model_dump())}\n\n"
        while True:
            for batch in progressive_batches(run, cursor):
                cursor = int(batch['sequence'])
                yield f"id: {cursor}\nevent: detections\ndata: {json.dumps(batch, separators=(',', ':'))}\n\n"
            current = store.get_job(job_id)
            if current and current['status'] != 'processing':
                kind = {'complete': 'complete', 'cancelled': 'cancelled'}.get(current['status'], 'error')
                yield f"event: {kind}\ndata: {json.dumps(job_response(current).model_dump())}\n\n"
                return
            if await request.is_disconnected():
                return
            await asyncio.sleep(.2)
    return StreamingResponse(events(), media_type='text/event-stream', headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.get('/api/sessions/{session_id}/artifacts/{name}')
def artifact(session_id: str, name: str) -> FileResponse:
    if name not in ARTIFACT_NAMES:
        raise HTTPException(404)
    row = store.get_session(session_id)
    if not row:
        raise HTTPException(404)
    run = Path(row['artifact_dir']).resolve()
    file = (run / Path(name).name).resolve()
    if not safe_under(file, run):
        raise HTTPException(403)
    if name == PRESENTATION_VIDEO and not presentation_ready(run):
        raise HTTPException(404, 'Validated presentation video is not available')
    if not file.is_file():
        raise HTTPException(404)
    return FileResponse(file)


# --- Human review: corrections of detections, never of the analysis artifacts -------------------------------

def correction_store() -> CorrectionStore:
    return CorrectionStore(store.path)


def review_context(session_id: str, verified: bool = False):
    row = store.get_session(session_id)
    if not row:
        raise HTTPException(404, 'Unknown session')
    run = Path(row['artifact_dir'])
    try:
        data = load_review(run)
        source = source_info(data, research)
    except (OSError, KeyError, ValueError, CorrectionError) as error:
        raise HTTPException(404, f'This session has no reviewable analysis: {error}')
    if verified and not source['verified']:
        raise HTTPException(409, 'The source video is missing or does not match the analysed file (SHA-256)')
    return run, data, source


def guarded(action):
    try:
        return action()
    except CorrectionError as error:
        raise HTTPException(422, str(error))


@app.get('/api/annotation/sessions')
def annotation_sessions() -> dict:
    """Every analysed video with the progress of its annotation work, for the Anotación list."""
    corrections = correction_store()
    items = []
    for row in store.sessions():
        entry = {'id': row['id'], 'status': row['status']}
        try:
            run = Path(row['artifact_dir'])
            data = load_review(run)
            source = source_info(data, research)
        except (OSError, KeyError, ValueError, CorrectionError) as error:
            items.append({**entry, 'reviewable': False, 'reason': str(error)})
            continue
        past = list_exports(data_dir / 'exports', row['id'])
        items.append({**entry, 'reviewable': True, 'source': source, 'model': model_record_of(run), 'frame_count': len(data.frames),
                      'counts': corrections.counts(row['id']), 'complete_frames': len(corrections.complete_frames(row['id'])),
                      'last_export': past[-1] if past else None, 'last_activity': corrections.last_activity(row['id'])})
    return {'sessions': items}


@app.get('/api/sessions/{session_id}/review')
def review(session_id: str) -> dict:
    run, data, source = review_context(session_id)
    return {'source': source, 'confidence_floor': data.confidence_floor, 'detector': data.detector, 'model': model_record_of(run),
            'analysis_sha256': data.analysis_sha256,
            'frames': [[[*b['bbox'], b['confidence'], b['track_id']] for b in boxes] for boxes in data.frames]}


@app.get('/api/sessions/{session_id}/source-video')
def session_source_video(session_id: str) -> FileResponse:
    _, _, source = review_context(session_id, verified=True)
    return FileResponse((research / source['name']).resolve(), media_type='video/mp4')


@app.get('/api/sessions/{session_id}/review/state')
def review_state(session_id: str) -> dict:
    review_context(session_id)
    corrections = correction_store()
    return {'annotations': corrections.active(session_id), 'complete_frames': corrections.complete_frames(session_id)}


@app.get('/api/sessions/{session_id}/review/queue')
def review_queue_route(session_id: str, strategy: str = 'uncertain', limit: int = 50) -> dict:
    _, data, source = review_context(session_id)
    complete = set(correction_store().complete_frames(session_id))
    return {'strategy': strategy, 'frames': guarded(lambda: review_queue(data, complete, strategy, limit, source['fps']))}


@app.post('/api/sessions/{session_id}/corrections', status_code=201)
def create_correction(session_id: str, body: dict) -> dict:
    _, data, source = review_context(session_id, verified=True)
    return guarded(lambda: correction_store().create(session_id, data, source, body))


@app.patch('/api/sessions/{session_id}/corrections/{annotation_id}')
def move_correction(session_id: str, annotation_id: str, body: dict) -> dict:
    _, _, source = review_context(session_id, verified=True)
    return guarded(lambda: correction_store().move(session_id, source, annotation_id, body.get('bbox')))


@app.delete('/api/sessions/{session_id}/corrections/{annotation_id}')
def delete_correction(session_id: str, annotation_id: str) -> dict:
    review_context(session_id)
    if not correction_store().delete(session_id, annotation_id):
        raise HTTPException(404, 'Unknown or already removed annotation')
    return {'deleted': annotation_id}


@app.post('/api/sessions/{session_id}/corrections/{annotation_id}/restore')
def restore_correction(session_id: str, annotation_id: str) -> dict:
    review_context(session_id, verified=True)
    return guarded(lambda: correction_store().restore(session_id, annotation_id))


@app.put('/api/sessions/{session_id}/review/frames/{frame_index}/complete')
def mark_frame_complete(session_id: str, frame_index: int, body: dict) -> dict:
    _, data, _ = review_context(session_id, verified=True)
    complete = bool(body.get('complete'))
    guarded(lambda: correction_store().set_complete(session_id, frame_index, complete, len(data.frames)))
    return {'frame_index': frame_index, 'complete': complete}


@app.post('/api/sessions/{session_id}/exports', status_code=201)
def create_export(session_id: str) -> dict:
    run, data, source = review_context(session_id, verified=True)
    corrections = correction_store()
    return guarded(lambda: write_export(data_dir / 'exports', session_id, data, source, corrections.active(session_id),
                                        corrections.complete_frames(session_id), model_record_of(run)))


@app.get('/api/sessions/{session_id}/exports')
def exports(session_id: str) -> dict:
    review_context(session_id)
    return {'exports': list_exports(data_dir / 'exports', session_id)}


@app.get('/api/sessions/{session_id}/exports/{export_id}/{name}')
def export_file(session_id: str, export_id: str, name: str) -> FileResponse:
    review_context(session_id)
    if name not in EXPORT_FILES or not re.fullmatch(r'v\d{4}', export_id):
        raise HTTPException(404)
    file = (data_dir / 'exports' / session_id / export_id / name).resolve()
    if not file.is_file() or not safe_under(file, data_dir / 'exports'):
        raise HTTPException(404)
    return FileResponse(file)
