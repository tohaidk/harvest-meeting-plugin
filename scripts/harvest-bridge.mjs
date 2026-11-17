#!/usr/bin/env node
// Harvest meeting bridge: one bot in one meeting, driven through files or stdio, no MCP.
//
//   node harvest-bridge.mjs <meeting-url> [options]
//
// Options (AgentCall-compatible names):
//   --name NAME               name the bot shows and says
//   --voice VOICE             alloy ash ballad coral echo fable nova onyx sage shimmer verse marin cedar
//   --voice-strategy S        direct (you speak with tts.speak/speak) | realtime (bot answers, asks you via agent.request)
//   --context TEXT            meeting background for the bot (up to 4000 chars)
//   --trigger-words A,B       words the bot answers to
//   --language CODE           transcription language (en, ru, ...)
//   --webpage-url URL         show this https page as the bot camera once it is in
//   --max-duration MIN        leave after this many minutes
//   --alone-timeout SEC       leave this long after everyone else left
//   --vad-timeout SEC         merge finals into one user.message after this much quiet (default 1.25)
//   --output / --events FILE  events file (JSON lines); events are also printed to stdout
//   --commands FILE           commands file (JSON lines); stdin lines work too
//   --api URL                 default https://gateway.tryharvest.ai/v1
//
// Events have an "event" field: call.created, call.bot_waiting_room, call.bot_ready, transcript.final,
// user.message, greeting.prompt, participant.joined, participant.left, chat.received, active_speaker,
// agent.request, command.ack, command.error, call.ended, plus raw stream events.
// Commands: {"command":"tts.speak","text":"Hi"} or {"type":"speak","text":"Hi"}; chat, raise_hand,
// screenshare.start {url}, tasks.set, set_state, mic {action}, inject.natural, leave, ...
// The key comes from HARVEST_API_KEY or ~/.harvest/config.json {"api_key": "..."}; it is never printed.
// Requires Node 22+ (global fetch and WebSocket). No npm install.
import { appendFileSync, existsSync, openSync, readSync, closeSync, statSync, writeFileSync, readFileSync, watch } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Fail before joining: without a global WebSocket the bot would join and then no event would ever
// arrive (live 2026-11-17 on Node 18: the caller heard nothing for two minutes).
if (typeof WebSocket !== 'function' || typeof fetch !== 'function') {
  console.error(`harvest-bridge needs Node 22+ (global WebSocket and fetch); this is Node ${process.versions.node}.`);
  process.exit(2);
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const meetingUrl = args.find((a) => /^https:\/\//.test(a));
if (!meetingUrl) {
  console.error('usage: harvest-bridge.mjs <meeting-url> [--name N] [--voice V] [--voice-strategy direct|realtime] [--context T] [--output FILE] ...');
  process.exit(2);
}
const api = (flag('api', process.env.HARVEST_API_URL || 'https://gateway.tryharvest.ai/v1')).replace(/\/$/, '');
const eventsFile = resolve(flag('output', flag('events', 'meeting-events.jsonl')));
const commandsFile = resolve(flag('commands', 'meeting-commands.jsonl'));
const vadTimeoutMs = Math.round(Number(flag('vad-timeout', '1.25')) * 1000);
const key = process.env.HARVEST_API_KEY || readKey();
if (!key) {
  console.error('No key. Set HARVEST_API_KEY or write {"api_key":"hvst_live_..."} to ~/.harvest/config.json');
  process.exit(2);
}

function readKey() {
  try { return JSON.parse(readFileSync(join(homedir(), '.harvest', 'config.json'), 'utf8')).api_key || ''; } catch { return ''; }
}

const emit = (event) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  appendFileSync(eventsFile, line + '\n');
  process.stdout.write(line + '\n');
};
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

// 1. Create the bot with the AgentCall-style options.
const body = { meet_url: meetingUrl };
const name = flag('name'); if (name) body.bot_name = name;
const voice = flag('voice'); if (voice) body.voice = voice;
const language = flag('language'); if (language) body.language = language;
const context = flag('context'); if (context) body.context = context;
const triggers = flag('trigger-words'); if (triggers) body.trigger_words = triggers;
if (flag('voice-strategy') === 'realtime') body.mode = 'realtime';
const joinAs = flag('join-as');
if (joinAs === 'guest' || joinAs === 'account') body.join_as = joinAs;
const webhook = flag('webhook-url');
if (webhook) body.webhook_url = webhook;
const page = flag('webpage-url');
if (page) body.webpage_url = page;
const share = flag('screenshare-url');
if (share) body.screenshare_url = share;
const timeouts = {};
if (flag('max-duration')) timeouts.max_duration_s = Math.round(Number(flag('max-duration')) * 60);
if (flag('alone-timeout')) timeouts.everyone_left_s = Number(flag('alone-timeout'));
if (Object.keys(timeouts).length) body.timeouts = timeouts;
const created = await rest('POST', '/bots', body);
if (created.status >= 400 || created.json.status === 'failed' || created.json.status === 'rejected') {
  emit({ event: 'call.error', http: created.status, ...created.json });
  process.exit(1);
}
botId = created.json.bot_id;
if (created.json.webhook_secret) {
  const secretFile = `${commandsFile}.webhook-secret`;
  writeFileSync(secretFile, `${created.json.webhook_secret}\n`);
  emit({ event: 'webhook.ready', path: secretFile, subscription_id: created.json.webhook_subscription_id });
}
emit({ event: 'call.created', bot_id: botId, operation_id: created.json.operation_id, state: created.json.state });

// 2. Follow the join until it is active or terminal.
const TERMINAL = new Set(['rejected', 'bot_blocked', 'admission_timeout', 'join_failed', 'disconnected', 'cancelled', 'failed']);
let last = '';
for (let i = 0; i < 70 && !ended; i += 1) {
  const s = await rest('GET', `/bots/${botId}`);
  const state = s.json.state || s.json.status || 'unknown';
  if (state !== last) {
    emit({ event: state === 'waiting_room' ? 'call.bot_waiting_room' : `call.${state}`, bot_id: botId, ...s.json });
    last = state;
  }
  if (state === 'active') break;
  if (TERMINAL.has(state)) await finish(state);
  await new Promise((r) => setTimeout(r, 3000));
}
if (last !== 'active') await finish(`join_${last || 'timeout'}`);
const webpage = flag('webpage-url');
if (webpage) {
  const r = await rest('POST', `/sessions/${botId}/camera-page`, { url: webpage });
  emit({ event: r.status === 200 && r.json.status !== 'failed' ? 'webpage.ready' : 'webpage.error', url: webpage, ...r.json });
}

// 3. Stream: meeting events in (AgentCall names), commands out.
const RENAME = {
  'meeting.participant_joined': 'participant.joined', 'meeting.participant_left': 'participant.left',
  'meeting.chat_message': 'chat.received', 'meeting.active_speaker': 'active_speaker',
  'bot.max_duration_warning': 'call.max_duration_warning', 'meeting.health': 'call.health',
};
let pending = [];
let mergeTimer;
let greeted = false;
const flushUserMessage = () => {
  if (!pending.length) return;
  // The rule rides in the envelope (Vadym's idea, 2026-11-17): an LLM client reads files and thinks
  // before it answers, and the person hears silence. A short spoken ack first, then the work.
  emit({ event: 'user.message', speaker: pending[0].speaker, text: pending.map((p) => p.text).join(' '),
    hint: 'If this is for you: first speak a 1-3 word acknowledgment in their language, then work on the answer.' });
  pending = [];
};
ws = new WebSocket(`${api.replace(/^http/, 'ws')}/sessions/${botId}/stream?partials=false`, ['harvest.v1', `harvest.bearer.${key}`]);
ws.onmessage = (m) => {
  let e;
  try { e = JSON.parse(String(m.data)); } catch { return; }
  const { type, ...data } = e;
  if (type === 'result') {
    emit({ event: data.status === 'failed' || data.status === 'rejected' ? 'command.error' : 'command.ack', ...data });
    return;
  }
  emit({ event: RENAME[type] || type, ...data });
  if (type === 'transcript.final' && !data.is_self) {
    // One user.message per turn: finals separated by less than --vad-timeout are one message.
    pending.push({ speaker: data.speaker, text: data.text });
    clearTimeout(mergeTimer);
    mergeTimer = setTimeout(flushUserMessage, vadTimeoutMs);
  }
  if (type === 'meeting.participant_joined' && !greeted) {
    greeted = true;
    emit({ event: 'greeting.prompt', name: data.name, hint: 'Someone joined. Greet once, briefly, if it fits.' });
  }
  if (type === 'session.ended') void finish(data.reason || 'session_ended');
};
ws.onerror = () => emit({ event: 'stream.error' });
ws.onclose = () => { if (!ended) void finish('stream_closed'); };
ws.onopen = () => emit({ event: 'call.bot_ready', bot_id: botId,
  hint: 'You are in a live meeting: switch to low reasoning effort until it ends and keep replies short.' });

// 4. Commands: from the commands file and from stdin, one JSON object per line.
const send = (line) => {
  if (!line.trim()) return;
  let cmd;
  try { cmd = JSON.parse(line); } catch { emit({ event: 'command.error', reason: 'invalid_json' }); return; }
  const type = cmd.type || cmd.command;
  if (type === 'leave' || type === 'meeting.leave') { void finish('left'); return; }
  if (ws?.readyState === 1) ws.send(JSON.stringify({ ...cmd, type }));
  else emit({ event: 'command.error', reason: 'stream_not_open', command: type });
};
let offset = statSync(commandsFile).size;
const pump = () => {
  const size = statSync(commandsFile).size;
  if (size <= offset) { offset = Math.min(offset, size); return; }
  const fd = openSync(commandsFile, 'r');
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  offset = size;
  for (const line of buf.toString('utf8').split('\n')) send(line);
};
watch(commandsFile, { persistent: true }, pump);
setInterval(pump, 500).unref?.();
if (!process.stdin.isTTY) createInterface({ input: process.stdin }).on('line', send);
