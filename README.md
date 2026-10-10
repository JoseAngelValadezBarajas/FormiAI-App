# FormiAI Product MVP

Product repo separate from `Ants-2`. It consumes versioned analysis artifacts through FastAPI; it never stores research videos, weights, datasets, or scientific logic.

## Local development

```powershell
$env:FORMIAI_RESEARCH_ROOT = 'C:\Dev\Ants-2'
cd backend
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

In a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Vite ya incluye un proxy de desarrollo para `/api` hacia `http://127.0.0.1:8000`. La API lee el análisis real completado en `artifacts/analysis/va_001_031026_1` únicamente a través de su contrato de artifacts.

FFmpeg con `libx264` debe estar disponible en `PATH`. FormiAI conserva `analyzed_video.mp4` como artifact científico y genera una sola vez `analyzed_video.web.mp4` como derivado H.264/yuv420p para reproducción web; su validación y provenance se guardan en `presentation_media.json`.

## API

- `GET /api/input-videos` lists only `.mp4` files directly under the configured research root.
- `POST /api/jobs` accepts a validated `source_name`, builds a fixed `formicai analyze-video` command, and persists job state in SQLite.
- `GET /api/jobs/{id}` returns the persisted status.
- `GET /api/sessions/{id}` and its artifact routes expose only registered artifact directories.
