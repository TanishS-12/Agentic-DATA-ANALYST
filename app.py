"""
app.py
------
Flask server for the Agentic Data Pipeline. Thin routing layer only — all
data logic lives in engine/data_engine.py and all AI orchestration lives in
engine/agent.py.

Routes:
  GET  /                  -> dashboard UI
  POST /api/upload        -> ingest a CSV into SQLite, return schema + preview
  POST /api/query         -> run a natural-language question end to end
                             Accepts either:
                               { "question": "...", "table_name": "t" }         (single)
                               { "question": "...", "table_names": ["t1","t2"] } (multi-table / joins)
  GET  /api/datasets      -> list datasets loaded in this session
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, session
from werkzeug.utils import secure_filename

from engine import data_engine
from engine import agent

load_dotenv()

BASE_DIR = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "data" / "uploads"
DB_PATH = os.environ.get("DATABASE_PATH", str(BASE_DIR / "data" / "pipeline.db"))

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-key-change-me")

# In-memory registry of datasets (table_name -> metadata).
# Populated from uploads AND from any tables already in SQLite on startup,
# so a server restart never loses previously-loaded datasets.
DATASETS: dict[str, dict] = {}


def _restore_datasets_from_db() -> None:
    """On startup, re-populate DATASETS from every user table already in
    the SQLite database so a Flask reload / server restart is transparent."""
    if not Path(DB_PATH).exists():
        return
    try:
        import sqlite3
        with sqlite3.connect(DB_PATH) as conn:
            cur = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            )
            table_names = [row[0] for row in cur.fetchall()]

        for tname in table_names:
            if tname in DATASETS:
                continue
            try:
                info = data_engine.describe_schema_as_info(DB_PATH, tname)
                DATASETS[tname] = info
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass  # DB not ready yet — uploads will populate it lazily


_restore_datasets_from_db()


@app.route("/")
def index():
    return render_template("index.html", datasets=list(DATASETS.values()))


@app.route("/api/datasets", methods=["GET"])
def list_datasets():
    return jsonify({"datasets": list(DATASETS.values())})


@app.route("/api/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "No file was attached to the request."}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "No file selected."}), 400
    if not file.filename.lower().endswith(".csv"):
        return jsonify({"error": "Only CSV files are supported right now."}), 400

    filename = secure_filename(file.filename)
    unique_name = f"{uuid.uuid4().hex[:8]}_{filename}"
    save_path = UPLOAD_DIR / unique_name
    file.save(save_path)

    try:
        info = data_engine.load_csv_to_sqlite(str(save_path), DB_PATH, filename)
    except Exception as exc:  # noqa: BLE001 - surface a clean error to the UI
        return jsonify({"error": f"Could not process that CSV: {exc}"}), 422

    DATASETS[info.table_name] = {
        "table_name": info.table_name,
        "source_filename": filename,
        "row_count": info.row_count,
        "columns": info.columns,
        "numeric_columns": info.numeric_columns,
        "preview": info.preview,
    }

    return jsonify({"dataset": DATASETS[info.table_name]})


@app.route("/api/query", methods=["POST"])
def query():
    payload = request.get_json(silent=True) or {}
    question = (payload.get("question") or "").strip()

    # Accept either a single table_name (backward-compat) or a list of table_names.
    raw_names = payload.get("table_names") or payload.get("table_name") or ""
    if isinstance(raw_names, str):
        table_names = [raw_names.strip()] if raw_names.strip() else []
    else:
        table_names = [t.strip() for t in raw_names if t.strip()]

    if not question:
        return jsonify({"error": "Ask a question first."}), 400
    if not table_names:
        return jsonify({"error": "Select at least one dataset first."}), 400

    # Lazily re-hydrate any table the in-memory dict lost (e.g. after a
    # Flask debug-mode reload) as long as the data is still in SQLite.
    for tname in table_names:
        if tname not in DATASETS:
            try:
                DATASETS[tname] = data_engine.describe_schema_as_info(DB_PATH, tname)
            except Exception:  # noqa: BLE001
                pass  # genuinely unknown — caught below

    unknown = [t for t in table_names if t not in DATASETS]
    if unknown:
        return jsonify({
            "error": f"Unknown dataset(s): {', '.join(unknown)}. Upload them first."
        }), 400

    # Build a schema description covering all selected tables.
    if len(table_names) == 1:
        schema_description = data_engine.describe_schema(DB_PATH, table_names[0])
    else:
        schema_description = data_engine.describe_multi_schema(DB_PATH, table_names)

    # 1. Natural language -> SQL
    try:
        sql = agent.nl_to_sql(question, schema_description)
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 500
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"The model failed to translate that question: {exc}"}), 502

    # 2. Execute (read-only, guardrailed)
    try:
        result_df = data_engine.run_readonly_query(DB_PATH, sql)
    except data_engine.UnsafeQueryError as exc:
        return jsonify({"error": str(exc), "sql": sql}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"That query failed against the database: {exc}", "sql": sql}), 400

    # 3. Anomaly scan
    scored_df = data_engine.detect_anomalies(result_df)
    anomalies = scored_df[scored_df["is_anomaly"]].drop(columns=["is_anomaly", "anomaly_score"])
    anomaly_count = len(anomalies)
    anomaly_summary = (
        f"{anomaly_count} of {len(result_df)} rows flagged as statistical outliers.\n"
        + anomalies.head(10).to_string(index=False)
        if anomaly_count
        else "No statistically significant outliers were found in this result set."
    )

    # 4. Report synthesis
    try:
        report = agent.synthesize_report(
            question=question,
            sql=sql,
            result_preview=result_df.head(20).to_string(index=False),
            anomaly_summary=anomaly_summary,
        )
    except Exception as exc:  # noqa: BLE001
        report = f"(Report generation failed: {exc})"

    # Attach the anomaly flag directly onto each returned row so the
    # frontend never has to re-derive or fuzzy-match which rows were flagged.
    rows_with_flag = scored_df.drop(columns=["anomaly_score"]).to_dict(orient="records")

    return jsonify(
        {
            "sql": sql,
            "columns": list(result_df.columns),
            "rows": rows_with_flag,
            "anomaly_count": anomaly_count,
            "report": report,
        }
    )


if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG", "true").lower() == "true"
    app.run(debug=debug, port=5000)
