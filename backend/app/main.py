from __future__ import annotations
import json, os, subprocess, threading, uuid
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from .models import *
from .storage import Store
research=Path(os.environ.get('FORMIAI_RESEARCH_ROOT',r'C:\Dev\Ants-2')).resolve(); runs_root=(research/'artifacts'/'product_runs').resolve(); store=Store(Path(os.environ.get('FORMIAI_DATA_DIR',Path.cwd().parent/'data'))/'formiai.sqlite3'); app=FastAPI(title='FormiAI Product Adapter')
ARTIFACT_NAMES=('analyzed_video.mp4','occupancy_heatmap.png','activity_timeline.csv','analysis.json','analysis_summary.md','video_analysis.predictions.jsonl','video_analysis_tracks.tracks.jsonl','video_analysis.run.json','video_analysis_tracks.run.json')
def safe_under(path:Path,parent:Path)->bool:
    try:path.resolve().relative_to(parent.resolve());return True
    except ValueError:return False
def session_from(id:str,run:Path):
 p=run/'analysis.json'
 if not p.exists(): raise HTTPException(404,'No configured analysis artifact')
 a=json.loads(p.read_text()); s=a['summary']; files=ARTIFACT_NAMES
 return AnalysisSession(id=id,status='ready',summary=AnalysisSummary(total_frames=s['total_frames'],duration_seconds=s['duration_seconds'],mean_visible_ants=s['mean_visible_ants'],total_detections=s['total_detections']),timeline=[TimelineSample(timestamp_seconds=x['timestamp_seconds'],visible_ants=x['visible_ants'],activity_index=x['activity_index']) for x in a['activity_timeline']],occupancy=SpatialOccupancy(grid_width=a['spatial_heatmap']['grid_width'],grid_height=a['spatial_heatmap']['grid_height'],heatmap_url=f'/api/sessions/{id}/artifacts/occupancy_heatmap.png'),provenance=Provenance(detector=a['detector'],tracker=a['tracker'],thresholds=a['thresholds'],source_sha256=a['source']['sha256']),exports=[AvailableExport(name=f,url=f'/api/sessions/{id}/artifacts/{f}') for f in files if (run/f).exists()])
@app.on_event('startup')
def bootstrap():
    existing=research/'artifacts'/'analysis'/'va_001_031026_1'
    if (existing/'analysis.json').is_file(): store.session('va-001-031026-1',existing)
    # A server restart must not strand a completed core run in a fake processing state.
    for job in store.processing_jobs():
        output=Path(job['output_dir'])
        if safe_under(output,runs_root) and (output/'analysis.json').is_file():
            store.session(job['id'],output);store.update_job(job['id'],'complete','Recovered completed artifact after server restart.',job['id'])
@app.get('/api/input-videos')
def inputs(): return {'videos':[p.name for p in research.glob('*.mp4') if p.is_file()]}
@app.get('/api/sessions/{session_id}',response_model=AnalysisSession)
def get_session(session_id:str):
    row=store.get_session(session_id)
    if not row: raise HTTPException(404,'Unknown session')
    return session_from(session_id,Path(row['artifact_dir']))
@app.post('/api/jobs',response_model=ProcessingJob,status_code=202)
def create_job(req:CreateJobRequest):
    source=(research/req.source_name).resolve()
    if not safe_under(source,research) or not source.is_file(): raise HTTPException(404,'Input video is not an approved research-root video')
    job_id=uuid.uuid4().hex; output=(runs_root/job_id).resolve(); command=['uv','run','formicai','analyze-video',str(source),'--output',str(output),'--detector-role','own_colony','--confidence','0.25']
    store.job(job_id,'processing',source.name,output,command)
    def execute():
        try:
            completed=subprocess.run(command,cwd=research,capture_output=True,check=False)
            log=(completed.stdout+ b'\n'+completed.stderr).decode('utf-8',errors='replace')[-4000:]
            if completed.returncode==0 and (output/'analysis.json').is_file():
                store.session(job_id,output);store.update_job(job_id,'complete',log,job_id)
            else: store.update_job(job_id,'failed',log)
        except Exception as error:
            store.update_job(job_id,'failed',f'Runner exception: {error}')
    threading.Thread(target=execute,daemon=True).start()
    return ProcessingJob(id=job_id,status='processing',source_name=source.name)
@app.get('/api/jobs/{job_id}',response_model=ProcessingJob)
def get_job(job_id:str):
    row=store.get_job(job_id)
    if not row: raise HTTPException(404,'Unknown job')
    return ProcessingJob(id=row['id'],status=row['status'],source_name=row['source_name'],session_id=row['session_id'],message=row['message'])
@app.get('/api/sessions/{session_id}/artifacts/{name}')
def artifact(session_id:str,name:str):
 if name not in ARTIFACT_NAMES: raise HTTPException(404)
 row=store.get_session(session_id)
 if not row: raise HTTPException(404)
 run=Path(row['artifact_dir']).resolve(); f=(run/Path(name).name).resolve()
 if not safe_under(f,run): raise HTTPException(403)
 if not f.is_file(): raise HTTPException(404)
 return FileResponse(f)
