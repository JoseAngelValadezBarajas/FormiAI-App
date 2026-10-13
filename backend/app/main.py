from __future__ import annotations

import asyncio
import json
import os
import subprocess
import threading
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse

from .media import PRESENTATION_PROVENANCE, PRESENTATION_VIDEO, MediaPreparationError, prepare_presentation_media, presentation_ready
from .models import AnalysisSession, AnalysisSummary, AvailableExport, CreateJobRequest, PresentationVideo, ProcessingJob, ProgressState, Provenance, SpatialOccupancy, TimelineSample
from .storage import Store

research = Path(os.environ.get('FORMIAI_RESEARCH_ROOT', r'C:\Dev\Ants-2')).resolve()
runs_root = (research / 'artifacts' / 'product_runs').resolve()
analysis_device = os.environ.get('FORMIAI_DEVICE', 'cuda:0')
store = Store(Path(os.environ.get('FORMIAI_DATA_DIR', Path.cwd().parent / 'data')) / 'formiai.sqlite3')
app = FastAPI(title='FormiAI Product Adapter')
ARTIFACT_NAMES = ('analyzed_video.mp4', PRESENTATION_VIDEO, PRESENTATION_PROVENANCE, 'occupancy_heatmap.png', 'activity_timeline.csv', 'analysis.json', 'analysis_summary.md', 'video_analysis.predictions.jsonl', 'video_analysis_tracks.tracks.jsonl', 'video_analysis.run.json', 'video_analysis_tracks.run.json')
PROGRESS_DIRECTORY = 'formiai_progress'


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
    return AnalysisSession(id=session_id, status=status, summary=AnalysisSummary(total_frames=summary['total_frames'], duration_seconds=summary['duration_seconds'], mean_visible_ants=summary['mean_visible_ants'], total_detections=summary['total_detections']), timeline=[TimelineSample(timestamp_seconds=item['timestamp_seconds'], visible_ants=item['visible_ants'], activity_index=item['activity_index']) for item in analysis['activity_timeline']], occupancy=SpatialOccupancy(grid_width=analysis['spatial_heatmap']['grid_width'], grid_height=analysis['spatial_heatmap']['grid_height'], heatmap_url=f'/api/sessions/{session_id}/artifacts/occupancy_heatmap.png'), provenance=Provenance(detector=analysis['detector'], tracker=analysis['tracker'], thresholds=analysis['thresholds'], source_sha256=analysis['source']['sha256']), presentation_video=presentation, exports=exports)


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
                         progress=progress_from(Path(row['output_dir'])))


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
    active = store.processing_for_source(source.name)
    if active:
        return job_response(active)
    job_id = uuid.uuid4().hex
    output = (runs_root / job_id).resolve()
    command = ['uv', 'run', 'formicai', 'analyze-video', str(source), '--output', str(output), '--detector-role', 'own_colony', '--confidence', '0.25', '--device', analysis_device, '--progress-dir', str(output / PROGRESS_DIRECTORY)]
    store.job(job_id, 'processing', source.name, output, command)

    def execute() -> None:
        try:
            completed = subprocess.run(command, cwd=research, capture_output=True, check=False)
            log = (completed.stdout + b'\n' + completed.stderr).decode('utf-8', errors='replace')[-4000:]
            if completed.returncode == 0 and (output / 'analysis.json').is_file():
                register_ready_session(job_id, output)
                store.update_job(job_id, 'complete', log, job_id)
            else:
                store.update_job(job_id, 'failed', log)
        except Exception as error:
            store.update_job(job_id, 'failed', f'Runner or presentation-media exception: {error}')

    threading.Thread(target=execute, daemon=True).start()
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
                kind = 'complete' if current['status'] == 'complete' else 'error'
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
