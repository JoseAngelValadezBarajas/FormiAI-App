from app.models import AnalysisSummary
def test_summary_contract(): assert AnalysisSummary(total_frames=1,duration_seconds=1,mean_visible_ants=0,total_detections=0).total_frames==1
