import json

from app.media import PRESENTATION_PROVENANCE, PRESENTATION_VIDEO, presentation_ready, valid_presentation


def probe(codec: str, duration: float = 4.0, frames: str = '240'):
    return {'format': {'duration': str(duration)}, 'streams': [{'codec_type': 'video', 'codec_name': codec, 'width': 1920, 'height': 1080, 'pix_fmt': 'yuv420p', 'nb_read_frames': frames}]}


def test_valid_presentation_requires_browser_codec_and_temporal_match():
    assert valid_presentation(probe('mpeg4'), probe('h264'))
    assert not valid_presentation(probe('mpeg4'), probe('h264', duration=4.2))
    assert not valid_presentation(probe('mpeg4'), probe('mpeg4'))
    assert not valid_presentation(probe('mpeg4'), probe('h264', frames='239'))


def test_presentation_is_not_available_without_validated_provenance(tmp_path):
    (tmp_path / 'analyzed_video.mp4').write_bytes(b'scientific')
    (tmp_path / PRESENTATION_VIDEO).write_bytes(b'presentation')
    (tmp_path / PRESENTATION_PROVENANCE).write_text(json.dumps({'source_sha256': 'wrong', 'presentation_sha256': 'wrong'}), encoding='utf-8')
    assert not presentation_ready(tmp_path)
