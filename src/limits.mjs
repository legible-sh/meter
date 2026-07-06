// Hard limits, in one place. Exported constants so they are greppable,
// testable, and honest — every one of these is documented in the README.

export const MAX_BODY_BYTES = 4096; // request bodies are numbers and small JSON
export const MAX_TOPICS = 10000; // per server instance; creation past this is a 503
export const MAX_LOG_ENTRIES = 500; // per-topic spend log (ring buffer, oldest dropped)
export const MAX_NOTE_LENGTH = 256; // spend notes are truncated to this many chars
export const MAX_AMOUNT = 1e12; // single-spend and cap upper bound
export const MAX_WAIT_SECONDS = 60; // ?wait= long-poll ceiling
export const SSE_HEARTBEAT_MS = 25000; // comment heartbeat keeps proxies from dropping us
export const MAX_UNIT_LENGTH = 16; // "usd", "tokens", "calls", "credits"...
export const TOPIC_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export const PERIODS = ['day', 'month', 'total'];
