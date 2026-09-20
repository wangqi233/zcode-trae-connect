#!/usr/bin/env node
/**
 * zcode-trae-connect CLI
 *
 *   node bin/cli.mjs status                Show gateway endpoints & model counts
 *   node bin/cli.mjs doctor                Check prerequisites & local health
 *   node bin/cli.mjs serve [--dir PATH]    Run the trae2api gateway (see .env)
 *   node bin/cli.mjs setup                 Install deps and print next steps
 *   node bin/cli.mjs remote                Explain the laptop handshake flow
 *   node bin/cli.mjs remote check FILE.json  Validate a handshake report
 *   node bin/cli.mjs help
 *
 * Ports come from TRAE_SOLO_PORT / TRAE_CN_PORT (defaults 19960 / 19961).
 * Credentials are only ever read from files or environment — this CLI prints
 * existence and reachability, never secret material.
 */

import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOLO_PORT = Number(process.env.TRAE_SOLO_PORT || 19960);
const CN_PORT = Number(process.env.TRAE_CN_PORT || 19961);

const HELP = `zcode-trae-connect

Usage:
  node bin/cli.mjs status                Show gateway endpoints & model counts
  node bin/cli.mjs doctor                Check prerequisites & local health
  node bin/cli.mjs serve [--dir PATH]    Run the trae2api gateway (see .env)
  node bin/cli.mjs setup                 Install deps and print next steps
  node bin/cli.mjs remote                Explain the laptop handshake flow
  node bin/cli.mjs remote check FILE.json  Validate a handshake report
  node bin/cli.mjs help

Environment:
  TRAE_SOLO_PORT / TRAE_CN_PORT  gateway ports (defaults 19960 / 19961)
  TRAE_AUTO_START                '0' to keep hooks read-only
  TRAE_REMOTE_BASE_URL           optional remote laptop gateway probe
  ZCODE_DESKTOP_ROOT             ZCode user-data root for provider config
`;

function tcpProbe(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

function httpGetJson(port, apiPath, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: apiPath, method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch (e) {}
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, body: null }));
    req.end();
  });
}

async function cmdStatus() {
  for (const [name, port] of [['TRAE-SOLO-CN', SOLO_PORT], ['TRAE-CN', CN_PORT]]) {
    process.stdout.write(`=== ${name} :${port} ===\n`);
    if (!(await tcpProbe(port))) {
      process.stdout.write('  not listening\n\n');
      continue;
    }
    const models = await httpGetJson(port, '/v1/models');
    const pool = await httpGetJson(port, '/v1/pool');
    const list = models.body && Array.isArray(models.body)
      ? models.body.map((m) => (typeof m === 'string' ? m : m.id || m.modelId)).filter(Boolean)
      : (models.body && Array.isArray(models.body.data) ? models.body.data.map((m) => m.id).filter(Boolean) : []);
    process.stdout.write(`  /v1/models HTTP ${models.status} → ${list.length} models\n`);
    if (pool.body) {
      if (pool.body.members && Array.isArray(pool.body.members)) {
        const served = pool.body.members.filter((m) => m.served).length;
        process.stdout.write(`  pool: ${pool.body.members.length} member(s), ${served} served\n`);
      } else {
        process.stdout.write('  pool: enabled (no member detail)\n');
      }
    } else {
      process.stdout.write('  pool: single-account mode\n');
    }
    process.stdout.write('\n');
  }
}

async function cmdDoctor() {
  process.stdout.write('node        : ' + process.version + '\n');
  process.stdout.write('deps        : ' + (fs.existsSync(path.join(ROOT, 'node_modules')) ? 'installed' : 'MISSING — run `node bin/cli.mjs setup`') + '\n');
  process.stdout.write('gateway src : ' + (fs.existsSync(path.join(ROOT, 'src', 'server.js')) ? 'ok' : 'MISSING') + '\n');
  process.stdout.write('root .env   : ' + (fs.existsSync(path.join(ROOT, '.env')) ? 'present (good — contents not printed)' : 'absent (copy from .env.example)') + '\n');
  process.stdout.write('start script: ' + (fs.existsSync(path.join(ROOT, 'scripts', 'start-instances.ps1')) ? 'ok' : 'missing') + '\n');
  const providerRoot = process.env.ZCODE_DESKTOP_ROOT || path.join(process.env.USERPROFILE || process.env.HOME || '', '.zcode', 'v2');
  process.stdout.write('ZCode cfg   : ' + (fs.existsSync(path.join(providerRoot, 'provider_config.json')) ? 'found (ZCODE_DESKTOP_ROOT=' + providerRoot + ')' : `not at ${providerRoot} — set ZCODE_DESKTOP_ROOT if ZCode relocated its data root`) + '\n');
  process.stdout.write('self-renew  : ' + ((process.env.TRAE_POOL_SELF_RENEW || '').trim() ? 'TRAE_POOL_SELF_RENEW=' + process.env.TRAE_POOL_SELF_RENEW : 'unset (default) — keep it off for client-managed accounts') + '\n');
  process.stdout.write('\nports:\n');
  for (const [name, port] of [['TRAE-SOLO-CN', SOLO_PORT], ['TRAE-CN', CN_PORT]]) {
    process.stdout.write(`  :${port} ${name} → ` + (await tcpProbe(port) ? 'listening' : 'down') + '\n');
  }
}

function cmdServe(dir) {
  const server = path.join(dir, 'src', 'server.js');
  if (!fs.existsSync(server)) {
    console.error('server.js not found under ' + dir);
    process.exit(1);
  }
  console.log('starting gateway: ' + server);
  const child = spawn(process.execPath, [server], { cwd: dir, stdio: 'inherit' });
  child.on('exit', (code) => { console.log('gateway exited with code ' + code); process.exit(code || 0); });
  process.on('SIGINT', () => child.kill('SIGINT'));
}

function cmdSetup() {
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    process.stdout.write('installing dependencies (npm ci)…\n');
    const r = spawnSync('npm', ['ci'], { cwd: ROOT, stdio: 'inherit', shell: true });
    if (r.status !== 0) process.exit(r.status || 1);
  } else {
    process.stdout.write('dependencies already installed\n');
  }
  process.stdout.write(`
Next steps:
  1. copy .env.example to .env and fill in the gateway settings
     (TRAE_EDITION, TRAE_DATA_DIR pointing at a sandbox COPY of the Trae data
     dir, TRAE_POOL_SELF_RENEW=off).
  2. start the gateway:      node bin/cli.mjs serve
  3. check it:               node bin/cli.mjs status
  4. write ZCode providers:  node scripts/write-zcode-providers.js
  5. install the plugin into ZCode so the SessionStart hook keeps it alive.
Details: docs/install.md\n`);
}

function handshakeSchema() {
  return {
    required: ['schema_version', 'probe_date', 'edition', 'gateways', 'firewall_allows', 'issues', 'notes'],
    gateway: { port: 'number', listening: 'boolean' },
  };
}

function cmdRemoteCheck(file) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.error('cannot read report: ' + e.message);
    process.exit(1);
  }
  const schema = handshakeSchema();
  const missing = schema.required.filter((k) => !(k in report));
  if (missing.length) {
    console.error('report invalid — missing keys: ' + missing.join(', '));
    process.exit(1);
  }
  const badGateways = (report.gateways || []).filter(
    (g) => typeof g.port !== 'number' || typeof g.listening !== 'boolean',
  );
  if (badGateways.length) {
    console.error('report invalid — bad gateways entries: ' + JSON.stringify(badGateways));
    process.exit(1);
  }
  if (report.issues && report.issues.length) {
    console.log('report OK, but upstream operator lists issues:');
    for (const i of report.issues) console.log('  - ' + i);
  } else {
    console.log('report OK — all checks green.');
  }
}

function cmdRemote() {
  process.stdout.write(`Laptop handshake flow
=======================
Read the full checklist + report schema at:
  scripts/remote-handshake.md

Summary:
  1. On the laptop: run the checklist steps (read-only probing, THEN start the
     gateway bound to the LAN, open the firewall for the gateway port only).
  2. Credentials never leave the laptop — the gateway runs there; the desktop
     only reaches it over the network.
  3. Return a report JSON matching the schema in that document.
  4. Validate here:   node bin/cli.mjs remote check report.json
`);
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case 'status': await cmdStatus(); break;
  case 'doctor': await cmdDoctor(); break;
  case 'serve': {
    const dirIndex = process.argv.indexOf('--dir');
    cmdServe(dirIndex >= 0 ? process.argv[dirIndex + 1] : ROOT);
    break;
  }
  case 'setup': cmdSetup(); break;
  case 'remote':
    if (arg === 'check') cmdRemoteCheck(process.argv[4]);
    else if (arg === undefined) cmdRemote();
    else { console.error('unknown remote subcommand: ' + arg); process.exit(1); }
    break;
  case 'help':
  case undefined: process.stdout.write(HELP); break;
  default:
    console.error('unknown command: ' + cmd + '\n');
    process.stdout.write(HELP);
    process.exit(1);
}