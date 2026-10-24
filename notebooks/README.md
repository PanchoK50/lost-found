# Challenge data exploration

Start with `data-explorer.html`: open it in a browser, no installation needed. It contains a dataset overview, both floors of a real factory, hover tooltips, layer switches, equipment search, and expandable development questions.

For editable analysis, open `data-exploration.ipynb` in VS Code with the Jupyter extension and select a Python environment with `ipykernel` installed. The notebook includes executed outputs and needs no API keys. Run all cells from the repository root or this directory.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r notebooks/requirements.txt
```

Alternatively install JupyterLab into that environment (`.venv/bin/python -m pip install jupyterlab`) and run `.venv/bin/jupyter lab notebooks/data-exploration.ipynb`.

Regenerate the offline explorer with `python3 notebooks/explore.py`. The rendering helpers use only Python's standard library. `scripts/create-notebook.py` regenerates notebook sources and clears saved outputs; edit the notebook directly for normal team analysis.

## Development only

These resources live outside `src/` and `public/` and are not imported by the Next.js app. The product has no route or navigation link to the explorer. Python dependencies are separate from npm dependencies. `.vercelignore` excludes the notebook, sample data, explorer, and notebook-generation script from Vercel deployment uploads. To view the explorer, open the HTML file locally or serve this folder separately; it is not served by the product.

## Included data

A manifest for all 280 buildings and one **development** building: `proc-factory-dev-003` / Fertigung Ost 27. Its detailed records contain 2 floors, 79 spaces, 85 openings, 2 vertical connectors and 505 assets. The rest of the detailed dataset remains in the upstream repository; no test answers are included.

Source: https://github.com/Synera-GmbH/industrial-agents-hackathon-2026
Snapshot: `cb51a6f2e357db743b0c8b2b377fe902ee3ced13`, fetched 2026-10-24.

The bundled procedural building is CC0-1.0, attributed upstream as “Procedurally generated for the Munich hackathon (CC0)”. The full manifest retains source and license metadata for buildings from other sources; their detailed plans are not included. See `data/ATTRIBUTION.md` for the upstream attribution notice. Plan image files are not bundled; we render the JSON geometry directly.

Change `BUILDING_DIR` in the notebook to inspect another building directory containing `building.json`, `equipment.csv`, `questions.jsonl`, and `questions_basic.jsonl`. Some sources may omit fields or warm-up questions; adapt those cells accordingly. The HTML exporter is currently tied to the bundled sample and manifest.

The notebook validates IDs and references and calculates polygon areas, but does not implement routing or the official geometry benchmark.
