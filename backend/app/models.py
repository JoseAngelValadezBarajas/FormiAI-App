from pydantic import BaseModel, Field
from typing import Literal
class TimelineSample(BaseModel): timestamp_seconds: float; visible_ants:int; activity_index:float
class AnalysisSummary(BaseModel): total_frames:int; duration_seconds:float; mean_visible_ants:float; total_detections:int
class SpatialOccupancy(BaseModel): grid_width:int; grid_height:int; heatmap_url:str|None=None
class Provenance(BaseModel): detector:dict; tracker:dict; thresholds:dict; source_sha256:str
class AvailableExport(BaseModel): name:str; url:str
class AnalysisSession(BaseModel): schema_version:Literal[1]=1; id:str; status:Literal['ready','processing','failed']; summary:AnalysisSummary|None=None; timeline:list[TimelineSample]=Field(default_factory=list); occupancy:SpatialOccupancy|None=None; provenance:Provenance|None=None; exports:list[AvailableExport]=Field(default_factory=list)
class ProcessingJob(BaseModel): id:str; status:Literal['processing','complete','failed']; source_name:str; session_id:str|None=None; message:str=''
class CreateJobRequest(BaseModel): source_name:str = Field(pattern=r'^[A-Za-z0-9_.-]+\.mp4$')
