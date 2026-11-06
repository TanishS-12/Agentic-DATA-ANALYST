"""
agent.py
--------
The agentic layer. LangChain orchestrates a Groq-hosted open-source LLM
through two jobs:

  1. nl_to_sql        - turn a plain-English question + schema into a single
                         read-only SQL SELECT statement.
  2. synthesize_report - turn the question, the query, the result rows, and
                         any flagged anomalies into a short plain-text
                         analytical report.

Both are plain prompt -> LLM -> postprocess calls (no tool-calling loop is
needed for this shape of task), kept in LangChain's runnable/prompt
abstractions so swapping the model or provider later is a one-line change.
"""

from __future__ import annotations

import os
import re

from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_groq import ChatGroq


def _get_llm(temperature: float = 0.0) -> ChatGroq:
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError(
            "GROQ_API_KEY is not set. Add it to your .env file "
            "(see .env.example) — get a free key at https://console.groq.com/keys"
        )
    model = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
    return ChatGroq(model=model, temperature=temperature, api_key=api_key)


SQL_SYSTEM_PROMPT = """You are a careful data analyst that writes SQLite queries.

Rules:
- Output ONLY a single SQL SELECT statement. No explanation, no markdown fences.
- Never write INSERT, UPDATE, DELETE, DROP, ALTER, or any statement that changes data.
- Only reference columns that exist in the schema below.
- Use the exact table and column names from the schema.
- If the question is ambiguous, make the most reasonable business interpretation.
- Limit results to at most 500 rows unless the question clearly asks for an aggregate.

Schema:
{schema}
"""

REPORT_SYSTEM_PROMPT = """You are a virtual data analyst writing a short report for a
business user who cannot read SQL. Plain English, no jargon, no markdown headers,
2-4 short paragraphs.

Cover, in order:
1. A direct answer to the user's question, backed by the numbers you were given.
2. Any notable pattern or trend visible in the result set.
3. If anomalies were flagged, name them plainly (which rows/values, and why they
   stand out) and note that they may be worth a human look — don't overstate certainty.
4. If nothing anomalous was found, say so briefly instead of forcing a finding.

Do not invent numbers that aren't in the data you were given.
"""


def nl_to_sql(question: str, schema_description: str) -> str:
    """Translate a natural-language business question into a SQL SELECT."""
    llm = _get_llm(temperature=0.0)
    prompt = ChatPromptTemplate.from_messages(
        [
            ("system", SQL_SYSTEM_PROMPT),
            ("human", "{question}"),
        ]
    )
    chain = prompt | llm | StrOutputParser()
    raw = chain.invoke({"schema": schema_description, "question": question})
    return _extract_sql(raw)


def _extract_sql(raw: str) -> str:
    """LLMs sometimes wrap SQL in markdown fences despite instructions;
    strip that defensively before it reaches the query guardrail."""
    fenced = re.search(r"```(?:sql)?\s*(.*?)```", raw, re.DOTALL | re.IGNORECASE)
    sql = fenced.group(1) if fenced else raw
    return sql.strip().strip(";").strip()


def synthesize_report(
    question: str,
    sql: str,
    result_preview: str,
    anomaly_summary: str,
) -> str:
    """Turn a question + its query results (+ any anomalies) into a
    plain-text analytical report."""
    llm = _get_llm(temperature=0.3)
    prompt = ChatPromptTemplate.from_messages(
        [
            ("system", REPORT_SYSTEM_PROMPT),
            (
                "human",
                "Question: {question}\n\n"
                "SQL used: {sql}\n\n"
                "Result data (preview):\n{result_preview}\n\n"
                "Anomaly scan results:\n{anomaly_summary}",
            ),
        ]
    )
    chain = prompt | llm | StrOutputParser()
    return chain.invoke(
        {
            "question": question,
            "sql": sql,
            "result_preview": result_preview,
            "anomaly_summary": anomaly_summary,
        }
    ).strip()
