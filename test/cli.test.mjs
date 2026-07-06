// The CLI as a subprocess against a real server: every verb, real exit codes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boot } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/meter.mjs', import.meta.url));

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, METER_URL: '', METER_TOKEN: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('cap, spend, status, raise, log — the full loop, correct exit codes', async () => {
  const { url, close } = await boot();
  try {
    const cap = await run(['cap', 'cli-t', '50', '--period', 'day', '--unit', 'usd', '--url', url]);
    assert.equal(cap.code, 0, cap.stderr);
    assert.match(cap.stdout, /cap set — 50 usd per day/);

    const spend = await run(['spend', 'cli-t', '20', '--note', 'batch one', '--url', url]);
    assert.equal(spend.code, 0, spend.stderr);
    assert.match(spend.stdout, /ok — 20 of 50 usd .* 30 left/);

    const dry = await run(['spend', 'cli-t', '25', '--dry', '--url', url]);
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /\[dry\] would fit/);

    const over = await run(['spend', 'cli-t', '40', '--url', url]);
    assert.equal(over.code, 2, 'over cap exits 2 — the hook contract');
    assert.match(over.stderr, /OVER CAP/);
    assert.match(over.stderr, /raise it: /);

    const status = await run(['status', 'cli-t', '--url', url]);
    assert.equal(status.code, 0);
    assert.match(status.stdout, /spent\s+20 of 50 usd/);
    assert.match(status.stdout, /remaining\s+30 usd/);

    const raise = await run(['raise', 'cli-t', '--by', '25', '--url', url]);
    assert.equal(raise.code, 0);
    assert.match(raise.stdout, /cap raised — 50 → 75 usd/);

    const retry = await run(['spend', 'cli-t', '40', '--url', url]);
    assert.equal(retry.code, 0, 'fits after the raise');

    const log = await run(['log', 'cli-t', '--url', url]);
    assert.equal(log.code, 0);
    assert.match(log.stdout, /batch one/);
    assert.match(log.stdout, / ✗ 40/, 'denied spend shows in the log');
  } finally {
    await close();
  }
});

test('spend against a track-only topic reports no cap', async () => {
  const { url, close } = await boot();
  try {
    const r = await run(['spend', 'free', '5', '--url', url]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no cap set/);
  } finally {
    await close();
  }
});

test('METER_URL env is respected; --token is sent', async () => {
  const { url, close } = await boot({ token: 'hunter2' });
  try {
    const denied = await run(['cap', 'guarded', '10'], { METER_URL: url });
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /unauthorized/);

    const ok = await run(['cap', 'guarded', '10', '--token', 'hunter2'], { METER_URL: url });
    assert.equal(ok.code, 0, ok.stderr);

    const viaEnv = await run(['raise', 'guarded', '--by', '5'], { METER_URL: url, METER_TOKEN: 'hunter2' });
    assert.equal(viaEnv.code, 0, viaEnv.stderr);
  } finally {
    await close();
  }
});

test('hook prints valid Claude Code hooks JSON on stdout', async () => {
  const r = await run(['hook', 'fleet', '--url', 'http://127.0.0.1:4187']);
  assert.equal(r.code, 0);
  const snippet = JSON.parse(r.stdout);
  const rule = snippet.hooks.PreToolUse[0];
  assert.equal(rule.matcher, 'Bash|Task|WebFetch|WebSearch');
  assert.match(rule.hooks[0].command, /http:\/\/127\.0\.0\.1:4187\/fleet\/spend/);
  assert.match(rule.hooks[0].command, /exit 2/);
  assert.match(r.stderr, /settings\.json/, 'usage guidance goes to stderr, JSON stays clean');
});

test('unknown command and missing args fail politely', async () => {
  const bad = await run(['frobnicate']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown command/);

  const noTopic = await run(['status']);
  assert.equal(noTopic.code, 1);
  assert.match(noTopic.stderr, /missing <topic>/);

  const help = await run([]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /usage:/);
});

test('serve boots a working server from the CLI', async () => {
  const child = spawn(process.execPath, [BIN, 'serve', '--port', '0', '--host', '127.0.0.1']);
  let out = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve never came up: ${out}`)), 5000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/smoke/spend`, { method: 'POST', body: '1' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.spent, 1);
  } finally {
    child.kill();
  }
});
