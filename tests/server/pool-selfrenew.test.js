// Self-renewal wire-in tests (_poolPrepareMember / poolGetAuthInfo).
// Hermetic: APPDATA is pointed at a temp dir so POOL_DIR resolves to a temp pool,
// and member `host` fields point at a local mock ExchangeToken endpoint — no real
// network, no real client data dirs are touched.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import http from 'http';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY = 24 * 3600 * 1000;

let auth; // module under test, imported after env setup
let tmpRoot, poolDir, realAppData;
let mockServer, mockPort;
let mockMode = 'ok'; // 'ok' | 'fail'
let mockHits = 0;

function writeMember(m) {
  fs.writeFileSync(path.join(poolDir, `account-${m.userId}.json`), JSON.stringify(m, null, 2), 'utf-8');
}
function readMember(userId) {
  return JSON.parse(fs.readFileSync(path.join(poolDir, `account-${userId}.json`), 'utf-8'));
}
function resetPool(members) {
  for (const f of fs.readdirSync(poolDir)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(poolDir, f));
  }
  for (const m of members) writeMember(m);
}
function member(overrides = {}) {
  return {
    userId: '1111111111111111',
    account: { username: 'pool-test-user' },
    token: 'tk-old',
    refreshToken: 'rt-old',
    expiredAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // inside 30-min window
    refreshExpiredAt: new Date(Date.now() + 90 * DAY).toISOString(),
    host: `http://127.0.0.1:${mockPort}`,
    userRegion: { region: 'CN' },
    exhaustedUntil: null,
    dead: false,
    lastError: null,
    addedAt: Date.now(),
    lastUsedAt: null,
    _edition: 'cn',
    ...overrides,
  };
}

beforeAll(async () => {
  // Mock ExchangeToken endpoint. exchangeToken hits `${host}/cloudide/api/v3/trae/oauth/ExchangeToken`.
  mockServer = http.createServer((req, res) => {
    mockHits++;
    if (mockMode === 'fail') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 10101, message: 'refresh token is not matched to the client' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      Result: {
        Token: 'tk-new',
        RefreshToken: 'rt-new',
        TokenExpireAt: String(Date.now() + 7 * DAY),
        RefreshExpireAt: String(Date.now() + 180 * DAY),
      },
    }));
  });
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockPort = mockServer.address().port;

  // Hermetic module setup: POOL_DIR derives from APPDATA at module load.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-selfrenew-'));
  poolDir = path.join(tmpRoot, 'traework-pool');
  fs.mkdirSync(poolDir, { recursive: true });
  realAppData = process.env.APPDATA;
  process.env.APPDATA = tmpRoot;
  // never let a developer shell proxy env redirect the mock call
  for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
  // auth.js is CJS: require() it fresh — APPDATA (→ POOL_DIR) is already set above.
  auth = require('../../src/auth.js');
});

afterAll(async () => {
  process.env.APPDATA = realAppData;
  await new Promise((resolve) => mockServer.close(resolve));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('pool self-renewal wire-in (_poolPrepareMember, exercised via refreshTokenIfNeeded)', () => {
  it('refreshes a near-expiry token through ExchangeToken and persists the renewal', async () => {
    mockMode = 'ok';
    mockHits = 0;
    resetPool([member({ userId: 'A0000000000000001' })]);
    const info = await auth.refreshTokenIfNeeded();
    expect(mockHits).toBe(1);
    expect(info.token).toBe('tk-new');
    const disk = readMember('A0000000000000001');
    expect(disk.token).toBe('tk-new');
    expect(disk.refreshToken).toBe('rt-new');
    expect(new Date(disk.expiredAt).getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(disk.dead).toBeFalsy();
    expect(disk.refreshRetryAfter ?? null).toBeNull();
  });

  it('does not call ExchangeToken when the token is far from expiry', async () => {
    mockMode = 'ok';
    mockHits = 0;
    resetPool([member({ userId: 'B0000000000000002', token: 'tk-far', expiredAt: new Date(Date.now() + 20 * DAY).toISOString() })]);
    const info = await auth.refreshTokenIfNeeded();
    expect(mockHits).toBe(0);
    expect(info.token).toBe('tk-far');
    expect(readMember('B0000000000000002').token).toBe('tk-far');
  });

  it('degrades gracefully when renewal fails but the token is still valid', async () => {
    mockMode = 'fail';
    mockHits = 0;
    resetPool([member({ userId: 'C0000000000000003', token: 'tk-c' })]);
    const info = await auth.refreshTokenIfNeeded();
    expect(info.token).toBe('tk-c'); // serving continues on the current token
    const disk = readMember('C0000000000000003');
    expect(disk.dead).toBeFalsy();
    expect(disk.lastError).toMatch(/refresh failed/);
    expect(disk.refreshRetryAfter).toBeGreaterThan(Date.now());
    const hitsAfterFirst = mockHits;
    await auth.refreshTokenIfNeeded(); // within backoff window: no second renewal attempt
    expect(mockHits).toBe(hitsAfterFirst);
    mockMode = 'ok';
  });

  it('marks the member dead when the token is unusable and renewal fails, then serves the next member', async () => {
    mockMode = 'fail';
    mockHits = 0;
    // No expiredAt → needsRefresh fires immediately; renewal fails → dead + rotate to next.
    resetPool([
      member({ userId: 'D0000000000000004', token: 'tk-d', expiredAt: null, addedAt: 1 }),
      member({ userId: 'E0000000000000005', token: 'tk-e', expiredAt: new Date(Date.now() + 20 * DAY).toISOString(), addedAt: 2 }),
    ]);
    const info = await auth.refreshTokenIfNeeded();
    expect(info.token).toBe('tk-e');
    const d = readMember('D0000000000000004');
    expect(d.dead).toBe(true);
    expect(d.lastError).toMatch(/refresh failed/);
    mockMode = 'ok';
  });

  it('serves a member without refreshToken as-is (legacy shape, no renewal attempted)', async () => {
    mockMode = 'ok';
    mockHits = 0;
    resetPool([member({ userId: 'F0000000000000006', token: 'tk-f', refreshToken: undefined })]);
    const info = await auth.refreshTokenIfNeeded();
    expect(mockHits).toBe(0);
    expect(info.token).toBe('tk-f');
  });
});

describe('TRAE_POOL_SELF_RENEW=off (self-renewal disabled)', () => {
  function requireFreshAuth() {
    // auth.js reads env at module load — bust the CJS cache to re-evaluate the switch.
    delete require.cache[require.resolve('../../src/auth.js')];
    return require('../../src/auth.js');
  }

  afterAll(() => {
    delete process.env.TRAE_POOL_SELF_RENEW;
    requireFreshAuth(); // restore default-on instance for any later consumer
  });

  it('serves a near-expiry token as-is without calling ExchangeToken', async () => {
    process.env.TRAE_POOL_SELF_RENEW = 'off';
    const authOff = requireFreshAuth();
    mockMode = 'ok';
    mockHits = 0;
    resetPool([member({ userId: 'A0000000000000001' })]); // inside 30-min renewal window
    const info = await authOff.refreshTokenIfNeeded();
    expect(mockHits).toBe(0);
    expect(info.token).toBe('tk-old');
    const disk = readMember('A0000000000000001');
    expect(disk.token).toBe('tk-old');
    expect(disk.dead).toBeFalsy();
  });

  it('drops an already-expired token from rotation without calling ExchangeToken', async () => {
    process.env.TRAE_POOL_SELF_RENEW = 'off';
    const authOff = requireFreshAuth();
    mockMode = 'ok';
    mockHits = 0;
    resetPool([member({ userId: 'B0000000000000002', token: 'tk-exp', expiredAt: new Date(Date.now() - 60 * 1000).toISOString() })]);
    await expect(authOff.refreshTokenIfNeeded()).rejects.toThrow(); // no healthy member remains
    expect(mockHits).toBe(0);
    const disk = readMember('B0000000000000002');
    // filtered out by the health gate before any renewal logic runs — token untouched;
    // revival is client re-login (hot-import), never a gateway-side ExchangeToken
    expect(disk.token).toBe('tk-exp');
    expect(disk.dead).toBeFalsy();
  });
});
