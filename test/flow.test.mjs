// End-to-end: the overnight-run story, live SSE events, and long-polling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, req } from './helpers.mjs';
import { periodKey } from '../src/budget.mjs';

test('the whole story: cap, burn, hit the wall, raise from the phone, resume', async () => {
  const { url, close } = await boot();
  try {
    // 22:00 — insurance before the overnight run
    const put = await req(`${url}/overnight?cap=50&period=day&unit=usd`, { method: 'PUT' });
    assert.equal(put.status, 200);

    // the fleet burns budget
    for (const amount of [20, 20]) {
      const r = await req(`${url}/overnight/spend`, { method: 'POST', body: String(amount) });
      assert.equal(r.status, 200);
    }

    // 03:12 — a loop asks for more than what's left
    const wall = await req(`${url}/overnight/spend`, {
      method: 'POST',
      body: JSON.stringify({ amount: 20, note: 'retry storm' }),
    });
    assert.equal(wall.status, 429);
    assert.equal(wall.body.spent, 40);
    assert.equal(wall.body.asked, 20);
    assert.ok(wall.body.raise.endsWith('/overnight'));

    // human taps +25 on the raise page
    const raise = await req(`${url}/overnight/raise`, { method: 'POST', body: JSON.stringify({ by: 25 }) });
    assert.equal(raise.status, 200);
    assert.equal(raise.body.cap, 75);

    // the same spend now fits
    const resume = await req(`${url}/overnight/spend`, {
      method: 'POST',
      body: JSON.stringify({ amount: 20, note: 'retry storm' }),
    });
    assert.equal(resume.status, 200);
    assert.equal(resume.body.spent, 60);
    assert.equal(resume.body.remaining, 15);

    // the log tells the whole story, newest first
    const log = await req(`${url}/overnight/log`);
    assert.equal(log.body.count, 4);
    assert.deepEqual(log.body.entries.map((e) => e.allowed), [true, false, true, true]);
    assert.equal(log.body.entries[1].note, 'retry storm');

    // status agrees
    const st = await req(`${url}/overnight`);
    assert.equal(st.body.spent, 60);
    assert.equal(st.body.cap, 75);
  } finally {
    await close();
  }
});

test('SSE: status on connect, then named spend/raise events with JSON data', async () => {
  const { url, close } = await boot();
  try {
    await req(`${url}/live?cap=10`, { method: 'PUT' });

    const ac = new AbortController();
    const res = await fetch(`${url}/live/sse`, { signal: ac.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (marker) => {
      const deadline = Date.now() + 5000;
      while (!buffer.includes(marker)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${marker}; got: ${buffer}`);
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    };

    await readUntil('event: status');
    assert.match(buffer, /"cap":10/);

    await req(`${url}/live/spend`, { method: 'POST', body: '4' });
    await readUntil('event: spend');
    const spendData = JSON.parse(buffer.split('event: spend\ndata: ')[1].split('\n')[0]);
    assert.equal(spendData.amount, 4);
    assert.equal(spendData.allowed, true);
    assert.equal(spendData.spent, 4);

    await req(`${url}/live/raise`, { method: 'POST', body: JSON.stringify({ by: 5 }) });
    await readUntil('event: raise');
    assert.match(buffer, /"cap":15/);

    ac.abort();
  } finally {
    await close();
  }
});

test('long-poll: ?wait returns early on change, times out quietly otherwise', async () => {
  const { url, close } = await boot();
  try {
    await req(`${url}/lp?cap=10`, { method: 'PUT' });

    // change arrives while waiting -> returns well before the timeout
    const started = Date.now();
    const waiting = req(`${url}/lp?wait=10`);
    setTimeout(() => req(`${url}/lp/spend`, { method: 'POST', body: '3' }), 150);
    const r = await waiting;
    assert.equal(r.status, 200);
    assert.equal(r.body.changed, true);
    assert.equal(r.body.spent, 3);
    assert.ok(Date.now() - started < 5000, 'returned on the event, not the timeout');

    // nothing happens -> times out with changed: false
    const quiet = await req(`${url}/lp?wait=1`);
    assert.equal(quiet.status, 200);
    assert.equal(quiet.body.changed, false);
  } finally {
    await close();
  }
});

test('yesterday\'s window rolls over on the next touch', async () => {
  const { server, url, close } = await boot();
  try {
    await req(`${url}/roll?cap=10`, { method: 'PUT' });
    await req(`${url}/roll/spend`, { method: 'POST', body: '9' });
    // wind the stored window back a day, as if the server sat idle overnight
    const topic = server.store.get('roll');
    topic.periodKey = periodKey('day', Date.now() - 24 * 3600 * 1000);
    const st = await req(`${url}/roll`);
    assert.equal(st.body.spent, 0, 'new day, fresh counter');
    assert.equal(st.body.cap, 10, 'cap persists across windows');
    const spend = await req(`${url}/roll/spend`, { method: 'POST', body: '9' });
    assert.equal(spend.status, 200, 'yesterday\'s burn does not block today');
  } finally {
    await close();
  }
});
