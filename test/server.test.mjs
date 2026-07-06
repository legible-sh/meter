// HTTP surface: every endpoint, happy paths and edge cases, over real sockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, req } from './helpers.mjs';
import { MAX_BODY_BYTES } from '../src/limits.mjs';

test('spend auto-creates the topic in track-only mode', async () => {
  const { url, close } = await boot();
  try {
    const r = await req(`${url}/fresh-topic/spend`, { method: 'POST', body: '2.5' });
    assert.equal(r.status, 200);
    assert.equal(r.body.spent, 2.5);
    assert.equal(r.body.cap, null);
    assert.equal(r.body.remaining, null);
    assert.match(r.body.message, /no cap set/);
    assert.equal(r.body.period, 'day');
  } finally {
    await close();
  }
});

test('cap enforcement: 200 under, 429 over, nothing committed on deny', async () => {
  const { url, close } = await boot();
  try {
    const put = await req(`${url}/t2?cap=10&unit=usd`, { method: 'PUT' });
    assert.equal(put.status, 200);
    assert.equal(put.body.cap, 10);
    assert.equal(put.body.unit, 'usd');

    const ok = await req(`${url}/t2/spend`, { method: 'POST', body: '6' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.remaining, 4);

    const denied = await req(`${url}/t2/spend`, { method: 'POST', body: '5' });
    assert.equal(denied.status, 429);
    assert.equal(denied.body.code, 'over_cap');
    assert.equal(denied.body.asked, 5);
    assert.equal(denied.body.spent, 6);
    assert.equal(denied.body.cap, 10);
    assert.ok(denied.body.raise.endsWith('/t2'), `raise URL points at the topic page: ${denied.body.raise}`);

    const st = await req(`${url}/t2`);
    assert.equal(st.body.spent, 6, '429 committed nothing');
  } finally {
    await close();
  }
});

test('exact-fit spend is allowed (cap boundary is inclusive)', async () => {
  const { url, close } = await boot();
  try {
    await req(`${url}/exact?cap=10`, { method: 'PUT' });
    const r = await req(`${url}/exact/spend`, { method: 'POST', body: '10' });
    assert.equal(r.status, 200);
    assert.equal(r.body.remaining, 0);
    const over = await req(`${url}/exact/spend`, { method: 'POST', body: '0.01' });
    assert.equal(over.status, 429);
  } finally {
    await close();
  }
});

test('?dry=1 checks without committing, both directions', async () => {
  const { url, close } = await boot();
  try {
    await req(`${url}/t3?cap=10`, { method: 'PUT' });
    const fitsDry = await req(`${url}/t3/spend?dry=1`, { method: 'POST', body: '8' });
    assert.equal(fitsDry.status, 200);
    assert.equal(fitsDry.body.dry, true);
    assert.equal(fitsDry.body.committed, false);
    assert.equal(fitsDry.body.spent, 0, 'dry run commits nothing');

    const overDry = await req(`${url}/t3/spend?dry=1`, { method: 'POST', body: '11' });
    assert.equal(overDry.status, 429);
    assert.equal(overDry.body.dry, true);

    const st = await req(`${url}/t3`);
    assert.equal(st.body.spent, 0);
    const log = await req(`${url}/t3/log`);
    assert.equal(log.body.count, 0, 'dry runs are not logged');
  } finally {
    await close();
  }
});

test('PUT accepts JSON body and query params; body wins on conflict', async () => {
  const { url, close } = await boot();
  try {
    const viaJson = await req(`${url}/t4`, {
      method: 'PUT',
      body: JSON.stringify({ cap: 1000000, period: 'month', unit: 'tokens' }),
    });
    assert.equal(viaJson.status, 200);
    assert.equal(viaJson.body.cap, 1000000);
    assert.equal(viaJson.body.period, 'month');
    assert.equal(viaJson.body.unit, 'tokens');
    assert.match(viaJson.body.resets, /^\d{4}-\d{2}-01T00:00:00/);

    const mixed = await req(`${url}/t4?cap=5`, { method: 'PUT', body: JSON.stringify({ cap: 7 }) });
    assert.equal(mixed.body.cap, 7, 'JSON body overrides query param');
    assert.equal(mixed.body.period, 'month', 'partial update keeps period');

    const cleared = await req(`${url}/t4?cap=none`, { method: 'PUT' });
    assert.equal(cleared.body.cap, null, 'cap=none clears back to track-only');
  } finally {
    await close();
  }
});

test('GET status: JSON for curl, HTML page for browsers', async () => {
  const { url, close } = await boot();
  try {
    const json = await req(`${url}/t5`);
    assert.equal(json.status, 200);
    assert.equal(json.body.topic, 't5');
    assert.equal(json.body.spent, 0);

    const html = await req(`${url}/t5`, { headers: { accept: 'text/html,application/xhtml+xml' } });
    assert.equal(html.status, 200);
    assert.match(html.text, /<!doctype html>/);
    assert.match(html.text, /t5/);
    assert.match(html.text, /\/t5\/raise|raise/i, 'page has raise controls');
  } finally {
    await close();
  }
});

test('raise: by, to, and creating a first cap with to', async () => {
  const { url, close } = await boot();
  try {
    await req(`${url}/t6?cap=50`, { method: 'PUT' });
    const by = await req(`${url}/t6/raise`, { method: 'POST', body: JSON.stringify({ by: 25 }) });
    assert.equal(by.status, 200);
    assert.equal(by.body.cap, 75);
    assert.equal(by.body.previous, 50);

    const to = await req(`${url}/t6/raise?to=200`, { method: 'POST' });
    assert.equal(to.body.cap, 200);

    const first = await req(`${url}/t7/raise`, { method: 'POST', body: JSON.stringify({ to: 30 }) });
    assert.equal(first.status, 200);
    assert.equal(first.body.cap, 30);
    assert.equal(first.body.previous, null);

    const noCap = await req(`${url}/t8/raise`, { method: 'POST', body: JSON.stringify({ by: 10 }) });
    assert.equal(noCap.status, 400);
    assert.equal(noCap.body.code, 'no_cap');
  } finally {
    await close();
  }
});

test('log: newest first, limit respected, denied spends included', async () => {
  const { url, close } = await boot();
  try {
    await req(`${url}/t9?cap=5`, { method: 'PUT' });
    await req(`${url}/t9/spend`, { method: 'POST', body: '1' });
    await req(`${url}/t9/spend`, { method: 'POST', body: JSON.stringify({ amount: 2, note: 'second' }) });
    await req(`${url}/t9/spend`, { method: 'POST', body: '99' }); // denied
    const r = await req(`${url}/t9/log?limit=2`);
    assert.equal(r.status, 200);
    assert.equal(r.body.count, 2);
    assert.equal(r.body.entries[0].amount, 99);
    assert.equal(r.body.entries[0].allowed, false);
    assert.equal(r.body.entries[1].note, 'second');
    assert.equal(r.body.entries[1].allowed, true);
    const all = await req(`${url}/t9/log`);
    assert.equal(all.body.count, 3);
  } finally {
    await close();
  }
});

test('errors are JSON {error, code} with correct statuses', async () => {
  const { url, close } = await boot();
  try {
    const badTopic = await req(`${url}/${'x'.repeat(65)}`, { method: 'GET' });
    assert.equal(badTopic.status, 400);
    assert.equal(badTopic.body.code, 'bad_topic');

    const badAmount = await req(`${url}/t/spend`, { method: 'POST', body: 'abc' });
    assert.equal(badAmount.status, 400);
    assert.equal(badAmount.body.code, 'bad_amount');

    const zero = await req(`${url}/t/spend`, { method: 'POST', body: '0' });
    assert.equal(zero.status, 400);

    const tooBig = await req(`${url}/t/spend`, { method: 'POST', body: 'x'.repeat(MAX_BODY_BYTES + 1000) });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.body.code, 'too_large');

    const wrongMethod = await req(`${url}/t/spend`, { method: 'GET' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.body.code, 'method_not_allowed');

    const postTopic = await req(`${url}/t`, { method: 'POST', body: '1' });
    assert.equal(postTopic.status, 405);

    const unknownSub = await req(`${url}/t/unknown`);
    assert.equal(unknownSub.status, 404);
    assert.equal(unknownSub.body.code, 'not_found');

    const deepPath = await req(`${url}/a/b/c`);
    assert.equal(deepPath.status, 404);

    const badWait = await req(`${url}/t?wait=abc`);
    assert.equal(badWait.status, 400);
    assert.equal(badWait.body.code, 'bad_wait');

    const badConfig = await req(`${url}/t`, { method: 'PUT' });
    assert.equal(badConfig.status, 400);
    assert.equal(badConfig.body.code, 'bad_config');

    const badPeriod = await req(`${url}/t?cap=5&period=week`, { method: 'PUT' });
    assert.equal(badPeriod.status, 400);
    assert.equal(badPeriod.body.code, 'bad_period');
  } finally {
    await close();
  }
});

test('root: plain-text usage for curl, CORS on by default', async () => {
  const { url, close } = await boot();
  try {
    const r = await req(url + '/');
    assert.equal(r.status, 200);
    assert.match(r.text, /kill-brake/);
    assert.match(r.text, /POST \/\{topic\}\/spend/);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');

    const preflight = await req(`${url}/t/spend`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
  } finally {
    await close();
  }
});

test('--base-url is used for raise URLs in 429s', async () => {
  const { url, close } = await boot({ baseUrl: 'https://meter.example.com/' });
  try {
    await req(`${url}/tb?cap=1`, { method: 'PUT' });
    const denied = await req(`${url}/tb/spend`, { method: 'POST', body: '2' });
    assert.equal(denied.body.raise, 'https://meter.example.com/tb');
  } finally {
    await close();
  }
});
