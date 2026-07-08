// Token behavior: --token guards config and raise; spend and reads never need it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, req } from './helpers.mjs';

const TOKEN = 's3cret-token';
const auth = { authorization: `Bearer ${TOKEN}` };

test('with --token: PUT and raise are guarded', async () => {
  const { url, close } = await boot({ token: TOKEN });
  try {
    const noToken = await req(`${url}/t?cap=50`, { method: 'PUT' });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.body.code, 'unauthorized');
    assert.match(noToken.body.hint, /Authorization: Bearer/, '401 hint shows the header to resend with');
    assert.match(noToken.body.hint, /never need/, '401 hint says spend stays open');

    const wrongToken = await req(`${url}/t?cap=50`, { method: 'PUT', headers: { authorization: 'Bearer nope' } });
    assert.equal(wrongToken.status, 401);

    const withToken = await req(`${url}/t?cap=50`, { method: 'PUT', headers: auth });
    assert.equal(withToken.status, 200);
    assert.equal(withToken.body.cap, 50);

    const raiseNoToken = await req(`${url}/t/raise`, { method: 'POST', body: JSON.stringify({ by: 10 }) });
    assert.equal(raiseNoToken.status, 401);

    const raiseWithToken = await req(`${url}/t/raise`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ by: 10 }),
    });
    assert.equal(raiseWithToken.status, 200);
    assert.equal(raiseWithToken.body.cap, 60);
  } finally {
    await close();
  }
});

test('with --token: spend, status, log, sse stay open', async () => {
  const { url, close } = await boot({ token: TOKEN });
  try {
    await req(`${url}/t?cap=50`, { method: 'PUT', headers: auth });

    const spend = await req(`${url}/t/spend`, { method: 'POST', body: '5' });
    assert.equal(spend.status, 200, 'spend never requires the token — brakes must not need keys');

    const status = await req(`${url}/t`);
    assert.equal(status.status, 200);

    const log = await req(`${url}/t/log`);
    assert.equal(log.status, 200);

    const ac = new AbortController();
    const sse = await fetch(`${url}/t/sse`, { signal: ac.signal });
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get('content-type'), /text\/event-stream/);
    ac.abort();
  } finally {
    await close();
  }
});

test('with --token: /README.md and /llms.txt stay open', async () => {
  const { url, close } = await boot({ token: TOKEN });
  try {
    const readme = await req(`${url}/README.md`);
    assert.equal(readme.status, 200, 'discovery docs never need the token');
    const llms = await req(`${url}/llms.txt`);
    assert.equal(llms.status, 200);
  } finally {
    await close();
  }
});

test('without --token: everything is open', async () => {
  const { url, close } = await boot();
  try {
    const put = await req(`${url}/t?cap=5`, { method: 'PUT' });
    assert.equal(put.status, 200);
    const raise = await req(`${url}/t/raise?by=5`, { method: 'POST' });
    assert.equal(raise.status, 200);
    assert.equal(raise.body.cap, 10);
  } finally {
    await close();
  }
});
