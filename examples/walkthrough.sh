#!/usr/bin/env bash
# The whole meter API in one runnable tour.
# Start a server first:  npx meter-sh serve   (or: node bin/meter.mjs serve)
set -euo pipefail

URL="${METER_URL:-http://127.0.0.1:4187}"
TOPIC="demo-$RANDOM"

echo "== 1. set the cap: 50 usd per day (this is the whole setup)"
curl -fsS -X PUT "$URL/$TOPIC?cap=50&period=day&unit=usd"

echo "== 2. an agent preauthorizes a spend — 200 means proceed"
curl -fsS -X POST -d '{"amount": 12.5, "note": "embedding batch"}' "$URL/$TOPIC/spend"

echo "== 3. check without committing (?dry=1)"
curl -sS -X POST -d 100 "$URL/$TOPIC/spend?dry=1"

echo "== 4. status any time"
curl -fsS "$URL/$TOPIC"

echo "== 5. blow the cap — 429, nothing committed, body carries the raise URL"
curl -sS -X POST -d 45 "$URL/$TOPIC/spend"

echo "== 6. the human taps raise (+25)"
curl -fsS -X POST -d '{"by": 25}' "$URL/$TOPIC/raise"

echo "== 7. the same spend now fits"
curl -fsS -X POST -d 45 "$URL/$TOPIC/spend"

echo "== 8. the log tells the story, newest first"
curl -fsS "$URL/$TOPIC/log?limit=5"

echo "== 9. two seconds of live events (SSE; the timeout is the point)"
curl -s -m 2 "$URL/$TOPIC/sse" || true

echo
echo "done — open $URL/$TOPIC in a browser for the live status page"
