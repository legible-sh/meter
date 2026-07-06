// Pure budget logic: period windows, amount/config parsing, status shapes.
// No I/O here — everything is testable with plain values.

import {
  MAX_AMOUNT,
  MAX_NOTE_LENGTH,
  MAX_UNIT_LENGTH,
  PERIODS,
} from './limits.mjs';

export function apiError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// Amounts are rounded to 6 decimal places on every commit so floating-point
// dust never wedges a budget at 49.999999994.
export function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

// The key that names the current window. When the key changes, the counter resets.
export function periodKey(period, at = Date.now()) {
  if (period === 'total') return 'total';
  const iso = new Date(at).toISOString();
  return period === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
}

// ISO timestamp of the next UTC boundary, or null for 'total'.
export function nextReset(period, at = Date.now()) {
  const d = new Date(at);
  if (period === 'day') {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
  }
  if (period === 'month') {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
  }
  return null;
}

// Topics auto-create in track-only mode: no cap, daily window, generic unit.
export function newTopic(name, at = Date.now()) {
  return {
    name,
    cap: null,
    period: 'day',
    unit: 'units',
    spent: 0,
    periodKey: periodKey('day', at),
    log: [],
    createdAt: new Date(at).toISOString(),
  };
}

// Lazy window rollover: called before every read/write of the counter.
export function rollover(topic, at = Date.now()) {
  const key = periodKey(topic.period, at);
  if (topic.periodKey !== key) {
    topic.periodKey = key;
    topic.spent = 0;
  }
}

export function status(topic, at = Date.now()) {
  rollover(topic, at);
  return {
    topic: topic.name,
    spent: topic.spent,
    cap: topic.cap,
    remaining: topic.cap == null ? null : round6(Math.max(0, topic.cap - topic.spent)),
    unit: topic.unit,
    period: topic.period,
    resets: nextReset(topic.period, at),
  };
}

// Would this spend fit? (Does not commit.)
export function fits(topic, amount, at = Date.now()) {
  rollover(topic, at);
  return topic.cap == null || topic.spent + amount <= topic.cap + 1e-9;
}

// Body of POST /{topic}/spend: a bare number ("2.50") or JSON
// (2.5, or {"amount": 2.5, "note": "embedding batch"}).
export function parseAmount(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw apiError(400, 'bad_amount', 'body must be a number or JSON {"amount": n, "note"?: "..."}');
  let amount;
  let note = null;
  if (/^[-+0-9.eE]+$/.test(s) && !Number.isNaN(Number(s))) {
    amount = Number(s);
  } else {
    let parsed;
    try {
      parsed = JSON.parse(s);
    } catch {
      throw apiError(400, 'bad_amount', 'body must be a number or JSON {"amount": n, "note"?: "..."}');
    }
    if (typeof parsed === 'number') {
      amount = parsed;
    } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      amount = parsed.amount;
      note = parsed.note ?? null;
    } else {
      throw apiError(400, 'bad_amount', 'body must be a number or JSON {"amount": n, "note"?: "..."}');
    }
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw apiError(400, 'bad_amount', 'amount must be a finite number');
  }
  if (amount <= 0) throw apiError(400, 'bad_amount', 'amount must be greater than 0');
  if (amount > MAX_AMOUNT) throw apiError(400, 'bad_amount', `amount must be at most ${MAX_AMOUNT}`);
  if (note != null) {
    if (typeof note !== 'string') throw apiError(400, 'bad_note', 'note must be a string');
    note = note.slice(0, MAX_NOTE_LENGTH);
  }
  return { amount: round6(amount), note };
}

// Body (or query params) of PUT /{topic}. Partial: absent fields keep their
// current values. cap: null (JSON) or cap=none (query) clears the cap.
export function parseConfig(input) {
  const out = {};
  let any = false;
  if ('cap' in input) {
    any = true;
    if (input.cap === null || input.cap === 'none') {
      out.cap = null;
    } else {
      const cap = typeof input.cap === 'number' ? input.cap : Number(input.cap);
      if (typeof input.cap === 'boolean' || String(input.cap).trim() === '' || !Number.isFinite(cap) || cap < 0 || cap > MAX_AMOUNT) {
        throw apiError(400, 'bad_cap', `cap must be a number between 0 and ${MAX_AMOUNT} (or null to clear)`);
      }
      out.cap = round6(cap);
    }
  }
  if ('period' in input) {
    any = true;
    if (!PERIODS.includes(input.period)) {
      throw apiError(400, 'bad_period', `period must be one of: ${PERIODS.join(', ')}`);
    }
    out.period = input.period;
  }
  if ('unit' in input) {
    any = true;
    const unit = String(input.unit).trim();
    if (!unit || unit.length > MAX_UNIT_LENGTH || /[\s\p{Cc}]/u.test(unit)) {
      throw apiError(400, 'bad_unit', `unit must be 1-${MAX_UNIT_LENGTH} characters, no whitespace`);
    }
    out.unit = unit;
  }
  if (!any) throw apiError(400, 'bad_config', 'nothing to set — provide cap, period, and/or unit');
  return out;
}

// Body (or query params) of POST /{topic}/raise. Returns the new cap.
export function parseRaise(input, currentCap) {
  const has = (k) => input[k] !== undefined && input[k] !== null && String(input[k]).trim() !== '';
  if (has('by') && has('to')) throw apiError(400, 'bad_raise', 'provide "by" or "to", not both');
  if (has('by')) {
    const by = Number(input.by);
    if (!Number.isFinite(by) || by <= 0 || by > MAX_AMOUNT) {
      throw apiError(400, 'bad_raise', '"by" must be a positive number');
    }
    if (currentCap == null) {
      throw apiError(400, 'no_cap', 'no cap set — raise with {"to": n} or PUT a cap first');
    }
    return round6(Math.min(currentCap + by, MAX_AMOUNT));
  }
  if (has('to')) {
    const to = Number(input.to);
    if (!Number.isFinite(to) || to < 0 || to > MAX_AMOUNT) {
      throw apiError(400, 'bad_raise', `"to" must be a number between 0 and ${MAX_AMOUNT}`);
    }
    return round6(to);
  }
  throw apiError(400, 'bad_raise', 'provide {"by": n} or {"to": n}');
}
