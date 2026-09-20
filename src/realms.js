'use strict';

/**
 * Central per-region configuration table.
 *
 * Trae runs two independent deployments ("realms"): the mainland-China service and
 * the international (Singapore) service. They differ in far more than the base URL —
 * chat host, auth host, default IDE version, model catalog and even the product
 * identity sent in headers all change per realm. Keeping those facts in one table
 * (instead of scattered `if (edition === 'cn')` branches) makes each difference
 * auditable, which matters because mis-routing a token to the wrong realm fails in
 * confusing ways (see docs/PROTOCOL.md).
 *
 * Every field is env-overridable; the literals below are the values observed from
 * the official clients and are safe to publish (they are shared service endpoints,
 * not per-user secrets).
 */

const REALMS = {
  cn: {
    id: 'cn',
    label: 'Trae 国内版 (China)',
    // Chat/LLM endpoint. Distinct from the auth endpoint on purpose: mixing them
    // yields 404 TLB pages.
    chatHost: process.env.TRAE_HOST_CN || 'https://trae-api-cn.mchost.guru',
    // ExchangeToken / token refresh live on the auth host, NOT the chat host.
    authHost: process.env.TRAE_AUTH_HOST_CN || 'https://api.trae.cn',
    // Fallback IDE version when the local client manifest cannot be read.
    ideVersion: process.env.TRAE_IDE_VERSION_CN || '3.3.67',
    // Data directories that may hold this realm's client login (%APPDATA% child names).
    productDirs: ['TRAE SOLO CN', 'Trae CN', 'TRAE CN'],
    // OAuth client id used when exchanging a refresh token.
    oauthClientId: process.env.TRAE_OAUTH_CLIENT_ID_CN || 'en1oxy7wnw8j9n',
    // Region markers seen in decrypted credentials / token claims.
    matchHosts: /trae\.cn|mchost\.guru/i,
    matchRegions: ['CN'],
  },
  sg: {
    id: 'sg',
    label: 'Trae 国际版 (Global)',
    chatHost: process.env.TRAE_HOST_SG || 'https://coresg-normal.trae.ai',
    authHost: process.env.TRAE_AUTH_HOST_SG || 'https://growsg-normal.trae.ai',
    ideVersion: process.env.TRAE_IDE_VERSION_SG || '3.5.51',
    productDirs: ['TRAE SOLO', 'Trae', 'TRAE'],
    oauthClientId: process.env.TRAE_OAUTH_CLIENT_ID_SG || 'ono9krqynydwx5',
    matchHosts: /growsg|coresg|coreva|trae\.ai/i,
    matchRegions: ['SG', 'US'],
  },
};

// United States deployment shares the international product but its own chat host.
// Only chat routing differs; auth still goes through the SG auth host.
const US_CHAT_HOST = process.env.TRAE_HOST_US || 'https://coreva-normal.trae.ai';

const DEFAULT_REALM = 'cn';
const REALM_IDS = Object.keys(REALMS);

function getRealmConfig(realm) {
  return REALMS[realm] || REALMS[DEFAULT_REALM];
}

function isRealmId(value) {
  return REALM_IDS.includes(String(value || '').trim().toLowerCase());
}

function normalizeRealm(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'solo' || v === 'solo-cn' || v === 'solo_cn') return 'cn';
  return REALM_IDS.includes(v) ? v : null;
}

/**
 * Derive the realm from a credential itself.
 *
 * This is the authoritative direction: a token's issuer claim and the auth host the
 * client used are properties of the account, whereas "which realm is selected right
 * now" is a routing choice. Defaulting an unknown account to a fixed realm silently
 * mislabels every international account (they then get their token refresh sent to
 * the China auth host, which always fails).
 */
function realmFromCredential(authInfo) {
  if (!authInfo) return DEFAULT_REALM;
  const explicit = normalizeRealm(authInfo._edition || authInfo.realm);
  if (explicit) return explicit;

  const host = String(authInfo.host || '');
  const issuer = String(authInfo.iss || authInfo.issuer || '');
  const probe = `${host} ${issuer}`;
  for (const id of REALM_IDS) {
    if (REALMS[id].matchHosts.test(probe)) return id;
  }

  const region = authInfo.userRegion;
  const code = String((region && region.region) || region || '').toUpperCase();
  for (const id of REALM_IDS) {
    if (REALMS[id].matchRegions.includes(code)) return id;
  }
  return DEFAULT_REALM;
}

/** Resolve the chat host for a realm, honouring the US regional split. */
function chatHostFor(realm, userRegion) {
  const code = String((userRegion && userRegion.region) || userRegion || '').toUpperCase();
  if (realm === 'sg' && code === 'US') return US_CHAT_HOST;
  return getRealmConfig(realm).chatHost;
}

function authHostFor(realm) {
  return getRealmConfig(realm).authHost;
}

/**
 * Model names that exist in only one realm's catalog.
 *
 * The two deployments expose almost disjoint catalogs (measured 2026-09-17: 47 names,
 * 3 in common, one of which is an internal helper). Because a wrong-realm request is
 * answered with 4001 "param is invalid" rather than anything mentioning regions, this
 * list is what lets a caller route by model name instead of failing mysteriously.
 *
 * Keep these lowercase; matching is case-insensitive and prefix-based so family
 * variants (gpt-5.6-terra, gemini-3-flash-auto, ...) resolve without listing each one.
 */
const REALM_EXCLUSIVE_MODELS = {
  sg: [
    'gpt-5', 'gpt-6', 'gpt-4', 'gemini', 'kimi-k', 'minimax', 'deepseek-v3',
    'deepseek-chat', 'deepseek-reasoner', 'dola-seed', 'doubao-for-auto',
  ],
  cn: [
    'glm', 'qwen', 'doubao-seed', 'kimi-k3', 'kimi-k2.6', 'kimi-k2.7',
    'deepseek-v4', 'seed-code', 'sagitta', 'aquila', 'browser_use',
  ],
};

/**
 * Infer which realm can serve a model, or null when the name is ambiguous/unknown.
 *
 * An explicit `realm` field on the model config always wins; this is only the
 * fallback for configs that predate realm routing. Returning null (rather than
 * guessing) keeps the caller's pinned/global realm in charge for shared names.
 */
function inferRealmForModel(modelName, explicitRealm) {
  const explicit = normalizeRealm(explicitRealm);
  if (explicit) return explicit;
  const name = String(modelName || '').trim().toLowerCase();
  if (!name) return null;
  const roots = name.split('/').pop(); // strip any 渠道// prefix
  const hits = [];
  for (const id of REALM_IDS) {
    if (REALM_EXCLUSIVE_MODELS[id].some(p => roots.startsWith(p) || roots.includes(p))) hits.push(id);
  }
  return hits.length === 1 ? hits[0] : null; // ambiguous or unknown → caller decides
}

module.exports = {
  REALMS,
  REALM_IDS,
  DEFAULT_REALM,
  US_CHAT_HOST,
  REALM_EXCLUSIVE_MODELS,
  getRealmConfig,
  isRealmId,
  normalizeRealm,
  realmFromCredential,
  chatHostFor,
  authHostFor,
  inferRealmForModel,
};
