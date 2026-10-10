from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

PRESENTATION_VIDEO = 'analyzed_video.web.mp4'
PRESENTATION_PROVENANCE = 'presentation_media.json'
_validation_cache: dict[str, tuple[tuple[tuple[int, int], ...], bool]] = {}


class MediaPreparationError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def ffprobe(path: Path, count_frames: bool = False) -> dict:
    command = ['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height,pix_fmt,avg_frame_rate,nb_read_frames', '-of', 'json']
    if count_frames:
        command.append('-count_frames')
    command.append(str(path))
    completed = subprocess.run(command, capture_output=True, check=False)
    if completed.returncode:
        raise MediaPreparationError(completed.stderr.decode('utf-8', errors='replace')[-1000:])
    return json.loads(completed.stdout)


def video_stream(probe: dict) -> dict:
    stream = next((item for item in probe.get('streams', []) if item.get('codec_type') == 'video'), None)
    if not stream:
        raise MediaPreparationError('ffprobe did not find a video stream')
    return stream


def valid_presentation(source_probe: dict, presentation_probe: dict) -> bool:
    source_video, presentation_video = video_stream(source_probe), video_stream(presentation_probe)
    source_duration = float(source_probe['format']['duration'])
    presentation_duration = float(presentation_probe['format']['duration'])
    source_frames = source_video.get('nb_read_frames')
    presentation_frames = presentation_video.get('nb_read_frames')
    return (
        presentation_video.get('codec_name') == 'h264'
        and presentation_video.get('pix_fmt') == 'yuv420p'
        and source_video.get('width') == presentation_video.get('width')
        and source_video.get('height') == presentation_video.get('height')
        and abs(source_duration - presentation_duration) <= 0.1
        and (not source_frames or not presentation_frames or source_frames == presentation_frames)
    )


def presentation_ready(run: Path) -> bool:
    source, presentation, provenance = run / 'analyzed_video.mp4', run / PRESENTATION_VIDEO, run / PRESENTATION_PROVENANCE
    if not (source.is_file() and presentation.is_file() and provenance.is_file()):
        return False
    fingerprint = tuple((path.stat().st_mtime_ns, path.stat().st_size) for path in (source, presentation, provenance))
    cached = _validation_cache.get(str(run.resolve()))
    if cached and cached[0] == fingerprint:
        return cached[1]
    try:
        metadata = json.loads(provenance.read_text(encoding='utf-8'))
        valid = metadata.get('source_sha256') == sha256(source) and metadata.get('presentation_sha256') == sha256(presentation) and valid_presentation(ffprobe(source, True), ffprobe(presentation, True))
    except (OSError, ValueError, KeyError, MediaPreparationError):
        valid = False
    _validation_cache[str(run.resolve())] = (fingerprint, valid)
    return valid


def prepare_presentation_media(run: Path) -> dict:
    source, presentation, provenance = run / 'analyzed_video.mp4', run / PRESENTATION_VIDEO, run / PRESENTATION_PROVENANCE
    if not source.is_file():
        raise MediaPreparationError('Scientific analyzed_video.mp4 is missing')
    if presentation_ready(run):
        return json.loads(provenance.read_text(encoding='utf-8'))

    source_hash = sha256(source)
    source_probe = ffprobe(source, True)
    with tempfile.NamedTemporaryFile(suffix='.mp4', dir=run, delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(source), '-map', '0:v:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-fps_mode', 'passthrough', str(temporary_path)]
        completed = subprocess.run(command, capture_output=True, check=False)
        if completed.returncode:
            raise MediaPreparationError(completed.stderr.decode('utf-8', errors='replace')[-2000:])
        presentation_probe = ffprobe(temporary_path, True)
        if not valid_presentation(source_probe, presentation_probe):
            raise MediaPreparationError('Presentation media did not preserve validated video properties')
        metadata = {
            'schema_version': 1,
            'kind': 'presentation_video',
            'source_name': source.name,
            'source_sha256': source_hash,
            'presentation_name': PRESENTATION_VIDEO,
            'presentation_sha256': sha256(temporary_path),
            'ffmpeg_command': command[:-1] + [PRESENTATION_VIDEO],
            'source_probe': source_probe,
            'presentation_probe': presentation_probe,
        }
        temporary_metadata = provenance.with_suffix('.tmp.json')
        temporary_metadata.write_text(json.dumps(metadata, indent=2), encoding='utf-8')
        os.replace(temporary_path, presentation)
        os.replace(temporary_metadata, provenance)
        fingerprint = tuple((path.stat().st_mtime_ns, path.stat().st_size) for path in (source, presentation, provenance))
        _validation_cache[str(run.resolve())] = (fingerprint, True)
        return metadata
    finally:
        if temporary_path.exists():
            temporary_path.unlink()
