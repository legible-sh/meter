// The CLI: a thin client over the HTTP API, plus `meter serve`.
// Base URL resolution: --url flag > METER_URL env > https://meter.legible.sh
// Exit codes: 0 ok · 1 error · 2 over cap (matches the hook contract).

import { createServer } from './server.mjs';

const HELP = `meter — the kill-brake for agent spend. 429-as-a-service.

usage:
  meter spend <topic> <amount> [--note "..."] [--dry]   preauthorize; exit 2 if over cap
  meter status <topic>                                  spent / cap / remaining / resets
  meter cap <topic> <cap> [--period day|month|total] [--unit usd]
  meter raise <topic> --by <n> | --to <n>               lift (or set) the cap
  meter log <topic> [--limit 20]                        recent spend, newest first
  meter hook [topic]                                    print a Claude Code PreToolUse hook
  meter serve [--port 4187] [--host 0.0.0.0] [--data-dir D] [--token T] [--base-url U]

options:
  --url <base>     server to talk to (default: $METER_URL, then https://meter.legible.sh)
  --token <t>      bearer token for cap/raise on token-guarded servers ($METER_TOKEN)
`;

export async function main(argv) {
  const { positionals, flags } = parseArgs(argv);
  const [command, topic] = positionals;
  const base = (flags.url || process.env.METER_URL || 'https://meter.legible.sh').replace(/\/+$/, '');
  const token = flags.token || process.env.METER_TOKEN || null;

  try {
    switch (command) {
      case 'spend':
        return await cmdSpend(base, token, positionals, flags);
      case 'status':
        return await cmdStatus(base, requireTopic(topic));
      case 'cap':
        return await cmdCap(base, token, positionals, flags);
      case 'raise':
        return await cmdRaise(base, token, requireTopic(topic), flags);
      case 'log':
        return await cmdLog(base, requireTopic(topic), flags);
      case 'hook':
        return cmdHook(base, topic || 'claude');
      case 'serve':
        return cmdServe(flags);
      case 'help':
      case undefined:
        return void process.stdout.write(HELP);
      default:
        process.stderr.write(`meter: unknown command "${command}"\n\n${HELP}`);
        process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`meter: ${err.message}\n`);
    process.exitCode = 1;
  }
}

// --- commands ---------------------------------------------------------------

async function cmdSpend(base, token, positionals, flags) {
  const [, topic, amountRaw] = positionals;
  requireTopic(topic);
  if (amountRaw === undefined) throw new Error('usage: meter spend <topic> <amount> [--note "..."] [--dry]');
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount)) throw new Error(`"${amountRaw}" is not a number`);
  const body = flags.note != null ? JSON.stringify({ amount, note: String(flags.note) }) : String(amountRaw);
  const dry = flags.dry ? '?dry=1' : '';
  const { status, data } = await api(`${base}/${topic}/spend${dry}`, { method: 'POST', body }, token);
  if (status === 200) {
    const prefix = data.dry ? '[dry] would fit — ' : 'ok — ';
    if (data.cap == null) {
      print(`${prefix}${fmt(data.spent)} ${data.unit} spent this ${data.period} (no cap set)`);
    } else {
      print(`${prefix}${fmt(data.spent)} of ${fmt(data.cap)} ${data.unit} spent this ${data.period}, ${fmt(data.remaining)} left`);
    }
    return;
  }
  if (status === 429) {
    process.stderr.write(
      `${data.dry ? '[dry] would not fit — ' : ''}OVER CAP — asked ${fmt(data.asked)}, spent ${fmt(data.spent)} of ${fmt(data.cap)} ${data.unit} this ${data.period}.\n` +
      `raise it: ${data.raise}\n`
    );
    process.exitCode = 2;
    return;
  }
  fail(status, data);
}

async function cmdStatus(base, topic) {
  const { status, data } = await api(`${base}/${topic}`);
  if (status !== 200) return fail(status, data);
  const lines = [
    `topic      ${data.topic}`,
    data.cap == null
      ? `spent      ${fmt(data.spent)} ${data.unit} (no cap set — tracking only)`
      : `spent      ${fmt(data.spent)} of ${fmt(data.cap)} ${data.unit}`,
    ...(data.cap == null ? [] : [`remaining  ${fmt(data.remaining)} ${data.unit}`]),
    `period     ${data.period}${data.resets ? ` (resets ${data.resets})` : ''}`,
  ];
  print(lines.join('\n'));
}

async function cmdCap(base, token, positionals, flags) {
  const [, topic, capRaw] = positionals;
  requireTopic(topic);
  if (capRaw === undefined) throw new Error('usage: meter cap <topic> <cap> [--period day|month|total] [--unit usd]');
  const body = { cap: capRaw === 'none' ? null : Number(capRaw) };
  if (flags.period) body.period = String(flags.period);
  if (flags.unit) body.unit = String(flags.unit);
  const { status, data } = await api(`${base}/${topic}`, { method: 'PUT', body: JSON.stringify(body) }, token);
  if (status !== 200) return fail(status, data);
  print(data.cap == null
    ? `cap cleared — ${data.topic} is track-only (${fmt(data.spent)} ${data.unit} spent this ${data.period})`
    : `cap set — ${fmt(data.cap)} ${data.unit} per ${data.period} (${fmt(data.remaining)} remaining)`);
}

async function cmdRaise(base, token, topic, flags) {
  const body = {};
  if (flags.by != null) body.by = Number(flags.by);
  if (flags.to != null) body.to = Number(flags.to);
  if (!('by' in body) && !('to' in body)) throw new Error('usage: meter raise <topic> --by <n> | --to <n>');
  const { status, data } = await api(`${base}/${topic}/raise`, { method: 'POST', body: JSON.stringify(body) }, token);
  if (status !== 200) return fail(status, data);
  print(`cap raised — ${data.previous == null ? 'none' : fmt(data.previous)} → ${fmt(data.cap)} ${data.unit} (${fmt(data.remaining)} remaining this ${data.period})`);
}

async function cmdLog(base, topic, flags) {
  const limit = flags.limit ? `?limit=${Number(flags.limit)}` : '';
  const { status, data } = await api(`${base}/${topic}/log${limit}`);
  if (status !== 200) return fail(status, data);
  if (!data.entries.length) return print(`no spend recorded on ${topic} yet`);
  for (const e of data.entries) {
    const mark = e.allowed ? ' + ' : ' ✗ ';
    print(`${e.at}${mark}${fmt(e.amount)}${e.note ? `  ${e.note}` : ''}`);
  }
}

function cmdHook(base, topic) {
  const spendUrl = `${base}/${topic}/spend`;
  const raiseUrl = `${base}/${topic}`;
  const command =
    `code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST -d 1 '${spendUrl}'); ` +
    `if [ "$code" = "429" ]; then echo 'meter: ${topic} is over budget — raise the cap: ${raiseUrl}' >&2; exit 2; fi`;
  const snippet = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|Task|WebFetch|WebSearch',
          hooks: [{ type: 'command', command }],
        },
      ],
    },
  };
  process.stderr.write(
    `# Paste the "hooks" block into .claude/settings.json (or ~/.claude/settings.json).\n` +
    `# Every Bash/Task/WebFetch/WebSearch call spends 1 against ${spendUrl};\n` +
    `# a 429 blocks the tool call (exit 2) and tells Claude why. Set the cap first:\n` +
    `#   meter cap ${topic} 500 --period day --unit calls\n`
  );
  print(JSON.stringify(snippet, null, 2));
}

function cmdServe(flags) {
  const port = Number(flags.port ?? process.env.PORT ?? 4187);
  const host = String(flags.host ?? '0.0.0.0');
  const dataDir = flags['data-dir'] ? String(flags['data-dir']) : null;
  const token = flags.token ? String(flags.token) : null;
  const baseUrl = flags['base-url'] ? String(flags['base-url']) : null;
  const server = createServer({ dataDir, token, baseUrl });
  server.on('error', (err) => {
    process.stderr.write(`meter: ${err.code === 'EADDRINUSE' ? `port ${port} is already in use` : err.message}\n`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const shownHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    print(`meter listening on http://${shownHost}:${server.address().port}`);
    print(`  data:  ${dataDir ? `${dataDir}/meter.jsonl` : 'in-memory only (gone on restart — use --data-dir)'}`);
    print(`  token: ${token ? 'required for cap/raise' : 'none (anyone with a topic name can cap/raise)'}`);
  });
  return server;
}

// --- plumbing ---------------------------------------------------------------

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[arg.slice(2)] = argv[++i];
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

async function api(url, init = {}, token = null) {
  const headers = { ...(init.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (err) {
    throw new Error(`cannot reach ${url} (${err.cause?.code || err.message}) — is the server up? set --url or METER_URL`);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text.trim() || `unexpected response (${res.status})` };
  }
  return { status: res.status, data };
}

function requireTopic(topic) {
  if (!topic) throw new Error('missing <topic> — try: meter help');
  return topic;
}

function fail(status, data) {
  process.stderr.write(`meter: ${data.error || 'request failed'} (${data.code || status})\n`);
  process.exitCode = 1;
}

function fmt(n) {
  if (n == null) return '–';
  return Number(n.toFixed(6)).toString();
}

function print(line) {
  process.stdout.write(line + '\n');
}
