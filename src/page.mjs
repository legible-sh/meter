// The browser view of GET /{topic}: a live status page with a big remaining
// bar, raise buttons, and the recent spend log. Self-contained — inline CSS
// and JS, no external assets. All data comes from the same JSON API and the
// /sse stream; this page is just a client.

export function statusPage(name) {
  // Topic names match [a-zA-Z0-9_-]{1,64}, so they are HTML- and JS-safe as-is.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} · meter</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: #0b0e14; color: #e6e8ee;
    font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; justify-content: center; min-height: 100vh; padding: 24px 16px;
  }
  main { width: 100%; max-width: 640px; }
  .crumb { color: #8b93a7; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; }
  h1 { font-size: 28px; margin: 2px 0 18px; word-break: break-all; }
  h1 .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .card { background: #11151f; border: 1px solid #1e2433; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .big { font-size: 44px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .big small { font-size: 18px; font-weight: 400; color: #8b93a7; margin-left: 6px; }
  .sub { color: #8b93a7; font-size: 14px; margin-top: 2px; }
  .bar { height: 14px; background: #1e2433; border-radius: 7px; overflow: hidden; margin: 16px 0 8px; }
  .bar i { display: block; height: 100%; width: 0%; background: #34d399; border-radius: 7px; transition: width .3s, background .3s; }
  .bar i.warn { background: #fbbf24; }
  .bar i.over { background: #f87171; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
  button, input {
    font: inherit; border-radius: 8px; border: 1px solid #2a3247;
    background: #1a2030; color: #e6e8ee; padding: 8px 14px;
  }
  button { cursor: pointer; }
  button:hover { border-color: #4b5876; }
  button.primary { background: #2b4bd7; border-color: #2b4bd7; }
  input { width: 110px; }
  #msg { font-size: 14px; margin-top: 10px; min-height: 20px; }
  #msg.err { color: #f87171; } #msg.ok { color: #34d399; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; font-variant-numeric: tabular-nums; }
  td { padding: 6px 8px 6px 0; border-top: 1px solid #1e2433; vertical-align: top; }
  td.amt { text-align: right; white-space: nowrap; }
  td.denied { color: #f87171; }
  td.when { color: #8b93a7; white-space: nowrap; }
  td.note { color: #b9c0d4; word-break: break-word; }
  details { margin-top: 12px; color: #8b93a7; font-size: 14px; }
  footer { color: #566; font-size: 13px; text-align: center; margin-top: 24px; }
  footer a { color: #8b93a7; }
</style>
</head>
<body>
<main>
  <div class="crumb">meter · budget</div>
  <h1><span class="mono">${name}</span></h1>

  <div class="card">
    <div class="big" id="remaining">–</div>
    <div class="sub" id="detail">loading…</div>
    <div class="bar"><i id="fill"></i></div>
    <div class="sub" id="resets"></div>
    <div class="row">
      <button onclick="raisePct(10)">+10%</button>
      <button onclick="raiseBy(10)">+10</button>
      <button onclick="raiseBy(50)">+50</button>
      <input id="custom" type="number" min="0" step="any" placeholder="custom">
      <button class="primary" onclick="raiseCustom()">raise</button>
    </div>
    <div id="msg"></div>
    <details><summary>token</summary>
      <p>If this server runs with <code>--token</code>, raising needs it:</p>
      <input id="token" type="password" placeholder="bearer token" style="width:100%;margin-top:6px">
    </details>
  </div>

  <div class="card">
    <div class="crumb" style="margin-bottom:8px">recent spend</div>
    <table id="log"><tbody></tbody></table>
    <div class="sub" id="logempty">no spend yet</div>
  </div>

  <footer>live via SSE · <a href="/">meter — 429-as-a-service</a></footer>
</main>
<script>
  const topic = "${name}";
  let st = null;
  const $ = (id) => document.getElementById(id);
  $('token').value = localStorage.getItem('meter-token') || '';
  $('token').addEventListener('change', () => localStorage.setItem('meter-token', $('token').value));

  function fmt(n) { return n == null ? '–' : Number(n.toFixed(6)).toLocaleString('en-US', { maximumFractionDigits: 6 }); }

  function render() {
    if (!st) return;
    const capped = st.cap != null;
    $('remaining').innerHTML = capped
      ? fmt(st.remaining) + '<small>' + st.unit + ' left</small>'
      : fmt(st.spent) + '<small>' + st.unit + ' spent</small>';
    $('detail').textContent = capped
      ? fmt(st.spent) + ' of ' + fmt(st.cap) + ' ' + st.unit + ' spent this ' + st.period
      : 'no cap set — tracking only (' + st.period + ')';
    const pct = capped && st.cap > 0 ? Math.min(100, (st.spent / st.cap) * 100) : (capped ? 100 : 0);
    const fill = $('fill');
    fill.style.width = pct + '%';
    fill.className = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
    $('resets').textContent = st.resets ? 'resets ' + new Date(st.resets).toUTCString() : 'never resets (period: total)';
  }

  function logRow(e) {
    const tr = document.createElement('tr');
    const when = new Date(e.at).toISOString().replace('T', ' ').slice(0, 19);
    tr.innerHTML = '<td class="when">' + when + '</td>' +
      '<td class="amt' + (e.allowed ? '' : ' denied') + '">' + (e.allowed ? '+' : '✗ ') + fmt(e.amount) + '</td>' +
      '<td class="note"></td>';
    tr.lastChild.textContent = e.note || '';
    return tr;
  }

  async function loadLog() {
    const r = await fetch('/' + topic + '/log?limit=25');
    const data = await r.json();
    const tbody = $('log').tBodies[0];
    tbody.replaceChildren(...data.entries.map(logRow));
    $('logempty').style.display = data.entries.length ? 'none' : '';
  }

  function say(text, cls) { const m = $('msg'); m.textContent = text; m.className = cls; }

  async function raise(body) {
    const headers = { 'content-type': 'application/json' };
    const tok = $('token').value.trim();
    if (tok) headers.authorization = 'Bearer ' + tok;
    const r = await fetch('/' + topic + '/raise', { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await r.json();
    if (r.ok) say('cap raised to ' + fmt(data.cap) + ' ' + data.unit, 'ok');
    else if (r.status === 401) say('unauthorized — set the token below', 'err');
    else say(data.error || 'raise failed', 'err');
  }
  function raiseBy(n) { raise({ by: n }); }
  function raisePct(p) {
    if (!st || st.cap == null) return say('no cap set — use PUT or a custom raise-to first', 'err');
    raise({ by: Math.max(st.cap * p / 100, 0.000001) });
  }
  function raiseCustom() {
    const v = Number($('custom').value);
    if (!Number.isFinite(v) || v <= 0) return say('enter a positive amount to raise by', 'err');
    raise({ by: v });
  }

  fetch('/' + topic).then(r => r.json()).then(s => { st = s; render(); });
  loadLog();
  const es = new EventSource('/' + topic + '/sse');
  es.addEventListener('status', (e) => { st = JSON.parse(e.data); render(); });
  es.addEventListener('spend', (e) => {
    const d = JSON.parse(e.data);
    if (st) { st.spent = d.spent; st.cap = d.cap; st.remaining = d.remaining; render(); }
    const tbody = $('log').tBodies[0];
    tbody.prepend(logRow(d));
    while (tbody.rows.length > 25) tbody.deleteRow(-1);
    $('logempty').style.display = 'none';
  });
  es.addEventListener('raise', (e) => { st = { ...st, ...JSON.parse(e.data) }; render(); });
  es.addEventListener('config', (e) => { st = { ...st, ...JSON.parse(e.data) }; render(); });
</script>
</body>
</html>
`;
}
