const fs = require('fs');
const path = require('path');
const os = require('os');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('./uuid');
const { decryptAuthData: decryptTcAuthData, isTcEncrypted } = require('./trae-decrypt');
const {
  getRealmConfig,
  realmFromCredential,
  chatHostFor,
  authHostFor,
  inferRealmForModel,
} = require('./realms');

// Resolve the per-user config root (APPDATA may be redirected on Windows).
function getRoamingRoot() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

// Candidate product folders per realm, sourced from the central realm table.
// First existing storage.json wins for that realm.
const CN_PRODUCT_DIRS = getRealmConfig('cn').productDirs;
const SG_PRODUCT_DIRS = getRealmConfig('sg').productDirs;

function resolveProductDataDir(edition) {
  if (process.env.TRAE_DATA_DIR) return process.env.TRAE_DATA_DIR;
  const root = getRoamingRoot();
  const names = edition === 'cn' ? CN_PRODUCT_DIRS : SG_PRODUCT_DIRS;
  let best = null;
  let bestMtime = -1;
  for (const name of names) {
    const dir = path.join(root, name);
    const storagePath = path.join(dir, 'User', 'globalStorage', 'storage.json');
    if (!fs.existsSync(storagePath)) continue;
    try {
      const mtime = fs.statSync(storagePath).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        best = dir;
      }
    } catch (e) {
      if (!best) best = dir;
    }
  }
  // Fallback to conventional Trae / Trae CN even if missing (error later).
  if (!best) {
    best = path.join(root, edition === 'cn' ? 'Trae CN' : 'Trae');
  }
  return best;
}

function getTraeDataDir() {
  const envDir = process.env.TRAE_DATA_DIR;
  if (envDir) return envDir;
  return resolveProductDataDir(detectEdition());
}

// ---- runtime upstream switch (CN / SG) --------------------------------------
// Lets an operator flip the whole gateway between the CN and international (SG)
// upstreams without editing .env and restarting. Precedence: runtime override >
// TRAE_EDITION env > disk-state detection (see detectEdition below).
// The override is persisted so it survives a restart caused by anything other
// than an explicit switch. TRAE_DATA_DIR remains the hard pin: when it is set the
// caller has already fixed the product dir, so a runtime switch only affects hosts
// and edition-derived headers.
//
// NOTE: the state file must NOT live inside POOL_DIR — _poolLoad() reads every
// *.json in there and would treat it as an account member (caught by the
// upstream-switch assertions). It sits next to the pool dir instead.
const UPSTREAM_STATE_FILE = process.env.TRAE_UPSTREAM_STATE_FILE
  || path.join(getRoamingRoot(), 'traework-pool-upstream.json');
const UPSTREAM_EDITIONS = ['cn', 'sg'];
let _upstreamEdition = null; // null = no override, fall through to env/detect
let _upstreamLoaded = false;

function _upstreamPersist(edition) {
  try {
    fs.mkdirSync(path.dirname(UPSTREAM_STATE_FILE), { recursive: true });
    fs.writeFileSync(UPSTREAM_STATE_FILE, JSON.stringify({ edition, at: new Date().toISOString() }, null, 2));
  } catch (e) {
    console.log(`[upstream] persist failed (${e.message}) — switch is in-memory only`);
  }
}

function _upstreamLoad() {
  if (_upstreamLoaded) return;
  _upstreamLoaded = true;
  try {
    const j = JSON.parse(fs.readFileSync(UPSTREAM_STATE_FILE, 'utf-8'));
    if (UPSTREAM_EDITIONS.includes(j.edition)) {
      _upstreamEdition = j.edition;
      console.log(`[upstream] restored persisted override: ${j.edition} (set ${j.at || '?'})`);
    }
  } catch (e) { /* no state file — normal */ }
}

function getUpstreamEdition() {
  _upstreamLoad();
  return _upstreamEdition;
}

// Switching upstream invalidates the cached credentials: the next request must
// re-resolve edition, hosts and (in pool mode) pick a member of the new edition.
function setUpstreamEdition(edition) {
  const e = String(edition || '').trim().toLowerCase();
  if (!UPSTREAM_EDITIONS.includes(e)) {
    throw new Error(`invalid upstream edition "${edition}" (expected: ${UPSTREAM_EDITIONS.join(' | ')})`);
  }
  _upstreamLoad();
  const prev = _upstreamEdition;
  _upstreamEdition = e;
  _upstreamPersist(e);
  _cachedAuthInfo = null;
  _cachedStorageMtime = null;
  _poolActiveUserId = null;
  return { from: prev, to: e };
}

function clearUpstreamEdition() {
  _upstreamLoad();
  const prev = _upstreamEdition;
  _upstreamEdition = null;
  try { fs.unlinkSync(UPSTREAM_STATE_FILE); } catch (e) {}
  _cachedAuthInfo = null;
  _cachedStorageMtime = null;
  _poolActiveUserId = null;
  return { from: prev, to: null };
}

function detectEdition() {
  const runtime = getUpstreamEdition();
  if (runtime) return runtime;

  const envEdition = process.env.TRAE_EDITION;
  if (envEdition) {
    const e = envEdition.toLowerCase();
    // solo-cn / solo_cn treat as cn crypto + CN API hosts
    if (e === 'solo' || e === 'solo-cn' || e === 'solo_cn' || e === 'cn') return 'cn';
    return e;
  }

  const cnDir = resolveProductDataDir('cn');
  const sgDir = resolveProductDataDir('sg');
  const cnPath = path.join(cnDir, 'User', 'globalStorage', 'storage.json');
  const sgPath = path.join(sgDir, 'User', 'globalStorage', 'storage.json');

  const cnExists = fs.existsSync(cnPath);
  const sgExists = fs.existsSync(sgPath);

  if (cnExists && !sgExists) return 'cn';
  if (!cnExists && sgExists) return 'sg';
  if (cnExists && sgExists) {
    try {
      const cnStat = fs.statSync(cnPath);
      const sgStat = fs.statSync(sgPath);
      return cnStat.mtime > sgStat.mtime ? 'cn' : 'sg';
    } catch (e) {
      return 'sg';
    }
  }
  return 'sg';
}

function getStorageJsonPath(edition) {
  const ed = edition || detectEdition();
  const dataDir = resolveProductDataDir(ed);
  return path.join(dataDir, 'User', 'globalStorage', 'storage.json');
}

function readStorageJson() {
  const storagePath = getStorageJsonPath();
  if (!fs.existsSync(storagePath)) {
    throw new Error(`storage.json not found at: ${storagePath}`);
  }
  const raw = fs.readFileSync(storagePath, 'utf-8');
  return JSON.parse(raw);
}

function isEncryptedAuthData(raw) {
  if (!raw || typeof raw !== 'string') return true;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('"')) return false;
  return true;
}

function readStorageJsonByEdition(edition) {
  const dataDir = resolveProductDataDir(edition);
  const storagePath = path.join(dataDir, 'User', 'globalStorage', 'storage.json');
  if (!fs.existsSync(storagePath)) return null;
  const raw = fs.readFileSync(storagePath, 'utf-8');
  return JSON.parse(raw);
}

let _cachedAuthInfo = null;
let _cachedStorageMtime = null; // storage.json mtime when cache was filled; a disk rewrite (account switch / client token refresh) invalidates the cache

function _currentStorageMtime(edition) {
  try {
    const p = getStorageJsonPath(edition);
    return fs.existsSync(p) ? fs.statSync(p).mtimeMs : null;
  } catch (e) {
    return null;
  }
}

function _storageMtimeChanged() {
  if (!_cachedAuthInfo || _cachedStorageMtime == null) return false;
  const m = _currentStorageMtime(_cachedAuthInfo._edition);
  return m != null && m !== _cachedStorageMtime;
}

function getAuthInfo() {
  if (_cachedAuthInfo && !isTokenExpired(_cachedAuthInfo)) {
    if (!_storageMtimeChanged()) return _cachedAuthInfo;
    // storage.json was rewritten on disk (account switch or client-side refresh):
    // re-read credentials; if the file is mid-write/unreadable, keep the cached token.
    console.log('[auth] storage.json changed on disk, re-reading credentials');
    const stale = _cachedAuthInfo;
    try {
      return getAuthInfoFromDisk();
    } catch (e) {
      console.log(`[auth] re-read failed (${e.message}); continuing with cached token`);
      _cachedAuthInfo = stale;
      return stale;
    }
  }
  return getAuthInfoFromDisk();
}

function getAuthInfoFromDisk() {
  const edition = detectEdition();
  const editions = [edition, edition === 'cn' ? 'sg' : 'cn'];

  for (const ed of editions) {
    try {
      const dataDir = resolveProductDataDir(ed);

      try {
        const auth = decryptTcAuthData(dataDir);
        console.log(`[auth] Using ${ed.toUpperCase()} edition auth data from ${dataDir} (decrypted)`);
        _cachedAuthInfo = {
          token: auth.token,
          refreshToken: auth.refreshToken,
          expiredAt: auth.expiredAt,
          refreshExpiredAt: auth.refreshExpiredAt,
          tokenReleaseAt: auth.tokenReleaseAt,
          userId: auth.userId,
          host: auth.host,
          userRegion: auth.userRegion,
          account: auth.account,
          _edition: ed,
          _wasEncrypted: true
        };
        _cachedStorageMtime = _currentStorageMtime(ed);
        return _cachedAuthInfo;
      } catch (decryptErr) {
        console.log(`[auth] ${ed.toUpperCase()} decryption failed: ${decryptErr.message}, trying plaintext`);
      }

      const storage = readStorageJsonByEdition(ed);
      if (!storage) continue;

      const authKey = 'iCubeAuthInfo://icube.cloudide';
      const authRaw = storage[authKey];
      if (!authRaw) continue;

      if (isEncryptedAuthData(authRaw)) {
        console.log(`[auth] ${ed.toUpperCase()} edition auth data is encrypted and decryption failed, skipping`);
        continue;
      }

      const auth = JSON.parse(authRaw);
      console.log(`[auth] Using ${ed.toUpperCase()} edition auth data (plaintext)`);
      _cachedAuthInfo = {
        token: auth.token,
        refreshToken: auth.refreshToken,
        expiredAt: auth.expiredAt,
        refreshExpiredAt: auth.refreshExpiredAt,
        tokenReleaseAt: auth.tokenReleaseAt,
        userId: auth.userId,
        host: auth.host,
        userRegion: auth.userRegion,
        account: auth.account,
        _edition: ed,
        _wasEncrypted: false
      };
      _cachedStorageMtime = _currentStorageMtime(ed);
      return _cachedAuthInfo;
    } catch (e) {
      console.log(`[auth] Failed to read ${ed.toUpperCase()} edition: ${e.message}`);
      continue;
    }
  }

  const manualToken = process.env.TRAE_MANUAL_TOKEN;
  if (manualToken && manualToken.startsWith('eyJ')) {
    console.log('[auth] Using manual token from TRAE_MANUAL_TOKEN env');
    const apiHost = process.env.TRAE_API_HOST || 'https://trae-api-cn.mchost.guru';
    try {
      const parts = manualToken.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      const expMs = payload.exp * 1000;
      const isExpired = Date.now() > expMs;
      if (isExpired) {
        console.log('[auth] Manual token is expired, exp:', new Date(expMs).toISOString());
      }
      return {
        token: manualToken,
        refreshToken: null,
        expiredAt: new Date(expMs).toISOString(),
        refreshExpiredAt: null,
        tokenReleaseAt: null,
        userId: payload.data?.id || null,
        host: apiHost,
        userRegion: null,
        account: null,
        _edition: 'manual'
      };
    } catch (e) {
      return {
        token: manualToken,
        refreshToken: null,
        expiredAt: null,
        refreshExpiredAt: null,
        tokenReleaseAt: null,
        userId: null,
        host: apiHost,
        userRegion: null,
        account: null,
        _edition: 'manual'
      };
    }
  }

  throw new Error('No readable auth info found in any edition. CN edition data is encrypted and SG edition data is not available.');
}

function getDeviceIds() {
  const edition = detectEdition();
  const editions = [edition, edition === 'cn' ? 'sg' : 'cn'];
  for (const ed of editions) {
    const storage = readStorageJsonByEdition(ed);
    if (storage && storage['telemetry.machineId']) {
      return {
        machineId: storage['telemetry.machineId'] || '',
        sqmId: storage['telemetry.sqmId'] || '',
        devDeviceId: storage['telemetry.devDeviceId'] || ''
      };
    }
  }
  return { machineId: '', sqmId: '', devDeviceId: '' };
}

function isTokenExpired(authInfo) {
  if (!authInfo || !authInfo.expiredAt) return true;
  const expiry = new Date(authInfo.expiredAt);
  if (isNaN(expiry.getTime())) return true; // Invalid date = treat as expired
  return expiry < new Date();
}

function isTokenExpiringSoon(authInfo, minutesThreshold) {
  if (!authInfo || !authInfo.expiredAt) return true;
  const expiresAt = new Date(authInfo.expiredAt);
  if (isNaN(expiresAt.getTime())) return true; // Invalid date = treat as expiring
  const threshold = minutesThreshold || 30;
  const warningTime = new Date(Date.now() + threshold * 60 * 1000);
  return expiresAt < warningTime;
}

// Hosts come from the central realm table (src/realms.js) so the chat host and the
// auth host stay paired per realm — mixing them yields 404 TLB pages.
const DEFAULT_HOST_CN = getRealmConfig('cn').chatHost;
const DEFAULT_HOST_SG = getRealmConfig('sg').chatHost;
const DEFAULT_AUTH_HOST_SG = getRealmConfig('sg').authHost;
const DEFAULT_AUTH_HOST_CN = getRealmConfig('cn').authHost;

// Default IDE version/device info (overridable via env). Used as fallback when
// Trae's manifest.json cannot be read. Update when Trae CN/SG releases new builds.
const DEFAULT_IDE_VERSION_CN = '3.3.67';
const DEFAULT_IDE_VERSION_SG = '3.5.51';
const DEFAULT_IDE_VERSION_CODE = '20260401';

function getApiHost() {
  const envHost = process.env.TRAE_API_HOST;
  if (envHost) return envHost;

  // Runtime switch wins over the cached credential's own edition so a flip takes
  // effect on the very next request, even if _cachedAuthInfo is momentarily stale.
  const runtime = getUpstreamEdition();
  if (runtime) return chatHostFor(runtime);

  try {
    const authInfo = getAuthInfo();
    return chatHostFor(authInfo._edition, authInfo.userRegion);
  } catch (e) {
    return DEFAULT_HOST_SG;
  }
}

function getAuthHost() {
  const envHost = process.env.TRAE_AUTH_HOST;
  if (envHost) return envHost;

  const runtime = getUpstreamEdition();
  if (runtime) return authHostFor(runtime);

  try {
    const authInfo = getAuthInfo();
    return authHostFor(authInfo._edition);
  } catch (e) {
    return DEFAULT_AUTH_HOST_SG;
  }
}

async function exchangeToken(refreshToken, authHostOverride, clientIdOverride) {
  const authHost = authHostOverride || getAuthHost();
  const url = `${authHost}/cloudide/api/v3/trae/oauth/ExchangeToken`;
  // SOLO clients register under en1oxy7wnw8j9n; the legacy IDE client under ono9krqynydwx5.
  // Mismatched ClientID → 10101 "refresh token is not matched to the client".
  const clientId = clientIdOverride || process.env.TRAE_OAUTH_CLIENT_ID || 'ono9krqynydwx5';

  const body = {
    ClientID: clientId,
    RefreshToken: refreshToken,
    ClientSecret: process.env.TRAE_OAUTH_CLIENT_SECRET || '-',
    UserID: ''
  };

  const fetchOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  };

  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || '';
  if (proxyUrl) {
    try {
      if (proxyUrl.startsWith('socks')) {
        const { SocksProxyAgent } = require('socks-proxy-agent');
        fetchOptions.agent = new SocksProxyAgent(proxyUrl);
      } else {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        fetchOptions.agent = new HttpsProxyAgent(proxyUrl);
      }
    } catch (e) {
      console.error(`[auth] proxy setup failed: ${e.message}`);
    }
  }

  const resp = await fetch(url, fetchOptions);

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`ExchangeToken failed: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  // Normalize: the api.trae.cn endpoint wraps fields in Result{Token,RefreshToken,TokenExpireAt,
  // RefreshExpireAt}; legacy shape is lowercase at top level.
  const r = data.Result || {};
  return {
    token: r.Token || data.token || data.Token || null,
    refreshToken: r.RefreshToken || data.refreshToken || data.RefreshToken || null,
    expiredAt: (r.TokenExpireAt && new Date(Number(r.TokenExpireAt)).toISOString()) || data.expiredAt || null,
    refreshExpiredAt: (r.RefreshExpireAt && new Date(Number(r.RefreshExpireAt)).toISOString()) || data.refreshExpiredAt || null,
    raw: data
  };
}

let _refreshPromise = null; // Mutex for token refresh

// ===== Credential pool =====
// Pool dir holds one plaintext JSON per account: {userId, account, token, refreshToken,
// expiredAt, refreshExpiredAt, host, userRegion, exhaustedUntil, dead, lastError, addedAt, lastUsedAt}.
// Members are seeded from client data-dir storage.json snapshots (decrypt once); after that the
// gateway owns the lifecycle: ExchangeToken renewal is persisted back so clients never need to run.
// 4008 (quota exhausted) marks the member exhausted for a cooldown and rotates; 1001 marks it dead;
// 4010 (risk-control "access denied", temporary) marks it exhausted for a short rate-limit cooldown and rotates.
// Pool member store: account-<userId>.json files with decrypted tokens. TRAE_POOL_DIR
// relocates it (e.g. the repo's accounts/ dir — that dir MUST stay git-ignored).
const POOL_DIR = process.env.TRAE_POOL_DIR || path.join(getRoamingRoot(), 'traework-pool');
const POOL_COOLDOWN_MS = (Number(process.env.TRAE_POOL_COOLDOWN_HOURS) || 24) * 3600 * 1000;
const POOL_RATELIMIT_COOLDOWN_MS = (Number(process.env.TRAE_POOL_RATELIMIT_COOLDOWN_MINUTES) || 120) * 60 * 1000;
// Upstream SSE error codes that mean "this account can't serve right now" → pool failover.
// 4008 quota exhausted | 1001 auth invalid/rotated | 4010 risk-control temporary access denial.
// Model/param-level codes (2001/4001/4027/...) must NOT rotate — they fail on every account.
// 4017 (common risk control, extra "max_account") is device/IP-level — rotation is futile and
// burns the healthy pool — so it is deliberately NOT in this set; the error passes through.
const ACCOUNT_FAILOVER_CODES = new Set([4008, 1001, 4010]);
let _poolActiveUserId = null;

function _poolMemberFile(userId) {
  return path.join(POOL_DIR, `account-${userId}.json`);
}

function _poolWriteMember(m) {
  fs.mkdirSync(POOL_DIR, { recursive: true });
  fs.writeFileSync(_poolMemberFile(m.userId), JSON.stringify(m, null, 2), 'utf-8');
}

function poolEnabled() {
  if (process.env.TRAE_POOL === 'off') return false;
  try {
    return fs.existsSync(POOL_DIR) && fs.readdirSync(POOL_DIR).some(f => f.endsWith('.json'));
  } catch (e) {
    return false;
  }
}
console.log(`[auth] pool env: TRAE_POOL=${JSON.stringify(process.env.TRAE_POOL)} TRAE_DATA_DIR=${JSON.stringify(process.env.TRAE_DATA_DIR)} TRAE_POOL_SELF_RENEW=${JSON.stringify(process.env.TRAE_POOL_SELF_RENEW)} -> poolEnabled=${poolEnabled()}`);

// Synthetic per-account device fingerprint. Every instance on this machine shares the
// same telemetry ids (icube-dc device id is literally identical across all 17 data dirs;
// machineId has 4 groups) — upstream saw N accounts on ONE device and answered 4017
// "max_account" risk control. Mint a distinct, stable identity per pool account instead:
// generated once, then frozen in the member file (never re-minted on token refresh).
// Formats mirror the real client values: machineId = 64 hex, sqmId = {GUID},
// devDeviceId = UUID, soloDeviceId = 16 digits (the iCubeAuthInfo://icube-dc:<id> key).
function mintDeviceIds() {
  const nodeCrypto = require('crypto');
  const hex64 = nodeCrypto.randomBytes(32).toString('hex');
  const sqmId = '{' + uuidv4().toUpperCase() + '}';
  const devDeviceId = uuidv4();
  // 16 digits built from safe-range draws (randomInt caps at 2^48, so 3×5-digit chunks)
  const soloDeviceId = String(nodeCrypto.randomInt(1, 10))
    + Array.from({ length: 3 }, () => String(nodeCrypto.randomInt(0, 100000)).padStart(5, '0')).join('');
  return { machineId: hex64, sqmId, devDeviceId, soloDeviceId };
}

function _hasFullDeviceIds(d) {
  return !!(d && typeof d === 'object' && d.machineId && d.devDeviceId && d.soloDeviceId);
}

// Frozen-identity resolution: an existing complete identity always wins (no churn on
// token refresh); otherwise mint a fresh one. Partial/incomplete ids (legacy members
// captured before soloDeviceId existed) are replaced, not merged.
function _resolveMemberDeviceIds(existing, incoming) {
  if (_hasFullDeviceIds(existing)) return existing;
  if (_hasFullDeviceIds(incoming)) return incoming;
  return mintDeviceIds();
}

function _poolLoad() {
  try {
    const members = fs.readdirSync(POOL_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(POOL_DIR, f), 'utf-8')); }
        catch (e) { return null; }
      })
      .filter(Boolean);
    // migration: live members without a complete frozen device identity get one now.
    // Dead members keep none until revived (revival re-imports and mints then).
    let migrated = 0;
    for (const m of members) {
      if (!m.dead && !_hasFullDeviceIds(m.deviceIds)) {
        m.deviceIds = mintDeviceIds();
        try { _poolWriteMember(m); migrated++; } catch (e) {}
      }
    }
    if (migrated) console.log(`[pool] minted per-account device ids for ${migrated} member(s)`);
    return members.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  } catch (e) {
    return [];
  }
}

/**
 * Is this member usable, optionally restricted to one realm?
 *
 * `realm` is the routing decision for the request being served. Passing it explicitly
 * is what enables per-request realm routing: a `gpt-5.4` request can be served by an
 * international account while a `glm-5.3` request in flight at the same time is served
 * by a China account — both from one pool, one process.
 *
 * When `realm` is null/omitted the member is accepted regardless of realm (used by
 * status views that have no routing context). An explicit upstream pin still wins,
 * because a pinned deployment must never drift to the other realm.
 */
function _poolHealthy(m, realm) {
  if (m.enabled === false) return false; // human-managed bench flag (docs: accounts/README)
  if (m.dead) return false;
  if (m.exhaustedUntil && m.exhaustedUntil >= Date.now()) return false;
  if (m.expiredAt && new Date(m.expiredAt).getTime() < Date.now()) return false; // expired token = needs re-login
  const want = realm || getUpstreamEdition() || (process.env.TRAE_EDITION ? detectEdition() : null);
  if (want && (m._edition || 'cn') !== want) return false;
  return true;
}

/**
 * Pick the next healthy member, optionally scoped to a realm.
 *
 * Rotation order is stable (insertion order by addedAt) and the last-used member is
 * preferred while it stays healthy, so a conversation keeps landing on the same
 * account instead of flapping between members on every turn.
 */
function poolPickActive(realm) {
  const members = _poolLoad();
  if (!members.length) return null;
  const cur = _poolActiveUserId ? members.find(m => m.userId === _poolActiveUserId) : null;
  if (cur && _poolHealthy(cur, realm)) return cur;
  const next = members.find(m => _poolHealthy(m, realm));
  if (next) {
    if (_poolActiveUserId !== next.userId) console.log(`[pool] active account -> ${next.userId}${realm ? ` (realm ${realm})` : ''}`);
    _poolActiveUserId = next.userId;
    return next;
  }
  return null;
}

/** Every healthy member of a realm, in rotation order (used by status views). */
function poolHealthyMembers(realm) {
  return _poolLoad().filter(m => _poolHealthy(m, realm));
}

// Import/upsert a member from decrypted auth info; prefers the newer expiredAt. Not thread-safe, fine here.
// A newer token means the account was re-logged in a client → clear dead/exhausted flags (revival).
// Realm is derived from the credential itself (see realms.realmFromCredential) rather than
// defaulted to one realm: decryptAuthData() returns no realm field, and a hard fallback
// silently mislabels every international account as China, which then sends that
// account's token refresh to the China auth host (always fails).
function _editionFromAuth(authInfo) {
  return realmFromCredential(authInfo);
}

function poolImportFromAuth(authInfo) {
  if (!authInfo || !authInfo.userId || !authInfo.refreshToken) return null;
  const file = _poolMemberFile(authInfo.userId);
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) {}
  if (existing && new Date(existing.expiredAt || 0) >= new Date(authInfo.expiredAt || 0)) {
    return existing; // disk copy is not newer than what the pool already holds
  }
  const member = {
    userId: authInfo.userId,
    account: authInfo.account || null,
    token: authInfo.token,
    refreshToken: authInfo.refreshToken,
    expiredAt: authInfo.expiredAt,
    refreshExpiredAt: authInfo.refreshExpiredAt,
    host: authInfo.host || null,
    userRegion: authInfo.userRegion || null,
    _edition: _editionFromAuth(authInfo),
    deviceIds: _resolveMemberDeviceIds(existing ? existing.deviceIds : null, authInfo.deviceIds),
    clientId: existing ? existing.clientId || null : null,
    // fresh tokens from a client login revive the member
    exhaustedUntil: null,
    dead: false,
    needsRefresh: false,
    lastError: null,
    addedAt: existing ? existing.addedAt || Date.now() : Date.now(),
    lastUsedAt: existing ? existing.lastUsedAt || null : null,
  };
  _poolWriteMember(member);
  console.log(`[pool] member ${member.userId} imported/updated${existing && existing.dead ? ' (revived)' : ''}`);
  return member;
}

// Mark active member by error code and rotate to next healthy one. Returns true if switched.
// Mode A (no self-renewal): 4008 = quota out → cooldown + rotate; 1001 = token revoked/stale
// → dead until the account is re-logged in its client instance (hot-import revives it);
// 4010 = risk-control temporary denial → short cooldown + rotate (back off, then it revives itself).
// 4017 stays OUT: device/IP-level (extra "max_account"), same block on every account here.
function isAccountFailoverCode(code) {
  return ACCOUNT_FAILOVER_CODES.has(Number(code));
}

function poolFailover(code, message) {
  if (!poolEnabled()) return false;
  const members = _poolLoad();
  const m = members.find(x => x.userId === _poolActiveUserId) || members.find(x => _poolHealthy(x));
  if (!m) return false;
  if (Number(code) === 4008) {
    m.exhaustedUntil = Date.now() + POOL_COOLDOWN_MS;
    m.lastError = `quota exhausted (${String(message || '').slice(0, 120)})`;
  } else if (Number(code) === 1001) {
    m.dead = true;
    m.lastError = `auth rejected (${String(message || '').slice(0, 120)}) — re-login this account in its client instance to revive`;
  } else if (Number(code) === 4010) {
    m.exhaustedUntil = Date.now() + POOL_RATELIMIT_COOLDOWN_MS;
    m.lastError = `rate limited / access denied (${String(message || '').slice(0, 120)})`;
  } else {
    return false;
  }
  _poolWriteMember(m);
  const next = members.find(x => x.userId !== m.userId && _poolHealthy(x));
  if (!next) {
    console.log(`[pool] account ${m.userId} marked (${code}); no other healthy member`);
    return false;
  }
  _poolActiveUserId = next.userId;
  _cachedAuthInfo = null;
  console.log(`[pool] account ${m.userId} marked (${code}); active -> ${next.userId}`);
  return true;
}

function poolStatus() {
  const members = _poolLoad().map(m => ({
    userId: m.userId,
    account: m.account && (m.account.username || m.account.nonPlainTextMobile) || m.userId,
    edition: m._edition || 'cn',
    expiredAt: m.expiredAt,
    exhaustedUntil: m.exhaustedUntil || null,
    exhausted: !!m.exhaustedUntil && m.exhaustedUntil > Date.now(),
    dead: !!m.dead,
    benched: m.enabled === false,
    // Whether this member would actually be picked right now. Realm match alone is
    // not enough — a benched, dead, cooled-down or expired member is skipped by the
    // rotation, and a status view that ignores that reports unusable accounts as
    // available, which is exactly how you end up debugging the wrong thing.
    served: _poolHealthy(m),
    lastError: m.lastError || null,
    lastUsedAt: m.lastUsedAt || null,
    active: m.userId === _poolActiveUserId,
  }));
  return { enabled: poolEnabled(), dir: POOL_DIR, activeUserId: _poolActiveUserId, upstream: getUpstreamStatus(), members };
}

// Snapshot of which upstream the gateway would use right now, and why.
function getUpstreamStatus() {
  const runtime = getUpstreamEdition();
  const source = runtime ? 'runtime'
    : (process.env.TRAE_DATA_DIR ? 'data_dir_pin'
    : (process.env.TRAE_EDITION ? 'env' : 'auto_detect'));
  let detected = null;
  try { detected = runtime || detectEdition(); } catch (e) {}
  return {
    edition: detected,
    source,
    api_host: getApiHost(),
    auth_host: getAuthHost(),
    data_dir: getTraeDataDir(),
    pinned_by_env: { TRAE_API_HOST: !!process.env.TRAE_API_HOST, TRAE_EDITION: !!process.env.TRAE_EDITION, TRAE_DATA_DIR: !!process.env.TRAE_DATA_DIR },
    state_file: UPSTREAM_STATE_FILE,
  };
}

// Clear dead/exhausted flags (after re-login in a client or manual cooldown skip).
function revivePoolMember(userId) {
  try {
    const file = _poolMemberFile(userId);
    const m = JSON.parse(fs.readFileSync(file, 'utf-8'));
    m.dead = false;
    m.exhaustedUntil = null;
    m.lastError = null;
    _poolWriteMember(m);
    return true;
  } catch (e) {
    return false;
  }
}

function _memberAuthHost(m) {
  if (m.host && /^https?:/.test(String(m.host))) {
    // keep the original host the client used
    const u = new URL(m.host);
    return u.origin;
  }
  return (m._edition === 'cn') ? (process.env.TRAE_AUTH_HOST_CN || 'https://api.trae.cn') : getAuthHost();
}

async function _poolRefreshMember(m, force) {
  if (!POOL_SELF_RENEW && !force) return; // self-renew off — never rotate the token family behind the client's back
  const expMs = m.expiredAt ? new Date(m.expiredAt).getTime() : 0;
  const needsRefresh = force || !expMs || Date.now() > expMs - 30 * 60 * 1000;
  if (m.refreshToken && needsRefresh) {
    console.log(`[pool] refreshing member ${m.userId}${force ? ' (forced)' : ''} (expiredAt ${m.expiredAt})`);
    // CN pool accounts come from the SOLO client → ClientID en1oxy7wnw8j9n (see jb() in the client bundle)
    const clientId = m.clientId || ((m._edition === 'cn') ? 'en1oxy7wnw8j9n' : (process.env.TRAE_OAUTH_CLIENT_ID || 'ono9krqynydwx5'));
    m.clientId = clientId;
    const result = await exchangeToken(m.refreshToken, _memberAuthHost(m), clientId);
    if (!result || !result.token) throw new Error('ExchangeToken returned no token');
    m.token = result.token;
    m.refreshToken = result.refreshToken || m.refreshToken;
    m.expiredAt = result.expiredAt;
    m.refreshExpiredAt = result.refreshExpiredAt || m.refreshExpiredAt;
    _poolWriteMember(m);
  }
}

// Pool-aware credential acquisition (mode A: tokens come from client logins; near-expiry
// tokens are self-renewed through ExchangeToken — see _poolPrepareMember below).
// Hot-import scans every client data dir (product dirs + TraeWork-CN-N multi-open dirs);
// a login/refresh in any of them upserts/revives the pool.
function _poolScanDirs() {
  const root = getRoamingRoot();
  const names = [...new Set([...CN_PRODUCT_DIRS, ...SG_PRODUCT_DIRS])];
  try {
    for (const d of fs.readdirSync(root)) {
      if (/^TraeWork-CN-\d+$/.test(d)) names.push(d);
    }
  } catch (e) {}
  return [...new Set(names)].map(d => path.join(root, d));
}
let _poolDirMtimes = {};

function _poolImportAllDirs() {
  let changed = 0;
  for (const dataDir of _poolScanDirs()) {
    const storagePath = path.join(dataDir, 'User', 'globalStorage', 'storage.json');
    let mtime = null;
    try { mtime = fs.statSync(storagePath).mtimeMs; } catch (e) { continue; }
    if (_poolDirMtimes[dataDir] === mtime) continue;
    _poolDirMtimes[dataDir] = mtime;
    try {
      const auth = decryptTcAuthData(dataDir);
      // per-account device identity is minted in poolImportFromAuth/_poolLoad — every
      // dir on this machine shares the same telemetry ids, copying them is pointless
      poolImportFromAuth(auth);
      changed++;
    } catch (e) { /* logged out / unreadable dir — fine */ }
  }
  if (changed) console.log(`[pool] scanned data dirs, ${changed} updated`);
}

const POOL_REFRESH_RETRY_MS = 10 * 60 * 1000; // backoff after a failed self-renewal attempt

// Self-renewal master switch. ExchangeToken rotates the token family server-side, which
// silently invalidates the SAME account's login in its client instance — idle clients only
// find out on next use and get instant-logged-out (2026-09-09 CN-12 incident). With
// TRAE_POOL_SELF_RENEW=off the gateway serves on imported tokens as-is and relies on
// client re-login (hot-import) for fresh credentials.
const POOL_SELF_RENEW = (process.env.TRAE_POOL_SELF_RENEW || '').trim().toLowerCase() !== 'off';
const _renewSkipLogged = new Set();
// Single-account path logs its skip once per process (the pool path tracks per member).
let _singleRenewSkipLogged = false;

// Self-renewal wire-in for the picked member: runs _poolRefreshMember — a no-op unless the
// token is inside its 30-min pre-expiry window (or expiredAt is missing). Never throws;
// renewal failure degrades:
//   token still valid -> keep serving on it; back off renewal attempts for 10 min
//   token expired     -> mark dead (client re-login revives via hot import); caller picks next
// Returns false when the member is unusable and already marked; true when safe to serve.
async function _poolPrepareMember(m) {
  if (!m.token) {
    m.dead = true;
    m.lastError = 'member has no token';
    _poolWriteMember(m);
    return false;
  }
  if (!POOL_SELF_RENEW) {
    const validUntil0 = m.expiredAt ? new Date(m.expiredAt).getTime() : 0;
    if (validUntil0 && validUntil0 <= Date.now()) {
      m.dead = true;
      m.lastError = 'token expired; self-renew disabled — re-login this account in its client instance to revive';
      _poolWriteMember(m);
      console.log(`[pool] member ${m.userId} expired and self-renew is off — needs client re-login`);
      return false;
    }
    if (!_renewSkipLogged.has(m.userId)) {
      _renewSkipLogged.add(m.userId);
      console.log(`[pool] self-renew off — member ${m.userId} served on imported token until ${m.expiredAt}`);
    }
    return true; // serve on the imported token as-is; client refresh (hot-import) supplies new creds
  }
  if (!m.refreshToken) return true; // nothing to renew with — serve as-is (legacy member shape)
  if (m.refreshRetryAfter && Date.now() < m.refreshRetryAfter) return true; // recent failure — back off
  try {
    await _poolRefreshMember(m);
    return true;
  } catch (e) {
    const msg = String((e && e.message) || e || '').slice(0, 120);
    const validUntil = m.expiredAt ? new Date(m.expiredAt).getTime() : 0;
    if (validUntil > Date.now()) {
      m.lastError = `token refresh failed (${msg}) — serving on current token, renewal retries after 10m`;
      m.refreshRetryAfter = Date.now() + POOL_REFRESH_RETRY_MS;
      _poolWriteMember(m);
      console.log(`[pool] member ${m.userId} refresh failed; token still valid until ${m.expiredAt} — serving on it`);
      return true;
    }
    m.dead = true;
    m.lastError = `token expired and refresh failed (${msg}) — re-login this account in its client instance to revive`;
    m.refreshRetryAfter = null;
    _poolWriteMember(m);
    console.log(`[pool] member ${m.userId} expired and refresh failed — needs manual re-login`);
    return false;
  }
}

// Pool-aware credential acquisition. Throws when no healthy member remains.
/**
 * Which realm should serve this model, if routing is not already pinned?
 *
 * Returns null when the gateway is pinned to one realm (TRAE_EDITION / runtime
 * switch) or when the model name does not identify a realm — in both cases the
 * caller falls back to the pinned selection, so behaviour only changes for
 * deployments that actually hold accounts from more than one realm.
 */
function poolRealmForModel(modelHint) {
  if (!poolEnabled()) return null;
  if (getUpstreamEdition() || process.env.TRAE_EDITION) return null; // explicit pin wins
  if (!modelHint) return null;
  const realmsPresent = new Set(_poolLoad().map(m => m._edition || 'cn'));
  if (realmsPresent.size < 2) return null; // single-realm pool: no routing decision to make
  return inferRealmForModel(modelHint);
}

/**
 * Acquire credentials from the pool for one request.
 *
 * `realm` scopes the pick to a single region. Callers that know which realm a model
 * belongs to (see model-config `realm` hints / inferRealmForModel) pass it so a
 * request is served by an account that can actually reach that model: the two realms
 * expose almost disjoint model catalogs, so a wrong-realm account answers 4001/1005.
 * Omitting `realm` falls back to the pinned/global upstream selection.
 */
async function poolGetAuthInfo(realm) {
  _poolImportAllDirs();
  const scope = realm || getUpstreamEdition() || null;
  const noMember = () => new Error(
    scope
      ? `Trae pool: no healthy ${scope.toUpperCase()} account (see /v1/pool)`
      : 'Trae pool: all accounts exhausted or dead (see /v1/pool)'
  );
  let m = poolPickActive(scope);
  if (!m) throw noMember();
  // Bounded walk: _poolPrepareMember marks members that turn out unusable (no token /
  // expired + failed renewal); pick the next healthy one until one prepares clean.
  for (let walk = 0; ; walk++) {
    if (await _poolPrepareMember(m)) break;
    if (walk >= 3) throw noMember(); // 4 consecutive unusable picks — pool is effectively down
    m = poolPickActive(scope);
    if (!m) throw noMember();
  }
  m.lastUsedAt = Date.now();
  _poolWriteMember(m);
  _poolActiveUserId = m.userId;
  const memberRealm = m._edition || 'cn';
  const authInfo = {
    token: m.token,
    refreshToken: m.refreshToken,
    expiredAt: m.expiredAt,
    refreshExpiredAt: m.refreshExpiredAt,
    userId: m.userId,
    // The member's own realm decides its hosts — never the global disk state, or an
    // international member would be pointed at the China chat host.
    host: m.host || chatHostFor(memberRealm, m.userRegion),
    userRegion: m.userRegion,
    account: m.account,
    _edition: memberRealm,
    deviceIds: m.deviceIds || null,
    _pool: true,
  };
  _cachedAuthInfo = authInfo;
  return authInfo;
}

/**
 * Resolve credentials for a request.
 *
 * `modelHint` lets the caller request realm-aware pool picking: when the model name
 * is exclusive to one realm, an account from that realm is selected. Pass nothing to
 * keep the pinned/global behaviour (single-realm deployments never need a hint).
 *
 * Realm-aware picks are not memoised in `_refreshPromise`: two concurrent requests
 * for different realms must be able to hold different accounts at the same time,
 * which one shared promise cannot express.
 */
async function refreshTokenIfNeeded(modelHint) {
  if (poolEnabled()) {
    const realm = poolRealmForModel(modelHint);
    if (realm) return poolGetAuthInfo(realm);
    if (_refreshPromise) return _refreshPromise;
    _refreshPromise = poolGetAuthInfo().finally(() => { _refreshPromise = null; });
    return _refreshPromise;
  }
  const authInfo = getAuthInfo();

  if (authInfo._edition === 'manual') {
    if (!isTokenExpired(authInfo)) {
      return authInfo;
    }
    throw new Error('Manual token expired. Please update TRAE_MANUAL_TOKEN in .env file.');
  }

  if (!isTokenExpiringSoon(authInfo, 30)) {
    return authInfo;
  }

  // Self-renew is off: serve on the imported token and let the client's own refresh
  // supply new credentials — getAuthInfo() re-reads storage.json whenever the cached
  // token is expired, so a client-side refresh is picked up automatically.
  // ExchangeToken rotates the whole token family server-side, which silently logs the
  // same account out of every other client instance. The pool path has been guarded
  // against exactly that since the 2026-09-09 CN-12 incident, but this single-account
  // path was not: a near-expiry token here rotated the family regardless of
  // TRAE_POOL_SELF_RENEW. A token inside the 30-minute window is still VALID, so
  // there is nothing to gain by refreshing it early.
  if (!POOL_SELF_RENEW) {
    if (!isTokenExpired(authInfo)) {
      if (!_singleRenewSkipLogged) {
        _singleRenewSkipLogged = true;
        console.log(`[auth] self-renew off — serving on imported token until ${authInfo.expiredAt}; open the Trae client to refresh`);
      }
      return authInfo;
    }
    throw new Error(
      'Trae token expired and self-renew is disabled (TRAE_POOL_SELF_RENEW=off). '
      + 'Open the Trae client once so it refreshes its own credential, then retry.',
    );
  }

  // Mutex: if a refresh is already in progress, wait for it
  if (_refreshPromise) {
    return _refreshPromise;
  }

  _refreshPromise = (async () => {
    console.log(`Token expiring soon or expired (at ${authInfo.expiredAt}), attempting refresh...`);

    try {
      const result = await exchangeToken(authInfo.refreshToken);
      if (result && result.token) {
        const newAuth = {
          ...authInfo,
          token: result.token,
          refreshToken: result.refreshToken || authInfo.refreshToken,
          expiredAt: result.expiredAt,
          refreshExpiredAt: result.refreshExpiredAt || authInfo.refreshExpiredAt,
          tokenReleaseAt: result.tokenReleaseAt || authInfo.tokenReleaseAt
        };

        if (authInfo._wasEncrypted) {
          console.log(`Token refreshed successfully (in-memory only, original data was encrypted), new expiry: ${newAuth.expiredAt}`);
          _cachedAuthInfo = newAuth;
          return newAuth;
        }

        const storage = readStorageJsonByEdition(authInfo._edition || detectEdition());
        const authKey = 'iCubeAuthInfo://icube.cloudide';
        storage[authKey] = JSON.stringify({
          token: newAuth.token,
          refreshToken: newAuth.refreshToken,
          expiredAt: newAuth.expiredAt,
          refreshExpiredAt: newAuth.refreshExpiredAt,
          tokenReleaseAt: newAuth.tokenReleaseAt,
          userId: newAuth.userId,
          host: newAuth.host,
          userRegion: newAuth.userRegion,
          account: newAuth.account
        });

        const storagePath = getStorageJsonPath(authInfo._edition);
        fs.writeFileSync(storagePath, JSON.stringify(storage, null, '\t'), 'utf-8');
        console.log(`Token refreshed successfully, new expiry: ${newAuth.expiredAt}`);
        _cachedAuthInfo = newAuth;
        _cachedStorageMtime = _currentStorageMtime(authInfo._edition); // we just rewrote the file ourselves
        return newAuth;
      } else {
        console.error('Token refresh returned no token');
        if (isTokenExpired(authInfo)) {
          throw new Error('Token expired and refresh returned no token. Please restart Trae IDE to re-authenticate.');
        }
        return authInfo;
      }
    } catch (err) {
      console.error(`Token refresh failed: ${err.message}`);
      if (isTokenExpired(authInfo)) {
        throw new Error('Token expired and refresh failed. Please restart Trae IDE to re-authenticate.');
      }
    } finally {
      _refreshPromise = null; // Clear mutex
    }

    return authInfo;
  })();

  return _refreshPromise;
}

function findManifestPaths() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    process.env.TRAE_INSTALL_DIR,
    path.join('D:', 'software', 'TRAE SOLO CN'),
    path.join('E:', 'software', 'Trae CN'),
    path.join(localAppData, 'Programs', 'TRAE SOLO CN'),
    path.join(localAppData, 'Programs', 'Trae CN'),
    path.join(localAppData, 'Programs', 'Trae-CN'),
    path.join(localAppData, 'Programs', 'TRAE SOLO'),
    path.join(localAppData, 'Programs', 'Trae'),
  ].filter(Boolean);
  return candidates.map((dir) => path.join(dir, 'manifest.json'));
}

function readManifest() {
  for (const manifestPath of findManifestPaths()) {
    try {
      if (!fs.existsSync(manifestPath)) continue;
      return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (e) {}
  }
  return null;
}

function getIdeVersion() {
  // Explicit env override takes highest priority
  if (process.env.TRAE_IDE_VERSION) return process.env.TRAE_IDE_VERSION;

  // SOLO real traffic uses appVersion (e.g. 0.1.38), NOT tron buildVersion.
  try {
    const manifest = readManifest();
    if (manifest) {
      if (isSoloProduct() && manifest.appVersion) return String(manifest.appVersion);
      // Classic Trae CN often uses appVersion too in headers; prefer appVersion then buildVersion
      if (manifest.appVersion) return String(manifest.appVersion);
      if (manifest.buildVersion) return String(manifest.buildVersion);
    }
  } catch (e) {
    // Fall through to defaults
  }

  try {
    const authInfo = getAuthInfo();
    if (authInfo._edition === 'cn') return isSoloProduct() ? '0.1.38' : DEFAULT_IDE_VERSION_CN;
    return DEFAULT_IDE_VERSION_SG;
  } catch (e) {
    return isSoloProduct() ? '0.1.38' : DEFAULT_IDE_VERSION_CN;
  }
}

function getIdeVersionCode() {
  if (process.env.TRAE_IDE_VERSION_CODE) return process.env.TRAE_IDE_VERSION_CODE;
  // SOLO observed code like 20260716 (date-based). Prefer env; else derive from today for solo.
  if (isSoloProduct()) {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }
  return DEFAULT_IDE_VERSION_CODE;
}

// SOLO stores real aha device id in storage key: iCubeAuthInfo://icube-dc:<deviceId>
function extractSoloDeviceId(storage) {
  if (!storage || typeof storage !== 'object') return '';
  for (const key of Object.keys(storage)) {
    const m = /^iCubeAuthInfo:\/\/icube-dc:(\d+)$/.exec(key);
    if (m) return m[1];
  }
  return '';
}

function isSoloProduct() {
  if (process.env.TRAE_PRODUCT) {
    return String(process.env.TRAE_PRODUCT).toLowerCase().includes('solo');
  }
  try {
    const dataDir = getTraeDataDir();
    return /solo/i.test(dataDir || '');
  } catch (e) {
    return false;
  }
}

// deviceIdsOverride: per-account identity (pool member deviceIds / getDeviceIds() result).
// Fields present in the override win over the single storage.json this process resolves —
// that storage read used to stamp EVERY pool account with the same physical fingerprint.
function getDeviceInfo(deviceIdsOverride) {
  const authInfo = getAuthInfo();
  const storage = readStorageJsonByEdition(authInfo._edition || detectEdition()) || {};
  const o = (deviceIdsOverride && typeof deviceIdsOverride === 'object') ? deviceIdsOverride : {};
  const machineId = o.machineId || storage['telemetry.machineId'] || '';
  const sqmId = o.sqmId || storage['telemetry.sqmId'] || '';
  const devDeviceId = o.devDeviceId || storage['telemetry.devDeviceId'] || '';
  const soloDeviceId = o.soloDeviceId || extractSoloDeviceId(storage);
  // SOLO real traffic uses aha device id (digits), not hash(machineId).
  const deviceId = process.env.TRAE_DEVICE_ID
    || soloDeviceId
    || hashDeviceId(machineId)
    || '';
  return {
    cpu: process.env.TRAE_CPU || 'Intel',
    device_id: deviceId,
    machine_id: machineId || process.env.TRAE_MACHINE_ID || '',
    device_model: process.env.TRAE_DEVICE_MODEL || (isSoloProduct() ? '83DG' : '82RF'),
    os_name: process.env.TRAE_OS_NAME || 'windows',
    os_version: process.env.TRAE_OS_VERSION || (isSoloProduct() ? 'Windows 11 Pro' : 'Windows 10'),
    sqm_id: sqmId,
    dev_device_id: devDeviceId,
    is_solo: isSoloProduct()
  };
}

function buildCommonHeaders(authInfo, deviceIds) {
  // TRAE_PER_ACCOUNT_DEVICE_IDS=on sends each pool account's minted identity.
  // DEFAULT OFF, measured 2026-09-09: minted (unregistered) device ids get SILENTLY
  // DROPPED by the upstream — TCP/TLS connects but no response ever arrives (the old
  // shared fingerprint at least gets a fast 4017/answer). The shared real fingerprint
  // passes whenever the device-level risk cooldown has lifted.
  const deviceInfo = getDeviceInfo(process.env.TRAE_PER_ACCOUNT_DEVICE_IDS === 'on' ? deviceIds : null);
  const traceId = uuidv4().replace(/-/g, '');
  const spanId = uuidv4().replace(/-/g, '').slice(0, 16);
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Cloud-IDE-JWT ${authInfo.token}`,
    'X-Cloudide-Token': authInfo.token,
    'x-app-id': process.env.TRAE_APP_ID || '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'x-app-version': 'default',
    'x-ide-version-code': getIdeVersionCode(),
    'x-app-version-code': getIdeVersionCode(),
    'x-custom-trace-id': traceId,
    // SOLO also sends W3C traceparent-like header
    'x-flow-traceparent': `04-${traceId}-${spanId}-01`,
    'x-device-brand': deviceInfo.device_model,
    'x-device-cpu': deviceInfo.cpu,
    'x-device-id': deviceInfo.device_id,
    'x-machine-id': deviceInfo.machine_id,
    'x-os-version': deviceInfo.os_version,
    'x-device-type': deviceInfo.os_name,
    'x-ide-version': getIdeVersion(),
    'x-ide-version-type': 'stable',
    'request-traffic-type': 'prod',
    'x-uid': authInfo.userId || ''
  };
  return headers;
}

function buildStreamHeaders(authInfo, deviceIds, requestId, lastEventId) {
  const headers = buildCommonHeaders(authInfo, deviceIds);
  headers['Accept'] = 'text/event-stream';
  headers['X-Request-ID'] = requestId || uuidv4();
  headers['X-Trae-Request-ID'] = headers['X-Request-ID'];
  if (lastEventId) {
    headers['Last-Event-ID'] = lastEventId;
  }
  return headers;
}

function hashDeviceId(machineId) {
  if (!machineId) return '';
  let hash = 0;
  for (let i = 0; i < machineId.length; i++) {
    const char = machineId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString().padStart(19, '0');
}

module.exports = {
  getTraeDataDir,
  getStorageJsonPath,
  readStorageJson,
  getAuthInfo,
  getDeviceIds,
  getDeviceInfo,
  isTokenExpired,
  isTokenExpiringSoon,
  getApiHost,
  getAuthHost,
  getIdeVersion,
  getIdeVersionCode,
  exchangeToken,
  refreshTokenIfNeeded,
  buildCommonHeaders,
  buildStreamHeaders,
  hashDeviceId,
  detectEdition,
  isSoloProduct,
  extractSoloDeviceId,
  poolEnabled,
  poolImportFromAuth,
  isAccountFailoverCode,
  poolFailover,
  poolStatus,
  revivePoolMember,
  getUpstreamEdition,
  setUpstreamEdition,
  clearUpstreamEdition,
  getUpstreamStatus,
  poolRealmForModel,
  poolHealthyMembers
};
