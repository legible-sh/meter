#!/usr/bin/env bash
# loop-guard.sh — spend-or-exit. Run at the top of every loop iteration of any
# agent, in any language, on any machine. Exit 0: proceed. Exit 2: over budget.
#
#   usage: ./loop-guard.sh [amount] [topic]
#   env:   METER_URL (default http://127.0.0.1:4187), METER_TOPIC (default my-agent)
#
#   while ./loop-guard.sh 0.10 overnight-fleet; do
#     do_one_expensive_thing
#   done
set -euo pipefail

AMOUNT="${1:-1}"
TOPIC="${2:-${METER_TOPIC:-my-agent}}"
URL="${METER_URL:-http://127.0.0.1:4187}"

code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST -d "$AMOUNT" "$URL/$TOPIC/spend") || code="000"

if [ "$code" = "200" ]; then
  exit 0
fi
if [ "$code" = "429" ]; then
  echo "meter: $TOPIC is over budget — raise the cap: $URL/$TOPIC" >&2
  exit 2
fi
# Fail open on anything else (meter unreachable, 5xx): the brake should not
# become a second outage. Flip the exit to 2 here if you want fail-closed.
echo "meter: unexpected status $code from $URL — letting the run continue" >&2
exit 0
