#!/usr/bin/env bash
# curl examples — raw HTTP API for any language or framework.
# No SDK required. Works from Python, Go, Rust, shell scripts, CI/CD pipelines.

set -euo pipefail

BASE="${RUBRIC_BASE_URL:-https://2gakxc8u.functions.insforge.app}"
KEY="${RUBRIC_API_KEY:-rbk_...}"

echo "=== 1. Create an ingest key (dashboard only — not via API) ==="
echo "    Visit your Rubric dashboard → Ingest keys → Create key"
echo ""

# ---------------------------------------------------------------------------
echo "=== 2. Seed a demo pipeline (optional — pre-built credit underwriting) ==="
# Requires user JWT, not ingest key. Use the dashboard "Load demo pipeline" button instead.
echo "    Use the dashboard → Load demo pipeline button."
echo ""

# ---------------------------------------------------------------------------
echo "=== 3. Ingest raw traces (passive mode) ==="
curl -s -X POST "$BASE/ingest" \
  -H "x-rubric-key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "pipeline_name": "my-research-pipeline",
    "task": {
      "goal": "Analyze Q4 earnings and produce an investment memo",
      "original_prompt": "Review NVIDIA Q4 2025 earnings",
      "success_criteria": ["Accurate", "All claims sourced"]
    },
    "source": "custom",
    "spans": [
      {
        "span": "agent_researcher",
        "role": "researcher",
        "events": [
          {
            "type": "tool_call",
            "name": "fetch_earnings",
            "result": {"revenue": "$39.3B", "growth": "+78%"}
          },
          {
            "type": "assumption",
            "text": "Assumed Q4 growth is sustainable through H1 2026",
            "confidence": 0.6
          },
          {
            "type": "uncertainty",
            "text": "Cannot confirm data center revenue mix beyond Q4",
            "impact": "high",
            "blocking": true
          },
          {
            "type": "decision",
            "text": "Include data center segment analysis",
            "rationale": "87% of revenue — material to investment case"
          },
          {
            "type": "output",
            "summary": "NVIDIA Q4: $39.3B revenue (+78% YoY). Key risk: data center concentration."
          }
        ]
      }
    ]
  }' | jq .

echo ""
CO_ID=$(curl -s -X POST "$BASE/ingest" \
  -H "x-rubric-key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"pipeline_name":"test","task":{"goal":"test"},"source":"custom","spans":[{"span":"a","role":"test","events":[{"type":"output","summary":"test"}]}]}' | jq -r '.context_object_id')
echo "Context object ID: $CO_ID"

# ---------------------------------------------------------------------------
echo ""
echo "=== 4. Process (extract + score in one call) ==="
curl -s -X POST "$BASE/process" \
  -H "x-rubric-key: $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"context_object_id\": \"$CO_ID\"}" | jq .

# ---------------------------------------------------------------------------
echo ""
echo "=== 5. Get handoff view (compact payload + audit data) ==="
curl -s -X POST "$BASE/get-handoff" \
  -H "x-rubric-key: $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"context_object_id\": \"$CO_ID\"}" | jq '{pipeline_health, dropped_count: (.dropped_context | length), frame_count: (.frames | length)}'

# ---------------------------------------------------------------------------
echo ""
echo "=== 6. Ask the ledger a question ==="
curl -s -X POST "$BASE/ask" \
  -H "x-rubric-key: $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"context_object_id\": \"$CO_ID\", \"question\": \"Did anyone assume growth is sustainable?\", \"item_types\": [\"assumption\"]}" | jq .

echo ""
echo "=== Done ==="
echo "View in dashboard: your-rubric-url/co/$CO_ID"
