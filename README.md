<h1 align="center">⛔ meter</h1>

<p align="center"><strong>The kill-brake for agent spend. 429-as-a-service.</strong><br>
An out-of-band budget counter your whole fleet preauthorizes against with one curl:<br>
200 means proceed, 429 means stop.</p>

<p align="center">
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A5%2020-9dff00?style=flat-square">
  <img alt="Zero deps" src="https://img.shields.io/badge/runtime%20deps-0-ff2d95?style=flat-square">
  <img alt="MIT" src="https://img.shields.io/badge/license-MIT-e8f0ff?style=flat-square">
</p>

```sh
# before the overnight run — 10 seconds of insurance:
curl -X PUT 'https://meter.legible.sh/acme-fleet-x7k2?cap=50&period=day&unit=usd'

# in every agent, before anything expensive:
curl -X POST -d 2.50 https://meter.legible.sh/acme-fleet-x7k2/spend
# 200 → proceed · 429 → stop (the body carries a raise URL for your phone)
```

> meter.legible.sh isn't live yet. Everything in this README works today against your own instance: `npx meter-sh serve`, then swap `https://meter.legible.sh` for `http://localhost:4187`.

## Make Claude Code obey it

This is the move. One paste into `.claude/settings.json` and meter stops being advisory — every expensive tool call preauthorizes first, and a 429 **blocks the call** (hook exit 2) and tells Claude why. Zero code changes.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Task|WebFetch|WebSearch",
        "hooks": [
          {
            "type": "command",
            "command": "code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST -d 1 \"${METER_URL:-https://meter.legible.sh}/claude/spend\"); if [ \"$code\" = \"429\" ]; then echo \"meter: claude is over budget — raise the cap: ${METER_URL:-https://meter.legible.sh}/claude\" >&2; exit 2; fi"
          }
        ]
      }
    ]
  }
}
```

Set the cap (`curl -X PUT 'https://meter.legible.sh/claude?cap=500&period=day&unit=calls'`), export `METER_URL` if you self-host, done. `meter hook <topic>` prints this snippet with your topic and URL baked in; [examples/claude-hook.json](examples/claude-hook.json) is the paste-ready file, and [examples/loop-guard.sh](examples/loop-guard.sh) is the same idea for any bash loop.

## Why

Runaway agent spend is a genre now: the $400 overnight run, the LangChain loop that made 14,000 redundant tool calls, the $6k thread where everyone had a similar story. The existing answers all assume something you don't have at 2am: a proxy in front of every call, a signup, or a provider console with a monthly cap that notices your loop three weeks late. meter is the third shape — out-of-band (no traffic routes through it), fleet-shared (every agent on every machine hits the same counter), unit-agnostic (dollars, tokens, calls — your call), with a human doorbell on the 429: the error body carries a URL, you open it on your phone, you see what the fleet is asking for, you tap to raise the cap. Or you don't.

## The whole API

| Verb | Path | Does |
|---|---|---|
| `POST` | `/{topic}/spend` | Atomic check-and-increment. Body: a number, or `{"amount": n, "note": "..."}`. **200** `{spent, cap, remaining, period}` if it fits; **429** `{spent, cap, asked, raise}` if not — nothing committed. `?dry=1` checks without committing. |
| `PUT` | `/{topic}` | Set config: `{"cap": 50, "period": "day\|month\|total", "unit": "usd"}` (query params work too; `cap=none` clears). Guarded by `--token` if set. |
| `GET` | `/{topic}` | Status: `{spent, cap, remaining, unit, period, resets}`. Browsers get a live page with a remaining bar and raise buttons. `?wait=30` long-polls for the next change. |
| `POST` | `/{topic}/raise` | `{"by": 10}` or `{"to": 100}` — lift (or set) the cap. Guarded by `--token` if set. |
| `GET` | `/{topic}/log` | Recent spend entries `{at, amount, note, allowed}`, newest first (`?limit=50`). |
| `GET` | `/{topic}/sse` | Live spend events (SSE, named events, heartbeats every 25s). The status page runs on this. |
| `GET` | `/README.md` · `/llms.txt` | This document as `text/markdown`, and a tiny [llms.txt](https://llmstxt.org) index. `GET /` with `Accept: text/markdown` returns the README too. Never token-gated. |

Topics match `[a-zA-Z0-9_-]{1,64}` and are created by first use — an unguessable name is the access model, so pick a good one. First spend on a fresh topic runs in track-only mode (no cap; the response says so). Period counters reset on UTC boundaries. Denied spends are logged but never counted. Errors are JSON `{"error": "...", "code": "...", "hint": "..."}` with honest status codes — the `hint` is the correct next request, so you never have to leave the response to fix a call. 429s also carry a `Retry-After` header when the window resets on its own.

## Teach your agent

Paste this into your CLAUDE.md / AGENTS.md (swap in your topic and URL):

```
## Budget: meter
Before anything expensive (API call, batch job, paid tool), preauthorize:
  curl -X POST -d '{"amount": 0.25, "note": "what this is for"}' https://meter.legible.sh/TOPIC/spend
- 200 → proceed. Body has {spent, cap, remaining}.
- 429 → STOP. Do not retry, batch, or route around it. Report the "raise"
  URL from the body to the human — that page is where they lift the cap.
- Spend in the budget's units (dollars, tokens, calls — check GET /TOPIC).
- Estimate high when unsure. A denied preauthorization costs nothing.
- Check without committing: POST .../spend?dry=1
- Current state: curl https://meter.legible.sh/TOPIC · recent history: /TOPIC/log
```

## Self-hosting

```sh
npx meter-sh serve                      # http://0.0.0.0:4187, in-memory
npx meter-sh serve --data-dir ./data    # survives restarts (JSONL, replayed on boot)
npx meter-sh serve --token s3cret       # require Authorization: Bearer for cap/raise
npx meter-sh serve --port 4187 --host 127.0.0.1 --base-url https://meter.example.com
```

Or clone and run: `git clone`, `npm test`, `npm start`. Zero dependencies; the server is one `node:http` process. `--base-url` sets the absolute URL used in 429 raise links. `--token` guards `PUT /{topic}` and `POST /{topic}/raise` only — **spend never needs the token** (brakes must not need keys), and status/log/sse stay readable because the topic name itself is the secret. If your spend notes are sensitive, treat the token as mandatory and the topic name as radioactive.

## CLI

The CLI is sugar over the same HTTP API (base URL: `--url` flag, then `$METER_URL`, then `https://meter.legible.sh`).

```sh
meter cap ops 50 --period day --unit usd   # PUT /ops
meter spend ops 2.50 --note "batch"        # exit 0 = proceed, exit 2 = over cap
meter spend ops 100 --dry                  # check without committing
meter status ops                           # spent / cap / remaining / resets
meter raise ops --by 10                    # or --to 100
meter log ops --limit 20                   # recent spend, newest first
meter hook ops                             # print the Claude Code hook, ready to paste
meter serve                                # run the server (flags above)
```

## Pro

Planned for the hosted instance, never gating the core verbs — self-host stays complete:

- **Teams & named sub-budgets** — `acme/research`, `acme/prod`, one bill, per-team caps.
- **Threshold alerts** — webhook or [ntfy](https://ntfy.sh) ping at 80% before the 429 lands.
- **Spend analytics & export** — where the money went, by note, by day, CSV out.
- **Longer history** and reserved topic names, hosted SLA.

## Straight talk

- **meter only stops agents that check it.** A rogue process that never calls `/spend` burns money invisibly. The Claude Code hook closes that gap for tool calls with zero code changes; for a hard stop of the whole fleet, pair with **bigred** (port 4181, sibling project). meter is the brake, not the cage.
- **Amounts are self-reported estimates.** meter counts what agents claim, not what providers bill. Garbage in, garbage counted. The discipline of *estimating before spending* is most of the value.
- **Topic names are capability-by-obscurity.** Anyone who knows the name can spend against it (and cap/raise it, unless you set `--token`). Unguessable names are good insurance, not cryptography.
- **One process, arrival order.** The store is a single Node process, so check-and-increment is genuinely atomic — no distributed-counter races. Two agents that each preauthorize 30 against a 50 cap get one 200 and one 429, in arrival order. That's the point.
- **UTC boundaries, not yours.** `period: "day"` resets at midnight UTC. Plan the overnight run accordingly.
- **In-memory by default.** No `--data-dir`, no memory of spend after a restart. For a budget you actually rely on, persist.
- **Limits** (all in [src/limits.mjs](src/limits.mjs)): bodies ≤ 4 KB, notes ≤ 256 chars, 500 log entries per topic, 10,000 topics per instance, `?wait` ≤ 60s, amounts ≤ 1e12.

## The family

meter is one of the legible primitives — same stack, same idioms, one curl each:

| | port | |
|---|---|---|
| **gate** | 4180 | ntfy tells you things. gate asks you things. |
| **bigred** | 4181 | The big red button for your agent fleet. |
| **trail** | 4182 | The flight recorder for agent runs. |
| **slate** | 4183 | The blackboard from the multi-agent papers, as a URL. |
| **relay** | 4184 | The work queue your agents can provision themselves. |
| **mutex** | 4185 | flock(1) for agents that live on different machines. |
| **quorum** | 4186 | Coordination for agents that do not share a parent process. |
| **meter** | 4187 | The kill-brake for agent spend. 429-as-a-service. |
| **stash** | 4188 | ntfy moves signals. stash moves bytes. |
| **tally** | 4189 | StatHat reborn as ntfy. Three months too late — or right on time. |

## License

MIT.
