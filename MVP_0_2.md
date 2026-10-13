# FormiAI MVP 0.2: Progressive Visual Analysis

## Contract and lifecycle

`formicai analyze-video` now writes `formiai_progress/manifest.json` and
`batch-NNNNNN.json` beside the eventual final artifacts.  Each batch is a
complete JSON document, written to a temporary sibling then atomically renamed.
It is a product transport artifact, not a replacement for
`video_analysis.predictions.jsonl`, tracks, or `analysis.json`.

The version-1 batch contract is:

```json
{"schema_version":1,"kind":"formiai.progress.batch","sequence":1,
 "fps":60.0,"frame_count":2445,"processed_through_frame":7,
 "frames":[{"frame_index":7,"timestamp_seconds":0.116667,
 "detections":[{"bbox":[x1,y1,x2,y2],"confidence":0.91,
 "track_id":12,"detection_index":0}]}]}
```

The values are emitted immediately after the existing detector and online
provisional tracker have processed a frame. They do not change the detector,
tracker, analytics, or final serialization path. A consumer must use the frame
index/timestamp, not event arrival time, and must never interpolate a box.

FastAPI exposes `GET /api/jobs/{id}/events` as SSE. `detections` events have
an event id equal to the immutable batch sequence. Clients reconnect with
`Last-Event-ID` (or `?after=`) and receive only later batches. `progress`,
`complete`, and `error` events are separate from video playback. The server
only parses renamed batch files, so it never consumes a partial JSONL/artifact.

`GET /api/jobs/{id}/source-video` serves only the approved research-root source
named in the persisted job. Existing final review continues to use the separate,
validated H.264 presentation derivative. The observed input `031026_1.mp4` is
already H.264/yuv420p (1920x1080, 60.027 FPS), so it is browser-playable; other
source formats require the existing presentation-media validation/derivation
before claiming progressive browser playback.

The UI starts one job when the user changes the selected video. The backend
returns the existing job for the same source while it is processing, avoiding a
duplicate command. It keeps an adaptive bounded in-memory window: received
frames are indexed by frame number, and playback pauses with an explicit
buffering state when it reaches `processed_through_frame`. Already received
frames can be replayed or sought. No detection is displayed for an unavailable
frame.

## Measurements (2026-10-10)

Environment: RTX 4060 Laptop GPU visible to `nvidia-smi`, but the active
Ants-2 virtual environment is `torch 2.13.0+cpu` (`cuda=False`), so no GPU
throughput is claimed. On 16 real 1920x1080 frames from `031026_1.mp4`,
OD-E2-N at 640 with BoT-SORT measured 10.80 inference FPS and 8.71 FPS for
inference plus tracking; first processed frame took 1.191 s. The source is
60.027 FPS, therefore buffering is necessary on this installation.

An end-to-end real 61-frame (1.0 s) clip run, including decode, inference,
tracking, annotated-video writing, atomic progress publication, final artifacts
and analytics, completed in 6.691 s (9.12 processed FPS) and published eight
batches. Its first batch had frames 0--7, real boxes, confidence, and
provisional IDs. These measurements do not separate final-artifact cost from
the full pipeline and make no web-delivery latency claim.

## Recovery and limits

After server reconnection/restart, the persisted job output directory and the
immutable batch names replay SSE without rerunning inference. A process that is
interrupted before finalization remains `processing` under the MVP 0.1 recovery
rules; its complete already-published frames are still readable, but it is not
presented as a completed scientific review. The source-file duration/FPS
assumption is inherited from the scientific runner (`timestamp = index / fps`);
variable-frame-rate sources need a scientific-pipeline timestamp model before
they can be represented with stricter PTS fidelity.

## Final certification: CUDA and browser (2026-10-12)

The RTX 4060 Laptop GPU is enabled with the official PyTorch CUDA 12.6 wheels:
`torch 2.13.0+cu126`, `torchvision 0.28.0+cu126`, Python 3.12.10, NVIDIA driver
617.42, and compute capability 8.9. These are explicit `ml` dependencies in
Ants-2's lockfile so `uv sync --extra ml --group dev` preserves the GPU build.
`FORMIAI_DEVICE` defaults to `cuda:0` and may be explicitly set to `cpu` on a
non-CUDA host; the execution device does not alter detector identity, weights,
thresholds, or artifacts.

On the same first 32 1920x1080 frames of `031026_1.mp4`, using OD-E2-N,
640 pixels, confidence .25 and BoT-SORT: CPU measured 4.765 inference FPS,
4.284 pipeline FPS, and 6.088 s to first processed frame. CUDA measured 42.715
inference FPS, 23.536 pipeline FPS, and 0.443 s to first frame. PyTorch reported
55.7 MiB peak allocated VRAM; `nvidia-smi` observed roughly 2.1 GiB total GPU
memory while the complete product pipeline was active. These are measurements,
not claims of changed scientific output.

Playwright 1.64/Chromium performed a real 481-frame H.264 run through FastAPI,
Vite, SSE and CUDA. It verified automatic start on selection, atomic batches,
non-empty Canvas boxes with P-ID/confidence, buffering state, mobile Canvas
resizing, final Review, exports, and no console or non-aborted network errors.
The test screenshots are written to `frontend/test-results/progressive-desktop.png`
and `progressive-mobile.png` during certification.
