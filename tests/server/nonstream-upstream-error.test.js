// Non-stream endpoints (/v1/chat/completions, /v1/messages) must surface upstream
// error frames (e.g. 4017 device risk-control) instead of returning a silent HTTP
// 200 with empty content — the streaming formatters already render
// `[Error <code>: <message>]` text; non-stream aggregation must mirror that.
// Hermetic e2e: fake product data dir (plaintext storage.json auth) + local mock
// upstream replaying the exact 4017 SSE observed in real traffic logs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import http from 'http';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');

const ERROR_4017_SSE = [
  'event: error',
  'data: null',
  '',
  'event: error',
  'data: ' + JSON.stringify({
    type: 'error',
    code: 4017,
    message: "We're sorry, your requests hit the common risk control status.",
    extra: '{"type":"max_account"}',
  }),
  '',
  'event: done',
  'data: {"type":"done","finish_reason":"stop"}',
  '',
  '',
].join('\n');

let mockUpstream, mockPort, tmpRoot;
const savedEnv = {};

beforeAll(async () => {
  mockUpstream = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.includes('/api/agent/v3/llm_utils_chat')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(ERROR_4017_SSE);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
  mockPort = mockUpstream.address().port;

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nonstream-err-'));
  const storageDir = path.join(tmpRoot, 'User', 'globalStorage');
  fs.mkdirSync(storageDir, { recursive: true });
  const authData = {
    token: 'tk-test',
    refreshToken: null,
    expiredAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    refreshExpiredAt: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
    tokenReleaseAt: null,
    userId: '1654835512345678',
    host: null,
    userRegion: { region: 'CN' },
    account: { username: 'nonstream-test' },
  };
  fs.writeFileSync(
    path.join(storageDir, 'storage.json'),
    JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': JSON.stringify(authData) })
  );

  for (const key of ['APPDATA', 'PORT', 'API_KEY', 'TRAE_DATA_DIR', 'TRAE_API_HOST', 'TRAE_POOL', 'SESSIONS_DB_PATH']) {
    savedEnv[key] = process.env[key];
  }
  // APPDATA -> temp root so the pool dir can never resolve to the real pool.
  process.env.APPDATA = tmpRoot;
  process.env.PORT = String(21000 + Math.floor(Math.random() * 8000));
  process.env.API_KEY = 'test-key-123';
  process.env.TRAE_DATA_DIR = tmpRoot;
  process.env.TRAE_API_HOST = `http://127.0.0.1:${mockPort}`;
  process.env.TRAE_POOL = 'off';
  process.env.SESSIONS_DB_PATH = path.join(tmpRoot, 'sessions.db');
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete process.env[key];
  }

  require('../../src/server.js');

  // app.listen fires asynchronously at require time — poll until the port answers.
  const base = `http://127.0.0.1:${process.env.PORT}`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/v1`, { headers: { Authorization: 'Bearer test-key-123' } });
      return;
    } catch (e) { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('gateway did not start listening');
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  mockUpstream?.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('non-stream upstream error passthrough (4017 risk control)', () => {
  it('POST /v1/chat/completions renders [Error 4017: ...] as content instead of an empty 200', async () => {
    const res = await fetch(`http://127.0.0.1:${process.env.PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key-123', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const content = body.choices?.[0]?.message?.content ?? '';
    expect(content).toContain('[Error 4017:');
    expect(content).toContain('risk control status');
    expect(body.choices[0].finish_reason).toBe('stop');
  });

  it('POST /v1/messages renders [Error 4017: ...] as a text block instead of an empty 200', async () => {
    const res = await fetch(`http://127.0.0.1:${process.env.PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-key-123', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const text = (body.content || []).map((b) => b.text || '').join('');
    expect(text).toContain('[Error 4017:');
    expect(text).toContain('risk control status');
  });
});
