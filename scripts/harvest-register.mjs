#!/usr/bin/env node
// Get a Harvest key without leaving the agent: email code sign-up / sign-in.
//
//   node harvest-register.mjs send   --email you@example.com
//   node harvest-register.mjs verify --email you@example.com --code 123456
//
// verify saves {"api_key": "hvst_live_..."} to ~/.harvest/config.json (mode 600) and prints only
// a short confirmation, never the key. Requires Node 18+.
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [step, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const base = (process.env.HARVEST_APP_URL || 'https://tryharvest.ai').replace(/\/$/, '');
const email = flag('email');
if (!['send', 'verify'].includes(step) || !email || (step === 'verify' && !flag('code'))) {
  console.error('usage: harvest-register.mjs send --email E | verify --email E --code 123456');
  process.exit(2);
}

const res = await fetch(`${base}/api/register/${step}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(step === 'send' ? { email } : { email, code: flag('code') }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Harvest ${step} failed: HTTP ${res.status} ${body.error ?? ''}`);
  process.exitCode = 1;
} else if (step === 'send') {
  console.log(`Code sent to ${email}. Ask the user for the 6-digit code, then run verify.`);
} else {
  saveKey(body.credential?.token);
}

function saveKey(token) {
  if (!token) { console.error('Harvest verify returned no key.'); process.exitCode = 1; return; }
  const dir = join(homedir(), '.harvest');
  const file = join(dir, 'config.json');
  mkdirSync(dir, { recursive: true });
  let config = {};
  try { config = JSON.parse(readFileSync(file, 'utf8')); } catch { /* new file */ }
  writeFileSync(file, JSON.stringify({ ...config, api_key: token }, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
  console.log(`Harvest key saved to ${file} (${token.slice(0, 14)}…). You can join a meeting now.`);
}
