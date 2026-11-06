# Agentic Data Pipeline

A "Virtual Data Analyst" web app. Upload a CSV, ask a business question in
plain English, and the system translates it to SQL, runs it against an
isolated local database, flags statistical outliers, and writes a short
plain-English report — no manual querying required.

## Architecture

```
Browser (Tailwind dashboard)
        |
        v
Flask (app.py) ── routing only
        |
        ├── engine/data_engine.py
        |     Pandas cleaning → SQLite ingestion
        |     IsolationForest anomaly scan (forest-based, sklearn)
        |     Guardrailed read-only SQL execution
        |
        └── engine/agent.py
              LangChain-orchestrated LLM (via Groq)
              question → SQL, results → plain-English report
```

- **Frontend** — `templates/index.html` + `static/js/app.js`. Plain HTML/JS,
  Tailwind via CDN. No build step.
- **Backend** — Flask (`app.py`), two endpoints: `/api/upload` and `/api/query`.
- **Data & ML** — `engine/data_engine.py`. Pandas cleans and types the raw
  CSV, writes it into an isolated SQLite table, and scores results with
  scikit-learn's `IsolationForest` (an unsupervised, randomized-tree
  ensemble in the Random Forest family) to flag extreme outliers.
- **Agentic AI layer** — `engine/agent.py`. LangChain prompts an
  open-source LLM served for free by Groq, once to translate the question
  into SQL and once to synthesize the final report.

## Setup

1. **Create a virtual environment and install dependencies**
   ```bash
   python -m venv venv
   source venv/bin/activate   # Windows: venv\Scripts\activate
   pip install -r requirements.txt
   ```

2. **Get a free Groq API key** at https://console.groq.com/keys

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   # then edit .env and paste your GROQ_API_KEY
   ```

4. **Run the app**
   ```bash
   python app.py
   ```
   Open http://localhost:5000

5. **Try it** — upload `sample_data/regional_sales.csv` (it has a couple of
   planted outliers) and ask something like:
   - "which region had the highest revenue in Q3?"
   - "are there any unusual values in this data?"
   - "compare returns across regions"

## Security notes (read before deploying anywhere real)

- Generated SQL is restricted to `SELECT`/`WITH` statements only, and the
  connection used to run it is opened read-only
  (`sqlite3.connect("file:...?mode=ro", uri=True)`). Any `INSERT`, `UPDATE`,
  `DELETE`, `DROP`, `ALTER`, etc. in a generated query is rejected before
  it ever reaches the database — see `data_engine.run_readonly_query`.
- Uploaded filenames are sanitized with `werkzeug.utils.secure_filename`.
- This scaffold keeps dataset metadata in an in-memory dict for simplicity.
  For multi-user or production use, move `DATASETS` into a real per-session
  store (e.g. a small `datasets` table, or Flask-Session backed by Redis).
- `FLASK_SECRET_KEY` and `GROQ_API_KEY` must be set via `.env` — never
  commit real keys.

## Project layout

```
agentic-data-pipeline/
├── app.py                  # Flask routes
├── engine/
│   ├── data_engine.py       # Pandas + SQLite + IsolationForest
│   └── agent.py              # LangChain + Groq orchestration
├── templates/
│   └── index.html            # Dashboard UI
├── static/
│   ├── css/style.css
│   └── js/app.js
├── sample_data/
│   └── regional_sales.csv    # Demo dataset with planted outliers
├── requirements.txt
└── .env.example
```

## Extending it

- Swap `IsolationForest` for a supervised `RandomForestClassifier` if you
  later have labeled examples of "bad" rows to train against — the current
  choice is unsupervised because raw business data usually has no labels.
- Add a `/api/history` endpoint and a small SQLite table to persist past
  questions, SQL, and reports per dataset.
- Support more upload formats (Excel, JSON) by extending
  `data_engine.load_csv_to_sqlite` into a small format-dispatch function.
