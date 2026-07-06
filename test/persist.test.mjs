// JSONL persistence: replay on boot, period-aware, crash-tolerant.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { status } from '../src/budget.mjs';
import { boot, req } from './helpers.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meter-test-'));
}

test('state survives a restart: config, spends, raises, log', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const a = new Store({ dataDir: dir });
  a.configure('ops', { cap: 50, period: 'day', unit: 'usd' });
  a.spend('ops', { amount: 20, note: 'first' });
  a.spend('ops', { amount: 45 }); // denied
  a.raise('ops', 80);
  a.spend('ops', { amount: 45, note: 'after raise' });

  const b = new Store({ dataDir: dir });
  const st = status(b.get('ops'));
  assert.equal(st.cap, 80);
  assert.equal(st.spent, 65);
  assert.equal(st.remaining, 15);
  assert.equal(st.unit, 'usd');
  const log = b.get('ops').log;
  assert.equal(log.length, 3);
  assert.deepEqual(log.map((e) => e.allowed), [true, false, true]);
  assert.equal(log[0].note, 'first');
});

test('replay is period-aware: yesterday\'s spend does not count today', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const yesterday = Date.now() - 24 * 3600 * 1000;
  const a = new Store({ dataDir: dir });
  a.configure('ops', { cap: 50 }, yesterday);
  a.spend('ops', { amount: 40, at: yesterday });

  const b = new Store({ dataDir: dir });
  const st = status(b.get('ops'));
  assert.equal(st.spent, 0, 'new UTC day: counter reset on replay');
  assert.equal(st.cap, 50, 'cap survives the window reset');
  assert.equal(b.get('ops').log.length, 1, 'history is not erased by the reset');
});

test('a torn final line (crash mid-write) does not prevent boot', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const a = new Store({ dataDir: dir });
  a.configure('ops', { cap: 9 });
  a.spend('ops', { amount: 3 });
  fs.appendFileSync(path.join(dir, 'meter.jsonl'), '{"t":"spend","topic":"ops","amou');

  const b = new Store({ dataDir: dir });
  assert.equal(status(b.get('ops')).spent, 3);
});

test('persistence over HTTP: kill the server, boot a new one, state is back', async () => {
  const dir = tmpDir();
  try {
    const first = await boot({ dataDir: dir });
    await req(`${first.url}/fleet?cap=100&unit=usd`, { method: 'PUT' });
    await req(`${first.url}/fleet/spend`, { method: 'POST', body: '33.25' });
    await first.close();

    const second = await boot({ dataDir: dir });
    const st = await req(`${second.url}/fleet`);
    assert.equal(st.body.cap, 100);
    assert.equal(st.body.spent, 33.25);
    assert.equal(st.body.remaining, 66.75);
    const log = await req(`${second.url}/fleet/log`);
    assert.equal(log.body.count, 1);
    await second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without a data dir, nothing is written anywhere', () => {
  const store = new Store();
  store.spend('x', { amount: 1 });
  assert.equal(store.file, null);
});
