from typing import Literal

from pydantic import BaseModel, Field


class TimelineSample(BaseModel):
    timestamp_seconds: float
    visible_ants: int
    activity_index: float


class AnalysisSummary(BaseModel):
    total_frames: int
    duration_seconds: float
    mean_visible_ants: float
    total_detections: int


class SpatialOccupancy(BaseModel):
    grid_width: int
    grid_height: int
    heatmap_url: str | None = None


class Provenance(BaseModel):
    detector: dict
    tracker: dict
    thresholds: dict
    source_sha256: str


class AvailableExport(BaseModel):
    name: str
    url: str


class PresentationVideo(BaseModel):
    name: str
    url: str
    source_name: str
    source_sha256: str
    presentation_sha256: str


class AnalysisSession(BaseModel):
    schema_version: Literal[1] = 1
    id: str
    status: Literal['ready', 'processing', 'failed']
    summary: AnalysisSummary | None = None
    timeline: list[TimelineSample] = Field(default_factory=list)
    occupancy: SpatialOccupancy | None = None
    provenance: Provenance | None = None
    presentation_video: PresentationVideo | None = None
    exports: list[AvailableExport] = Field(default_factory=list)


class ProgressState(BaseModel):
    schema_version: Literal[1] = 1
    fps: float | None = None
    frame_count: int | None = None
    processed_through_frame: int = -1
    batch_count: int = 0


class ProcessingJob(BaseModel):
    id: str
    status: Literal['processing', 'complete', 'failed']
    source_name: str
    session_id: str | None = None
    message: str = ''
    source_video_url: str | None = None
    progress: ProgressState = Field(default_factory=ProgressState)


class CreateJobRequest(BaseModel):
    source_name: str = Field(pattern=r'^[A-Za-z0-9_.-]+\.mp4$')
