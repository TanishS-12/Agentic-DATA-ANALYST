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

# In-memory registry of datasets loaded this process (table_name -> metadata).
# A real deployment would persist this per-user; kept simple here on purpose.
DATASETS: dict[str, dict] = {}


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
    table_name = (payload.get("table_name") or "").strip()

    if not question:
        return jsonify({"error": "Ask a question first."}), 400
    if table_name not in DATASETS:
        return jsonify({"error": "Unknown dataset. Upload a CSV first."}), 400

    schema_description = data_engine.describe_schema(DB_PATH, table_name)

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
