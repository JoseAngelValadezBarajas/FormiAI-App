from __future__ import annotations
import json, os
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from .models import *
research=Path(os.environ.get('FORMIAI_RESEARCH_ROOT',r'C:\Dev\Ants-2')); run=research/'artifacts/analysis/va_001_031026_1'; app=FastAPI(title='FormiAI Product Adapter')
def session():
 p=run/'analysis.json'
 if not p.exists(): raise HTTPException(404,'No configured analysis artifact')
 a=json.loads(p.read_text()); s=a['summary']; files=['analyzed_video.mp4','occupancy_heatmap.png','activity_timeline.csv','analysis.json','analysis_summary.md']
 return AnalysisSession(id='va-001-031026-1',status='ready',summary=AnalysisSummary(total_frames=s['total_frames'],duration_seconds=s['duration_seconds'],mean_visible_ants=s['mean_visible_ants'],total_detections=s['total_detections']),timeline=[TimelineSample(timestamp_seconds=x['timestamp_seconds'],visible_ants=x['visible_ants'],activity_index=x['activity_index']) for x in a['activity_timeline']],occupancy=SpatialOccupancy(grid_width=a['spatial_heatmap']['grid_width'],grid_height=a['spatial_heatmap']['grid_height'],heatmap_url='/api/artifacts/occupancy_heatmap.png'),provenance=Provenance(detector=a['detector'],tracker=a['tracker'],thresholds=a['thresholds'],source_sha256=a['source']['sha256']),exports=[AvailableExport(name=f,url=f'/api/artifacts/{f}') for f in files if (run/f).exists()])
@app.get('/api/sessions/current',response_model=AnalysisSession)
def current(): return session()
@app.get('/api/artifacts/{name}')
def artifact(name:str):
 f=run/Path(name).name
 if not f.is_file(): raise HTTPException(404)
 return FileResponse(f)
