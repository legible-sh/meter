# Agent Handoff

## Project state

meter is complete and tested: a zero-dependency Node (>= 20, ESM) HTTP server + CLI implementing a fleet-shared budget counter. All documented endpoints exist; all README examples work as written against a local instance. 42 test cases (233 assertions) pass with `npm test`. Default port 4187 (part of the ten-sibling legible family; see README footer).

## Important files

- `src/limits.mjs` — every hard limit as an exported constant. Change limits here only.
- `src/budget.mjs` — pure domain logic: period windows (`periodKey`, `nextReset`, `rollover`), parsing/validation (`parseAmount`, `parseConfig`, `parseRaise`), `status` shape, `fits` (the cap check), `round6` (all amounts round to 6 decimals; cap comparison uses a 1e-9 epsilon). No I/O — test everything here with plain values.
- `src/store.mjs` — `Store`: in-memory `Map` of topics + optional JSONL persistence (`--data-dir` → `<dir>/meter.jsonl`, appendFileSync per event, replayed on boot) + pub/sub (`subscribe`/`emit`) powering SSE and long-poll. Three event kinds: `spend`, `config`, `raise`. Replay recomputes period windows from each event's `at`, so old spends don't count against the current window.
- `src/server.mjs` — routing only; all state changes go through the store, all validation through budget.mjs. `createServer(options)` returns a `node:http` server (options: `dataDir`, `token`, `baseUrl`, `store`); `server.store` is exposed for tests/embedding.
- `src/page.mjs` — the HTML status page (returned for `GET /{topic}` with `Accept: text/html`). Self-contained client of the JSON API + `/sse`.
- `src/cli.mjs` — CLI verbs (`spend|status|cap|raise|log|hook|serve|help`). Exit codes: 0 ok, 1 error, 2 over-cap (the hook contract). Base URL: `--url` > `METER_URL` > `https://meter.legible.sh`. Token: `--token` > `METER_TOKEN`.
- `bin/meter.mjs` — shebang shim.
- `test/*.test.mjs` — six files: pure domain, HTTP surface, auth on/off, persistence/replay, end-to-end flow + SSE + long-poll, CLI subprocess (including `serve`). `test/helpers.mjs` boots real servers on port 0.
- `examples/` — `walkthrough.sh` (full curl tour), `loop-guard.sh` (spend-or-exit for bash loops), `claude-hook.json` (paste-ready Claude Code PreToolUse hook).
- `site/index.html` — self-contained dark landing page; also served at `GET /` to browsers (curl gets plain-text usage).

## Behavior decisions worth knowing

- Topics auto-create on first use (spend, GET, PUT, raise) in track-only mode: `cap: null`, `period: 'day'`, `unit: 'units'`. A bare GET does not persist anything (nothing happened).
- `POST /{topic}/spend` is check-and-increment in one step; denied spends are logged (`allowed: false`) and emitted but never counted. Dry runs (`?dry=1`) touch nothing — no log, no events.
- Cap boundary is inclusive (spend up to exactly the cap) with a 1e-9 float epsilon.
- `--token` guards `PUT /{topic}` and `POST /{topic}/raise` only. Spend is deliberately never token-guarded (agents must always be able to ask). GET/log/SSE are readable without the token — judged non-sensitive because the topic name is already the capability; documented in README's self-hosting section.
- Changing `period` starts a fresh window but keeps `spent` (no amnesty for money already spent). Cap changes never reset the counter.
- `raise {to}` may lower a cap — it just sets it. `raise {by}` on a capless topic is a 400 (`no_cap`); `raise {to}` can set a first cap.
- Long-poll is `GET /{topic}?wait=seconds` (family idiom): resolves on the next spend/config/raise event with `changed: true`, or at timeout with `changed: false`. Capped at 60s.
- SSE sends an initial `status` event, then named `spend`/`config`/`raise` events, plus `: hb` comments every 25s.
- CORS is `*` on everything; OPTIONS preflight handled. WebSocket is omitted deliberately (zero-dep constraint) — SSE + long-poll + one-shot GET cover the watch cases.
- `serve` binds `0.0.0.0` by default (fleets span machines); README tells self-hosters when to add `--token`.

## Verification commands

```sh
npm test                                  # 42 tests, all green, no network needed
node bin/meter.mjs serve                  # boots on 4187
bash examples/walkthrough.sh              # against a running local server
node bin/meter.mjs hook demo --url http://127.0.0.1:4187 | python3 -m json.tool
```

Quick manual loop against a running server:

```sh
curl -X PUT 'http://127.0.0.1:4187/t?cap=10&unit=usd'
curl -X POST -d 6 http://127.0.0.1:4187/t/spend      # 200
curl -X POST -d 5 http://127.0.0.1:4187/t/spend      # 429 + raise URL
curl -X POST -d '{"by": 5}' http://127.0.0.1:4187/t/raise
open http://127.0.0.1:4187/t                          # live status page
```

## Known gaps

- No TTL/idle eviction of topics — `MAX_TOPICS` (10,000) is the only backstop. Fine self-hosted; the hosted instance will need eviction (see CONCEPT.md, countapi risk).
- No `DELETE /{topic}` — the API surface is exactly the six documented endpoints. Deleting means restarting without the data dir (or editing `meter.jsonl`).
- JSONL is append-only with no compaction; the file grows one line per committed event. Harmless at fleet scale; compaction would be a boot-time rewrite if ever needed.
- Persistence writes are `appendFileSync` — durable and simple, and a measured non-issue at intended load (spends are preauthorizations, not high-frequency telemetry).
- The hook snippet counts calls (spends `1` per tool call). Counting *dollars* from a hook would need per-call cost estimates, which Claude Code does not expose to hooks.
- `meter serve` has no daemon mode/systemd unit; run it under your own supervisor.
- Amounts are self-reported estimates; meter never verifies against provider billing (by design — see CONCEPT.md).

## Safety notes for future work

- Never make `/spend` token-guarded — a brake agents can't reach without keys is a brake that doesn't get checked.
- Keep the store single-process-atomic; do not add clustering/replication (see CONCEPT.md "single-instance semantics").
- If you touch period logic, preserve: lazy rollover on every read/write, replay-time rollover from event timestamps, and the UTC-boundary contract in the README.
- The 429 body shape (`spent`, `cap`, `asked`, `raise`) is load-bearing — the hook, loop-guard, CLI exit-2 path, and status page all consume it.
