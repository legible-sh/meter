// State: an in-memory Map of topics, plus optional JSONL persistence.
// With --data-dir, every committed event is appended to meter.jsonl and
// replayed on boot; without it, meter is purely in-memory.
//
// Three event kinds live in the log:
//   {"t":"spend","topic":"ops","amount":2.5,"note":null,"allowed":true,"at":"..."}
//   {"t":"config","topic":"ops","cap":50,"period":"day","unit":"usd","at":"..."}
//   {"t":"raise","topic":"ops","cap":75,"at":"..."}
// Replay recomputes period windows from each event's timestamp, so a spend
// from yesterday does not count against today after a restart.

import fs from 'node:fs';
import path from 'node:path';
import {
  apiError,
  fits,
  newTopic,
  periodKey,
  rollover,
  round6,
  status,
} from './budget.mjs';
import { MAX_LOG_ENTRIES, MAX_TOPICS } from './limits.mjs';

export class Store {
  constructor({ dataDir = null } = {}) {
    this.topics = new Map();
    this.subs = new Map(); // topic name -> Set<fn(event, data)>
    this.file = null;
    if (dataDir) {
      fs.mkdirSync(dataDir, { recursive: true });
      this.file = path.join(dataDir, 'meter.jsonl');
      this.replay();
    }
  }

  replay() {
    if (!fs.existsSync(this.file)) return;
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // a torn final line from a crash is not fatal
      }
      try {
        this.applyRecord(rec);
      } catch {
        // e.g. topic limit reached mid-replay; skip rather than refuse to boot
      }
    }
  }

  applyRecord(rec) {
    const at = Date.parse(rec.at) || Date.now();
    const topic = this.getOrCreate(rec.topic, at);
    if (rec.t === 'spend') {
      rollover(topic, at);
      if (rec.allowed) topic.spent = round6(topic.spent + rec.amount);
      this.pushLog(topic, { at: rec.at, amount: rec.amount, note: rec.note ?? null, allowed: !!rec.allowed });
    } else if (rec.t === 'config') {
      if ('cap' in rec) topic.cap = rec.cap;
      if ('period' in rec && rec.period !== topic.period) {
        topic.period = rec.period;
        topic.periodKey = periodKey(rec.period, at);
      }
      if ('unit' in rec) topic.unit = rec.unit;
    } else if (rec.t === 'raise') {
      topic.cap = rec.cap;
    }
  }

  persist(rec) {
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
  }

  pushLog(topic, entry) {
    topic.log.push(entry);
    if (topic.log.length > MAX_LOG_ENTRIES) {
      topic.log.splice(0, topic.log.length - MAX_LOG_ENTRIES);
    }
  }

  getOrCreate(name, at = Date.now()) {
    let topic = this.topics.get(name);
    if (!topic) {
      if (this.topics.size >= MAX_TOPICS) {
        throw apiError(503, 'topic_limit', `topic limit reached (${MAX_TOPICS})`);
      }
      topic = newTopic(name, at);
      this.topics.set(name, topic);
    }
    return topic;
  }

  // The core verb: atomic check-and-increment. Denied spends are recorded in
  // the log (allowed: false) but never counted. Dry runs touch nothing.
  spend(name, { amount, note = null, dry = false, at = Date.now() } = {}) {
    const topic = this.getOrCreate(name, at);
    const allowed = fits(topic, amount, at);
    if (!dry) {
      const rec = { t: 'spend', topic: name, amount, note, allowed, at: new Date(at).toISOString() };
      if (allowed) topic.spent = round6(topic.spent + amount);
      this.pushLog(topic, { at: rec.at, amount, note, allowed });
      this.persist(rec);
      this.emit(name, 'spend', {
        at: rec.at,
        amount,
        note,
        allowed,
        spent: topic.spent,
        cap: topic.cap,
        remaining: topic.cap == null ? null : round6(Math.max(0, topic.cap - topic.spent)),
      });
    }
    return { allowed, topic };
  }

  // PUT /{topic}: partial config update ({cap, period, unit}).
  configure(name, changes, at = Date.now()) {
    const topic = this.getOrCreate(name, at);
    const rec = { t: 'config', topic: name, at: new Date(at).toISOString() };
    if ('cap' in changes) {
      topic.cap = changes.cap;
      rec.cap = changes.cap;
    }
    if ('period' in changes) {
      if (changes.period !== topic.period) {
        topic.period = changes.period;
        topic.periodKey = periodKey(changes.period, at);
      }
      rec.period = changes.period;
    }
    if ('unit' in changes) {
      topic.unit = changes.unit;
      rec.unit = changes.unit;
    }
    this.persist(rec);
    this.emit(name, 'config', status(topic, at));
    return topic;
  }

  // POST /{topic}/raise: set a new (already validated) cap.
  raise(name, newCap, at = Date.now()) {
    const topic = this.getOrCreate(name, at);
    const previous = topic.cap;
    topic.cap = newCap;
    this.persist({ t: 'raise', topic: name, cap: newCap, at: new Date(at).toISOString() });
    this.emit(name, 'raise', { ...status(topic, at), previous });
    return { topic, previous };
  }

  get(name) {
    return this.topics.get(name) ?? null;
  }

  subscribe(name, fn) {
    let set = this.subs.get(name);
    if (!set) {
      set = new Set();
      this.subs.set(name, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.subs.delete(name);
    };
  }

  emit(name, event, data) {
    const set = this.subs.get(name);
    if (!set) return;
    for (const fn of [...set]) fn(event, data);
  }
}
