#!/usr/bin/env node
/**
 * SessionStart hook for zcode-trae-connect.
 *
 * The ZCode plugin runtime invokes this hook when a session starts. It makes
 * sure the local trae2api gateway endpoints are up (TRAE_SOLO_PORT / TRAE_CN_PORT,
 * defaults :19960 / :19961) and, when configured, probes the remote laptop
 * gateway.
 *
 * The hook is read-only apart from *starting* the gateway when it is down and
 * TRAE_AUTO_START is not '0'. It never reads or prints credentials.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.ZCODE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const START_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'start-instances.ps1');
const AUTO_START = (process.env.TRAE_AUTO_START || '1').trim() !== '0';

const INSTANCES = [
  { name: 'TRAE-SOLO-CN', port: Number(process.env.TRAE_SOLO_PORT || 19960) },
  { name: 'TRAE-CN', port: Number(process.env.TRAE_CN_PORT || 19961) },
];

function tcpProbe(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

async function main() {
  console.log('[trae-connect] SessionStart hook: ensuring gateway endpoints');

  for (const inst of INSTANCES) {
    if (await tcpProbe(inst.port)) {
      console.log(`[trae-connect] ${inst.name} already listening on :${inst.port}`);
      continue;
    }
    if (!AUTO_START) {
      console.log(`[trae-connect] ${inst.name} down on :${inst.port} (TRAE_AUTO_START=0 → left alone)`);
      continue;
    }
    if (!fs.existsSync(START_SCRIPT)) {
      console.log(`[trae-connect] ${inst.name} down on :${inst.port} and ${path.basename(START_SCRIPT)} is missing — start the gateway manually`);
      continue;
    }
    console.log(`[trae-connect] ${inst.name} down on :${inst.port} — launching ${path.basename(START_SCRIPT)} (detached)`);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', START_SCRIPT],
      { windowsHide: true },
      () => {},
    );
    await new Promise((r) => setTimeout(r, 6000));
    console.log(`[trae-connect] ${inst.name} now listening: ${await tcpProbe(inst.port)}`);
  }

  const remote = (process.env.TRAE_REMOTE_BASE_URL || '').trim();
  if (remote) {
    try {
      const res = await fetch(remote.replace(/\/+$/, '') + '/v1/models', { signal: AbortSignal.timeout(4000) });
      console.log(`[trae-connect] remote gateway ${remote} → HTTP ${res.status}`);
    } catch (e) {
      console.log(`[trae-connect] remote gateway ${remote} → unreachable (${(e && e.message) || e})`);
    }
  } else {
    console.log('[trae-connect] remote probe skipped (set TRAE_REMOTE_BASE_URL to enable)');
  }

  console.log('[trae-connect] hook complete');
}

main().catch((e) => {
  console.error('[trae-connect] hook failed: ' + ((e && e.message) || e));
  process.exit(1);
});