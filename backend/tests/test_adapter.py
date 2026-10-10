from app.models import AnalysisSummary, CreateJobRequest
from app.storage import Store

def test_summary_contract():
    assert AnalysisSummary(total_frames=1,duration_seconds=1,mean_visible_ants=0,total_detections=0).total_frames == 1

def test_job_rejects_path_traversal():
    assert CreateJobRequest.model_validate({'source_name':'valid.mp4'}).source_name == 'valid.mp4'
    try:
        CreateJobRequest.model_validate({'source_name':'../outside.mp4'})
    except ValueError:
        return
    raise AssertionError('path traversal was accepted')

def test_store_lists_processing_jobs(tmp_path):
    store=Store(tmp_path/'formiai.sqlite3')
    store.job('job-1','processing','valid.mp4',tmp_path/'run',['uv','run'])
    assert [job['id'] for job in store.processing_jobs()] == ['job-1']
