// The HTTP server: a thin routing layer over the store. The URL is the API:
//
//   POST /{topic}/spend   atomic check-and-increment (?dry=1 checks only)
//   PUT  /{topic}         set config {cap, period, unit}          [token]
//   GET  /{topic}         status — JSON for curl, live page for browsers,
//                         ?wait=30 long-polls for the next change
//   POST /{topic}/raise   {by} or {to}                            [token]
//   GET  /{topic}/log     recent spend entries, newest first
//   GET  /{topic}/sse     live spend events (SSE, 25s heartbeats)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import {
  apiError,
  parseAmount,
  parseConfig,
  parseRaise,
  status as topicStatus,
} from './budget.mjs';
import { statusPage } from './page.mjs';
import {
  MAX_BODY_BYTES,
  MAX_LOG_ENTRIES,
  MAX_WAIT_SECONDS,
  SSE_HEARTBEAT_MS,
  TOPIC_PATTERN,
} from './limits.mjs';

const SITE_INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site', 'index.html');

const USAGE = `meter — the kill-brake for agent spend. 429-as-a-service.

  POST /{topic}/spend    body: a number, or {"amount": n, "note": "..."}
                         200 = proceed · 429 = stop (body carries a raise URL)
                         ?dry=1 checks without committing
  PUT  /{topic}          set config: {"cap": 50, "period": "day|month|total", "unit": "usd"}
  GET  /{topic}          status (JSON for curl, live page for browsers) · ?wait=30 long-polls
  POST /{topic}/raise    {"by": 10} or {"to": 100}
  GET  /{topic}/log      recent spend entries, newest first (?limit=50)
  GET  /{topic}/sse      live spend events (SSE)

Topics are created by first use and match [a-zA-Z0-9_-]{1,64} — pick an unguessable name.
`;

export function createServer(options = {}) {
  const ctx = {
    store: options.store ?? new Store({ dataDir: options.dataDir ?? null }),
    token: options.token ?? null,
    baseUrl: options.baseUrl ? String(options.baseUrl).replace(/\/+$/, '') : null,
  };
  const server = http.createServer((req, res) => {
    route(req, res, ctx).catch((err) => sendError(res, err));
  });
  server.store = ctx.store; // handy for tests and embedding
  return server;
}

async function route(req, res, ctx) {
  res.setHeader('access-control-allow-origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '86400',
    });
    return void res.end();
  }

  const url = new URL(req.url, 'http://internal');
  if (url.pathname === '/') return root(req, res);
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    return void res.end();
  }

  const match = url.pathname.match(/^\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) throw apiError(404, 'not_found', 'no such route');
  const [, name, sub] = match;
  if (!TOPIC_PATTERN.test(name)) {
    throw apiError(400, 'bad_topic', 'topic must match [a-zA-Z0-9_-]{1,64}');
  }

  const base = ctx.baseUrl || `http://${req.headers.host || '127.0.0.1'}`;

  if (sub === undefined) {
    if (req.method === 'PUT') return putConfig(req, res, ctx, name, url);
    if (req.method === 'GET') return getTopic(req, res, ctx, name, url);
    throw apiError(405, 'method_not_allowed', 'use GET (status) or PUT (config) on /{topic}');
  }
  if (sub === 'spend') {
    if (req.method !== 'POST') throw apiError(405, 'method_not_allowed', 'use POST on /{topic}/spend');
    return postSpend(req, res, ctx, name, url, base);
  }
  if (sub === 'raise') {
    if (req.method !== 'POST') throw apiError(405, 'method_not_allowed', 'use POST on /{topic}/raise');
    return postRaise(req, res, ctx, name, url);
  }
  if (sub === 'log') {
    if (req.method !== 'GET') throw apiError(405, 'method_not_allowed', 'use GET on /{topic}/log');
    return getLog(req, res, ctx, name, url);
  }
  if (sub === 'sse') {
    if (req.method !== 'GET') throw apiError(405, 'method_not_allowed', 'use GET on /{topic}/sse');
    return getSse(req, res, ctx, name);
  }
  throw apiError(404, 'not_found', 'no such route — subresources are: spend, raise, log, sse');
}

// --- handlers ---------------------------------------------------------------

async function root(req, res) {
  if (wantsHtml(req)) {
    try {
      const html = await readFile(SITE_INDEX, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return void res.end(html);
    } catch {
      // fall through to text
    }
  }
  sendText(res, 200, USAGE);
}

async function postSpend(req, res, ctx, name, url, base) {
  const body = await readBody(req);
  const { amount, note } = parseAmount(body);
  const dry = isTrue(url.searchParams.get('dry'));
  const { allowed, topic } = ctx.store.spend(name, { amount, note, dry });
  const st = topicStatus(topic);
  if (allowed) {
    return sendJson(res, 200, {
      ...st,
      ...(topic.cap == null ? { message: 'no cap set — tracking only' } : {}),
      ...(dry ? { dry: true, committed: false } : {}),
    });
  }
  sendJson(res, 429, {
    error: 'cap exceeded',
    code: 'over_cap',
    ...st,
    asked: amount,
    raise: `${base}/${name}`,
    ...(dry ? { dry: true } : {}),
  });
}

async function putConfig(req, res, ctx, name, url) {
  requireToken(req, ctx);
  const body = await readBody(req);
  const input = {};
  for (const key of ['cap', 'period', 'unit']) {
    if (url.searchParams.has(key)) input[key] = url.searchParams.get(key);
  }
  if (body.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw apiError(400, 'bad_config', 'body must be JSON, e.g. {"cap": 50, "period": "day", "unit": "usd"}');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw apiError(400, 'bad_config', 'body must be a JSON object');
    }
    Object.assign(input, pick(parsed, ['cap', 'period', 'unit']));
  }
  const changes = parseConfig(input);
  const topic = ctx.store.configure(name, changes);
  sendJson(res, 200, topicStatus(topic));
}

async function getTopic(req, res, ctx, name, url) {
  if (wantsHtml(req)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return void res.end(statusPage(name));
  }
  const topic = ctx.store.getOrCreate(name);
  const waitRaw = url.searchParams.get('wait');
  if (waitRaw === null) return sendJson(res, 200, topicStatus(topic));

  const seconds = Number(waitRaw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw apiError(400, 'bad_wait', `wait must be a number of seconds (1-${MAX_WAIT_SECONDS})`);
  }
  const ms = Math.min(seconds, MAX_WAIT_SECONDS) * 1000;
  let changed = false;
  await new Promise((resolve) => {
    let done = false;
    const finish = (didChange) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      changed = didChange;
      resolve();
    };
    const timer = setTimeout(() => finish(false), ms);
    const unsub = ctx.store.subscribe(name, () => finish(true));
    req.on('close', () => finish(false));
  });
  if (res.writableEnded || res.destroyed) return;
  sendJson(res, 200, { ...topicStatus(topic), changed });
}

async function postRaise(req, res, ctx, name, url) {
  requireToken(req, ctx);
  const body = await readBody(req);
  const input = {};
  for (const key of ['by', 'to']) {
    if (url.searchParams.has(key)) input[key] = url.searchParams.get(key);
  }
  if (body.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw apiError(400, 'bad_raise', 'body must be JSON, e.g. {"by": 10} or {"to": 100}');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw apiError(400, 'bad_raise', 'body must be a JSON object');
    }
    Object.assign(input, pick(parsed, ['by', 'to']));
  }
  const current = ctx.store.get(name)?.cap ?? null;
  const newCap = parseRaise(input, current);
  const { topic, previous } = ctx.store.raise(name, newCap);
  sendJson(res, 200, { ...topicStatus(topic), previous });
}

async function getLog(req, res, ctx, name, url) {
  const topic = ctx.store.getOrCreate(name);
  const limitRaw = url.searchParams.get('limit');
  let limit = limitRaw === null ? 50 : Math.floor(Number(limitRaw));
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  limit = Math.min(limit, MAX_LOG_ENTRIES);
  const entries = topic.log.slice(-limit).reverse(); // newest first
  sendJson(res, 200, { topic: name, count: entries.length, entries });
}

function getSse(req, res, ctx, name) {
  const topic = ctx.store.getOrCreate(name);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('status', topicStatus(topic));
  const heartbeat = setInterval(() => res.write(`: hb ${Date.now()}\n\n`), SSE_HEARTBEAT_MS);
  const unsub = ctx.store.subscribe(name, send);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsub();
  });
}

// --- plumbing ---------------------------------------------------------------

function requireToken(req, ctx) {
  if (!ctx.token) return;
  const header = req.headers.authorization || '';
  if (header !== `Bearer ${ctx.token}`) {
    throw apiError(401, 'unauthorized', 'this server requires Authorization: Bearer <token> for config and raise');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        req.removeAllListeners('data');
        req.resume(); // drain the rest so the response can flush
        reject(apiError(413, 'too_large', `body must be at most ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!settled) reject(err);
    });
  });
}

function wantsHtml(req) {
  return /text\/html/.test(req.headers.accept || '');
}

function isTrue(value) {
  return value === '1' || value === 'true' || value === '';
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) if (key in obj) out[key] = obj[key];
  return out;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj) + '\n';
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendError(res, err) {
  if (res.writableEnded) return;
  const status = err.status ?? 500;
  const code = err.code ?? 'internal';
  if (status === 500) console.error(err);
  if (res.headersSent) return void res.end();
  sendJson(res, status, { error: err.message || 'internal error', code });
}
