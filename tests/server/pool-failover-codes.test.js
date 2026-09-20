// poolFailover account-level error code taxonomy tests (4008 / 1001 / 4010).
// Hermetic: APPDATA is pointed at a temp dir so POOL_DIR resolves to a temp pool.
// No network, no real client data dirs are touched.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOUR = 3600 * 1000;

let auth; // module under test, imported after env setup
let tmpRoot, poolDir, realAppData;

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
    account: { username: 'pool-failover-test-user' },
    token: 'tk-old',
    refreshToken: 'rt-old',
    expiredAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    refreshExpiredAt: new Date(Date.now() + 90 * 24 * HOUR).toISOString(),
    host: null,
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

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-failover-'));
  poolDir = path.join(tmpRoot, 'traework-pool');
  fs.mkdirSync(poolDir, { recursive: true });
  realAppData = process.env.APPDATA;
  process.env.APPDATA = tmpRoot;
  delete process.env.TRAE_POOL_RATELIMIT_COOLDOWN_MINUTES; // exercise the default
  delete process.env.TRAE_POOL_COOLDOWN_HOURS;
  // auth.js is CJS: require() it fresh — APPDATA (→ POOL_DIR) is already set above.
  auth = require('../../src/auth.js');
});

afterAll(() => {
  process.env.APPDATA = realAppData;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('isAccountFailoverCode', () => {
  it('recognizes the account-level codes 4008 / 1001 / 4010 (number and numeric string)', () => {
    for (const code of [4008, 1001, 4010, '4008', '1001', '4010']) {
      expect(auth.isAccountFailoverCode(code)).toBe(true);
    }
  });
  it('rejects model/param-level and unknown codes', () => {
    for (const code of [2001, 4001, 4027, 9999, '4027', NaN, undefined, null]) {
      expect(auth.isAccountFailoverCode(code)).toBe(false);
    }
  });
});

describe('poolFailover code → member marking', () => {
  it('4010 (risk-control access denied) → short rate-limit cooldown (~2h) + rotation, member stays revivable', () => {
    resetPool([
      member({ userId: 'P0000000000000001', addedAt: 1 }),
      member({ userId: 'P0000000000000002', addedAt: 2 }),
    ]);
    const switched = auth.poolFailover(4010, "We're sorry, access denied. Please wait and try again later.");
    expect(switched).toBe(true);
    const p1 = readMember('P0000000000000001');
    expect(p1.exhaustedUntil).toBeGreaterThan(Date.now() + 1 * HOUR);
    expect(p1.exhaustedUntil).toBeLessThan(Date.now() + 3 * HOUR);
    expect(Math.abs(p1.exhaustedUntil - (Date.now() + 2 * HOUR))).toBeLessThan(60 * 1000);
    expect(p1.dead).toBeFalsy();
    expect(p1.lastError).toMatch(/access denied/i);
    const p2 = readMember('P0000000000000002');
    expect(p2.exhaustedUntil ?? null).toBeNull();
    expect(p2.dead).toBeFalsy();
  });

  it('4008 (quota exhausted) → 24h exhausted cooldown + rotation (regression guard)', () => {
    resetPool([
      member({ userId: 'Q0000000000000001', addedAt: 1 }),
      member({ userId: 'Q0000000000000002', addedAt: 2 }),
    ]);
    const switched = auth.poolFailover(4008, 'Your requests have exceeded the quota.');
    expect(switched).toBe(true);
    const q1 = readMember('Q0000000000000001');
    expect(Math.abs(q1.exhaustedUntil - (Date.now() + 24 * HOUR))).toBeLessThan(60 * 1000);
    expect(q1.dead).toBeFalsy();
  });

  it('1001 (auth invalid) → dead until re-login + rotation (regression guard)', () => {
    resetPool([
      member({ userId: 'R0000000000000001', addedAt: 1 }),
      member({ userId: 'R0000000000000002', addedAt: 2 }),
    ]);
    const switched = auth.poolFailover(1001, 'auth failed');
    expect(switched).toBe(true);
    expect(readMember('R0000000000000001').dead).toBe(true);
  });

  it('model/param-level codes (e.g. 4027) do not rotate or mark anyone', () => {
    resetPool([
      member({ userId: 'S0000000000000001', addedAt: 1 }),
      member({ userId: 'S0000000000000002', addedAt: 2 }),
    ]);
    expect(auth.poolFailover(4027, 'invalid_parameter_error')).toBe(false);
    for (const userId of ['S0000000000000001', 'S0000000000000002']) {
      const m = readMember(userId);
      expect(m.exhaustedUntil ?? null).toBeNull();
      expect(m.dead).toBeFalsy();
    }
  });
});
