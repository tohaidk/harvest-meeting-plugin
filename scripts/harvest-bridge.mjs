#!/usr/bin/env node
// Harvest meeting bridge: one bot in one meeting, driven through files, no MCP.
//
//   node harvest-bridge.mjs <meeting-url> [--events FILE] [--commands FILE] [--api URL]
//
// Events (one JSON object per line) are appended to --events; every line has an "event" field.
// Commands (one JSON object per line) appended to --commands are sent to the bot, e.g.
//   {"type":"speak","text":"Hello"}   {"type":"chat","text":"link"}   {"type":"leave"}
// The key comes from HARVEST_API_KEY or ~/.harvest/config.json {"api_key": "..."}; it is never printed.
// Requires Node 22+ (global fetch and WebSocket). No npm install.
import { appendFileSync, existsSync, openSync, readSync, closeSync, statSync, writeFileSync, readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const meetingUrl = args.find((a) => /^https:\/\//.test(a));
if (!meetingUrl) {
  console.error('usage: harvest-bridge.mjs <meeting-url> [--events FILE] [--commands FILE] [--api URL]');
  process.exit(2);
}
const api = (flag('api', process.env.HARVEST_API_URL || 'https://gateway.tryharvest.ai/v1')).replace(/\/$/, '');
const eventsFile = resolve(flag('events', 'meeting-events.jsonl'));
const commandsFile = resolve(flag('commands', 'meeting-commands.jsonl'));
const key = process.env.HARVEST_API_KEY || readKey();
if (!key) {
  console.error('No key. Set HARVEST_API_KEY or write {"api_key":"hvst_live_..."} to ~/.harvest/config.json');
  process.exit(2);
}

function readKey() {
  const path = join(homedir(), '.harvest', 'config.json');
  try { return JSON.parse(readFileSync(path, 'utf8')).api_key || ''; } catch { return ''; }
}

const emit = (event) => appendFileSync(eventsFile, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
const rest = async (method, path, body) => {
  const res = await fetch(api + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
};

if (!existsSync(commandsFile)) writeFileSync(commandsFile, '');
let botId;
let ws;
let ended = false;

async function finish(reason) {
  if (ended) return;
  ended = true;
  try { if (botId) await rest('DELETE', `/bots/${botId}`); } catch { /* best effort */ }
  emit({ event: 'call.ended', reason });
  try { ws?.close(); } catch { /* closed */ }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', () => void finish('interrupted'));
process.on('SIGTERM', () => void finish('terminated'));

// 1. Create the bot.
const created = await rest('POST', '/bots', { meet_url: meetingUrl });
if (created.status >= 400) {
  emit({ event: 'call.error', http: created.status, ...created.json });
  process.exit(1);
}
botId = created.json.bot_id;
const opId = created.json.operation_id;
emit({ event: 'call.created', bot_id: botId, operation_id: opId, state: created.json.state });

// 2. Follow the join until it is active or terminal.
const TERMINAL = new Set(['rejected', 'bot_blocked', 'admission_timeout', 'join_failed', 'disconnected', 'cancelled']);
let last = '';
for (let i = 0; i < 70 && !ended; i += 1) {
  const s = await rest('GET', `/bots/${botId}`);
  const state = s.json.state || s.json.status || 'unknown';
  if (state !== last) {
    emit({ event: state === 'waiting_room' ? 'call.bot_waiting_room' : `call.${state}`, bot_id: botId, ...s.json });
    last = state;
  }
  if (state === 'active') break;
  if (TERMINAL.has(state)) { await finish(state); }
  await new Promise((r) => setTimeout(r, 3000));
}
if (last !== 'active') await finish(`join_${last || 'timeout'}`);

// 3. Stream: meeting events in, commands out.
const wsUrl = api.replace(/^http/, 'ws') + `/sessions/${botId}/stream`;
ws = new WebSocket(wsUrl, ['harvest.v1', `harvest.bearer.${key}`]);
ws.onmessage = (m) => {
  let e;
  try { e = JSON.parse(String(m.data)); } catch { return; }
  const { type, ...rest } = e;
  emit({ event: type, ...rest });
  if (type === 'session.ended') void finish(rest.reason || 'session_ended');
};
ws.onerror = () => emit({ event: 'stream.error' });
ws.onclose = () => { if (!ended) void finish('stream_closed'); };
ws.onopen = () => emit({ event: 'call.bot_ready', bot_id: botId });

// 4. Commands file: send each new line.
let offset = statSync(commandsFile).size;
const pump = () => {
  const size = statSync(commandsFile).size;
  if (size <= offset) { offset = Math.min(offset, size); return; }
  const fd = openSync(commandsFile, 'r');
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  offset = size;
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let cmd;
    try { cmd = JSON.parse(line); } catch { emit({ event: 'command.error', reason: 'invalid_json' }); continue; }
    const type = cmd.type || cmd.command;
    if (type === 'leave') { void finish('left'); return; }
    if (ws?.readyState === 1) ws.send(JSON.stringify({ ...cmd, type }));
    else emit({ event: 'command.error', reason: 'stream_not_open', type });
  }
};
watch(commandsFile, { persistent: true }, pump);
setInterval(pump, 500).unref?.();
