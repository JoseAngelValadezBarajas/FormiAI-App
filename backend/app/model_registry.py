"""Detector choices offered by the product, with the identity each one must prove before it runs."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
V2_E2_RUNNER = BACKEND_ROOT / 'runners' / 'experimental_v2_e2.py'
V2_E2_SHA256 = '9f162701b70a298646f98c9acb130277f3794a6037c285e07b27ef44c733a7c2'
MODEL_RECORD = 'formiai_model.json'
DEFAULT_MODEL = 'V2-E2'


@dataclass(frozen=True)
class ModelChoice:
    id: str
    label: str
    experimental: bool
    confidence: float
    sha256: str | None  # None: identity is enforced by Ants-2's own detector registry (role + SHA256)


MODELS = {
    'V2-E2': ModelChoice('V2-E2', 'V2-E2 · Experimental', True, 0.50, V2_E2_SHA256),
    'OD-E2-N': ModelChoice('OD-E2-N', 'OD-E2-N', False, 0.25, None),
}

_verified: dict[tuple[str, int, int], str] = {}


def v2_e2_checkpoint(data_dir: Path, environ: dict[str, str]) -> Path:
    configured = environ.get('FORMIAI_V2_E2_CHECKPOINT')
    return Path(configured) if configured else data_dir / 'v2-preview' / 'research' / 'v2-e2-epoch45.pt'


def _sha256(path: Path) -> str:
    stat = path.stat()
    key = (str(path.resolve()), stat.st_size, stat.st_mtime_ns)
    if key not in _verified:
        digest = hashlib.sha256()
        with path.open('rb') as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b''):
                digest.update(chunk)
        _verified[key] = digest.hexdigest()
    return _verified[key]


def availability(choice: ModelChoice, data_dir: Path, environ: dict[str, str]) -> tuple[bool, str]:
    """Whether the model can run, and why not. Never substitutes another model."""
    if choice.id != 'V2-E2':
        return True, ''
    path = v2_e2_checkpoint(data_dir, environ)
    if not path.is_file():
        return False, 'V2-E2 checkpoint not found'
    if _sha256(path) != choice.sha256:
        return False, 'V2-E2 checkpoint SHA256 does not match the frozen value'
    return True, ''


def build_command(choice: ModelChoice, source: Path, output: Path, progress_dir: Path, device: str,
                  data_dir: Path, environ: dict[str, str]) -> list[str]:
    if choice.id == 'OD-E2-N':
        return ['uv', 'run', 'formicai', 'analyze-video', str(source), '--output', str(output), '--detector-role',
                'own_colony', '--confidence', str(choice.confidence), '--device', device, '--progress-dir', str(progress_dir)]
    return ['uv', 'run', 'python', str(V2_E2_RUNNER), '--video', str(source), '--output', str(output),
            '--progress-dir', str(progress_dir), '--checkpoint', str(v2_e2_checkpoint(data_dir, environ)),
            '--sha256', str(choice.sha256), '--confidence', str(choice.confidence), '--device', device]


def record(choice: ModelChoice) -> dict:
    """What FormiAI declares about the run; the detector actually loaded is in Ants-2's analysis.json."""
    return {'id': choice.id, 'label': choice.label, 'experimental': choice.experimental,
            'confidence': choice.confidence, 'expected_sha256': choice.sha256,
            'integration': 'FormiAI experimental runner (not an Ants-2 API)' if choice.experimental else 'Ants-2 registered role own_colony'}
