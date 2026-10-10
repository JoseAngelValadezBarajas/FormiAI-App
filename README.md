# FormiAI Product MVP

Web product separate from the FormiAI research core. It reads analysis artifacts through an adapter; it does not include research data, weights, or videos.

## Run locally

Set `FORMIAI_RESEARCH_ROOT=C:\Dev\Ants-2`, then run `python server.py`. Open http://localhost:4173.

The adapter reads a completed `analysis.json` directory and serves its derived artifacts. New runs are invoked explicitly through the research CLI and remain outside this repository.
