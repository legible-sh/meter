# CONCEPT — why meter exists

## The need

Runaway agent spend is not a hypothetical; it is a genre. The $400 overnight run. The LangChain loop that made 14,000 redundant tool calls on its way to a $437 charge. The $6k-overnight forum thread where "almost everyone had a similar story." The pattern is always the same: an autonomous loop, a retry storm or a mis-scoped task, and a human who was asleep. By the time the provider's billing page updates, the money is gone.

What operators do today is telling: they hand-roll it. A Redis counter, an `INCR`, a check before each call, per-agent quotas glued together the week after the incident. The primitive is obvious and everyone builds the same one. That is exactly the situation where a shared, curl-shaped service belongs — the ntfy.sh argument, applied to budgets.

meter is that counter as infrastructure: an out-of-band, fleet-shared budget any agent preauthorizes against with one HTTP call. 200 means proceed. 429 means stop — and the 429 body carries a URL a human can open on a phone, see what the fleet is asking for, and tap to raise the cap. Ten seconds of setup before the overnight run; insurance priced accordingly.

## The competitors, and where they fall short

- **LiteLLM proxy** — does real budgets with real 429s, but it is a *route-through gateway*: you deploy it, point every SDK at it, and it must see all your traffic to count it. That's a routing decision, an infrastructure commitment, and a single point of failure — not something you add at 11pm before a run. It also only meters what flows through it: LLM calls, not "calls to that scraping API" or "GPU-minutes."
- **Unkey** — usage limits attached to API keys, nicely built, but it starts with a signup and root keys and an SDK. The provisioning ceremony is precisely what an agent (or a tired human) can't do mid-run.
- **AgentGuard** — a Python library that watches spend inside one process. If your fleet is three Claude Code sessions, a cron job, and a box in the closet, a single-process library answers the wrong question. Budgets are a *fleet* property.
- **RelayPlane** — a local per-machine proxy. Same shape problem twice: per-machine (fleets span machines) and proxy (route-through, again).
- **Provider-native caps** — OpenAI's monthly limit has been softened into a threshold-ish notification; Anthropic workspace caps are console-only and monthly. Both are the right idea at the wrong granularity: a monthly cap does not catch a loop that burns $400 between 2am and 6am. And neither spans providers — your budget is one number, your bill is five.

Nobody ships the third shape: **out-of-band** (no traffic routes through it — agents ask permission, which is one added HTTP call, not an architecture), **fleet-shared** (one counter, any process, any machine, any language), **unit-agnostic** (dollars, tokens, calls, GPU-minutes — the cap doesn't care), with a **human doorbell** on the deny (the 429 carries the raise URL; the status page is the console).

## The angle

meter refuses two adjacent product categories on purpose:

- It is **not metering/billing**. OpenMeter owns that word and that problem — accurate usage aggregation for invoicing. meter's counts are self-reported estimates whose job is to *stop a loop*, not to reconcile a ledger.
- It is **not cost optimization**. No model-routing, no cache-this-prompt advice. One verb: may I spend this? Yes/no.

The wedge is agent-legibility: the whole API fits in a prompt, the first curl works without an account, and the Claude Code hook makes it *enforcing* — a PreToolUse hook that preauthorizes before every expensive tool call and blocks on 429 with exit 2. That last part matters: it converts meter from "a counter your agents are asked to respect" into "a wall Claude Code physically cannot walk through," with zero code changes.

## Honest risks

- **Advisory by default.** The obvious objection: an honor-system firewall. An agent that never calls `/spend` is unmetered. This is why the hook story has to be flawless on day one — it is the existence proof that enforcement is one paste away — and why the docs say plainly: meter stops agents that check it; pair with bigred for the hard stop. If the hook story is mediocre, the whole product is a lecture about discipline.
- **The countapi failure mode.** Zero-signup counters died once already: countapi.xyz was loved, abused, and abandoned — anonymous counters attract junk traffic and nobody pays. Mitigations: hard per-instance limits (topics, body size, log length) from day one, TTL/idle eviction on the hosted instance, and a premium tier (teams, alerts, retention) that gives the hosted service an economic reason to exist. Self-hosting is the pressure valve — the free tier can be modest because `npx meter-sh serve` is the full product.
- **Self-reported amounts.** meter counts claims, not bills. A wrong estimate under-brakes. We say this out loud rather than pretending; the discipline of estimating-before-spending is itself most of the safety value, and the log makes bad estimates visible after the first incident, not the fifth.
- **Single-instance semantics.** Atomicity comes from one process owning the counter. That is a feature at fleet scale (tens of agents, not tens of thousands of RPS) and an honest ceiling — meter should never grow a consensus protocol. If you need multi-region budget enforcement, you need a different product.

## The premium path

Never the core verbs. The hosted instance charges for capacity and organization:

- **Teams & named sub-budgets** — `acme/research` vs `acme/prod`, rolled-up views, per-team tokens.
- **Threshold alerts** — webhook/ntfy at 80% of cap, before the 429 lands.
- **Analytics & export** — spend by note, by day, by topic; CSV.
- **Longer history, reserved names, SLA.**

Self-host remains the complete product with the identical API — that is what makes the hosted instance trustworthy, per the family principles.
