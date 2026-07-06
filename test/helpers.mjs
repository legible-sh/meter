// Shared test plumbing: boot a real server on an ephemeral port, tiny fetch wrapper.
import { createServer } from '../src/server.mjs';

export async function boot(options = {}) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  return { server, url, close };
}

export async function req(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, text, headers: res.headers };
}
