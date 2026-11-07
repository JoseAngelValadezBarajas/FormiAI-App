"""FormiAI-side runner for the EXPERIMENTAL V2-E2 epoch-45 detector.

This is a FormiAI adapter, not an Ants-2 API. Ants-2 registers no V2-E2 detector role, so this script
registers one in memory, inside its own process, and then calls Ants-2's unchanged `analyze_video`.
No Ants-2 file is modified. The checkpoint must match the frozen SHA-256 before anything is registered;
a mismatch aborts the run and never falls back to another model.

Run with the Ants-2 environment and the research root as working directory (the backend does this):
    uv run python runners/experimental_v2_e2.py --video V --output O --progress-dir P --checkpoint C --sha256 H
Frozen inference settings (docs/experiment_reports/det_v2_final_blind_test_protocol.json): imgsz 640,
NMS IoU 0.70, end2end false; operating confidence 0.50 is passed by the caller.
"""
from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

ROLE = 'experimental_v2_e2_epoch45'
EXPERIMENT = 'V2-E2 epoch 45 (experimental)'


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--video', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--progress-dir', type=Path, required=True)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--confidence', type=float, required=True)
    parser.add_argument('--device', default='cpu')
    args = parser.parse_args(argv)

    # Identity first, before importing or registering anything: a wrong file must never reach the detector.
    if not args.checkpoint.is_file():
        raise FileNotFoundError(f'V2-E2 checkpoint not found: {args.checkpoint}')
    digest = hashlib.sha256()
    with args.checkpoint.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    actual = digest.hexdigest()
    if actual != args.sha256:
        raise ValueError(f'V2-E2 checkpoint SHA256 mismatch: expected {args.sha256}, found {actual}')

    from formicai.detection.spec import DETECTOR_REGISTRY, DetectorSpec
    import formicai.video_analysis.runner as runner

    DETECTOR_REGISTRY[ROLE] = DetectorSpec(
        experiment=EXPERIMENT, role=ROLE, model_path=args.checkpoint, sha256=actual, status='experimental',
        confidence=args.confidence, iou=0.70, image_size=640, end2end=False, classes={0: 'ant'})
    original = runner.resolve_detector_role

    def resolve(role: str):
        # Only this process's experimental role is intercepted; every other role resolves through Ants-2.
        return (args.checkpoint, actual) if role == ROLE else original(role)

    runner.resolve_detector_role = resolve
    result = runner.analyze_video(runner.VideoAnalysisConfig(
        video_path=args.video, output_dir=args.output, detector_role=ROLE,
        confidence=args.confidence, device=args.device, progress_dir=args.progress_dir))
    print(f'{EXPERIMENT}: {result.summary.total_frames} frames; confidence {args.confidence}', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
