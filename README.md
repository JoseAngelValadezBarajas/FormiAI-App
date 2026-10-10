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

Configure Vite's dev proxy for `/api` to `http://localhost:8000` before browser integration. The API reads the real completed analysis at `artifacts/analysis/va_001_031026_1` only through its artifact contract.
