/**
 * Add Trae provider entries to ZCode's provider_config.json.
 *
 * ZCode parses that document with strict zod schemas: ONE unrecognised key
 * discards the entire personal provider set with no error surfaced. So this
 * script builds the document from an allowlist of known-good keys, validates
 * the shapes in-process, backs the file up, and only then writes.
 *
 * Bearer keys come from the environment (TRAE_SOLO_API_KEY / TRAE_CN_API_KEY).
 * Nothing credential-shaped is stored in this file.
 *
 * Usage:
 *   node scripts/write-zcode-providers.js --dry-run
 *   TRAE_SOLO_API_KEY=... TRAE_CN_API_KEY=... node scripts/write-zcode-providers.js
 *
 * Platform probing for the ZCode user-data root:
 *   ZCode's desktop build may keep its data root somewhere other than the CLI's
 *   $HOME\.zcode (for example an E: drive). If TARGET is not found, point this
 *   script at the real root without changing the file:
 *     $env:ZCODE_DESKTOP_ROOT = 'E:\path\to\.zcode\v2'
 *   Confirm from the running process if it ever moves:
 *     Get-CimInstance Win32_Process -Filter "Name='ZCode.exe'" | Select CommandLine
 */

const fs = require('fs');
const path = require('path');

const HOME_DIR = process.env.USERPROFILE || process.env.HOME || '';

const DESKTOP_ROOT = process.env.ZCODE_DESKTOP_ROOT
  || path.join(HOME_DIR, '.zcode', 'v2');

const TARGET = path.join(DESKTOP_ROOT, 'provider_config.json');
const VALIDATOR = path.join(
  HOME_DIR, '.zcode', 'cli', 'plugins', 'data', 'workbuddy-connect',
  'docs', 'validate-provider-config.mjs',
);

const DRY_RUN = process.argv.includes('--dry-run');

// Allowlists mirroring how ZCode's zod schemas see this document.
const ALLOW = {
  root: ['schemaVersion', 'config'],
  config: ['providerOrder', 'providerConfigRules', 'modelConfigRules'],
  providerRule: ['providerId', 'templateId', 'providerName', 'enabled', 'config'],
  providerConfig: ['group', 'logo', 'access', 'api', 'builtinModelIds', 'personalModelIds', 'modelOrder', 'visibility'],
  modelRule: ['modelId', 'providerId', 'config'],
  modelConfig: ['enabled', 'properties', 'optionSpecs'],
  properties: ['requiresMfjsToolSchema', 'contextWindow', 'inputFormat', 'outputFormat', 'supportsToolCall', 'supportsJsonSchemaOutput', 'supportsNativeWebSearch', 'supportsMidConversationSystem'],
  inputFormat: ['supportsText', 'supportsImage', 'supportsVideo', 'supportsAudio', 'supportsPdf'],
  outputFormat: ['supportsText'],
  optionSpecs: ['reasoningLevel', 'maxOutputTokens'],
  maxOutputTokens: ['max', 'map'],
  access: ['type', 'apiKey'],
  api: ['type', 'baseUrl'],
};

const CHAT_API_TYPE = 'openai-chat-completions';
const ACCESS_API_KEY = 'api-key';

// Model rosters actually available in each Trae client (member accounts),
// verified live against each endpoint (HTTP 200 + model echo).
// Note: Trae shows two "DeepSeek-V4-Flash 正式版" in SOLO with different
// rates — they are distinct models:
//   deepseek-v4.1-flash (rate 0.06) vs DeepSeek-V4-Flash-Official (rate 0.08).
const SOLO_MODELS = [
    { id: 'Doubao-Seed-Evolving', contextWindow: 200000, maxOutput: 64000 },
    { id: 'doubao-seed-2.1-turbo', contextWindow: 200000, maxOutput: 64000 },
    { id: 'doubao-seed-2.1-pro', contextWindow: 200000, maxOutput: 64000 },
    { id: 'doubao-seed-code', contextWindow: 256000, maxOutput: 64000 },
    { id: 'glm-5.3-flashx', contextWindow: 200000, maxOutput: 64000 },
    { id: 'glm-5.3-flash', contextWindow: 200000, maxOutput: 64000 },
    { id: 'glm-5.3', contextWindow: 200000, maxOutput: 64000 },
    { id: 'glm-5.2', contextWindow: 116000, maxOutput: 64000 },
    { id: 'deepseek-v4.1-flash', contextWindow: 116000, maxOutput: 64000 },
    { id: 'DeepSeek-V4-Flash-Official', contextWindow: 116000, maxOutput: 64000 },
    { id: 'DeepSeek-V4-Pro-Official', contextWindow: 116000, maxOutput: 64000 },
    { id: 'kimi-k3', contextWindow: 200000, maxOutput: 64000 },
    { id: 'kimi-k2.8-preview', contextWindow: 200000, maxOutput: 64000 },
    { id: 'minimax-m3', contextWindow: 116000, maxOutput: 64000 },
    { id: 'qwen3.8-max', contextWindow: 200000, maxOutput: 64000 },
    { id: 'qwen3.8-flash', contextWindow: 200000, maxOutput: 64000 },
    { id: 'qwen3.7-plus', contextWindow: 200000, maxOutput: 64000 },
];

const CN_MODELS = [
    { id: 'Doubao-Seed-Evolving', contextWindow: 200000, maxOutput: 64000 },
    { id: 'doubao-seed-2.1-turbo', contextWindow: 200000, maxOutput: 64000 },
    { id: 'doubao-seed-2.1-pro', contextWindow: 200000, maxOutput: 64000 },
    { id: 'doubao-seed-code', contextWindow: 256000, maxOutput: 64000 },
    { id: 'glm-5.3', contextWindow: 200000, maxOutput: 64000 },
    { id: 'glm-5.2', contextWindow: 116000, maxOutput: 64000 },
    { id: 'deepseek-v4-flash', contextWindow: 116000, maxOutput: 64000 },
    { id: 'deepseek-v4-pro', contextWindow: 116000, maxOutput: 64000 },
    { id: 'kimi-k3', contextWindow: 200000, maxOutput: 64000 },
    { id: 'kimi-k2.7-code', contextWindow: 200000, maxOutput: 64000 },
    { id: 'kimi-k2.6', contextWindow: 200000, maxOutput: 64000 },
    { id: 'minimax-m3', contextWindow: 116000, maxOutput: 64000 },
    { id: 'qwen3.8-max', contextWindow: 200000, maxOutput: 64000 },
    { id: 'qwen3.7-plus', contextWindow: 200000, maxOutput: 64000 },
];

// Two: SOLO (light queue) and classic Trae CN.
const INSTANCES = [
  {
    providerId: 'trae-solo',
    providerName: 'Trae SOLO',
    port: 19960,
    keyEnv: 'TRAE_SOLO_API_KEY',
    models: SOLO_MODELS,
  },
  {
    providerId: 'trae-cn',
    providerName: 'Trae CN',
    port: 19961,
    keyEnv: 'TRAE_CN_API_KEY',
    models: CN_MODELS,
  },
];

function requireKey(inst) {
  const value = process.env[inst.keyEnv];
  if (value && value.trim()) return value.trim();
  // A dry run only exercises the shape checks, so a placeholder keeps the
  // bearer out of the equation entirely.
  if (DRY_RUN) return 'dry-run-placeholder';
  throw new Error(inst.keyEnv + ' is not set — export it before running this script');
}

function providerRule(inst, bearer) {
  const modelIds = inst.models.map((m) => m.id);
  return {
    providerId: inst.providerId,
    providerName: inst.providerName,
    config: {
      group: 'standard-personal',
      access: { type: ACCESS_API_KEY, apiKey: bearer },
      api: { type: CHAT_API_TYPE, baseUrl: 'http://127.0.0.1:' + inst.port + '/v1' },
      personalModelIds: modelIds,
      modelOrder: modelIds,
    },
  };
}

function modelRule(inst, model) {
  return {
    modelId: model.id,
    providerId: inst.providerId,
    config: {
      enabled: true,
      properties: {
        contextWindow: model.contextWindow,
        supportsToolCall: true,
        inputFormat: { supportsText: true, supportsImage: true },
        outputFormat: { supportsText: true },
      },
      optionSpecs: { maxOutputTokens: { max: model.maxOutput } },
    },
  };
}

function checkKeys(obj, allowed, where) {
  for (const key of Object.keys(obj)) {
    if (allowed.indexOf(key) === -1) {
      throw new Error('unknown key: ' + where + '.' + key);
    }
  }
}

function validateShapes(doc) {
  checkKeys(doc, ALLOW.root, '(root)');
  checkKeys(doc.config, ALLOW.config, 'config');
  for (const rule of doc.config.providerConfigRules.providerRules) {
    checkKeys(rule, ALLOW.providerRule, 'providerRules[]');
    checkKeys(rule.config, ALLOW.providerConfig, 'providerRules[].config');
    // Template providers (e.g. ZCode's built-in zai-api) may omit access/api.
    if (rule.config.access !== undefined) {
      checkKeys(rule.config.access, ALLOW.access, 'providerRules[].config.access');
    }
    if (rule.config.api !== undefined) {
      checkKeys(rule.config.api, ALLOW.api, 'providerRules[].config.api');
    }
  }
  for (const rule of doc.config.modelConfigRules.providerModelRules) {
    checkKeys(rule, ALLOW.modelRule, 'providerModelRules[]');
    checkKeys(rule.config, ALLOW.modelConfig, 'providerModelRules[].config');
    if (rule.config.properties !== undefined) {
      checkKeys(rule.config.properties, ALLOW.properties, 'modelConfig.properties');
      if (rule.config.properties.inputFormat) {
        checkKeys(rule.config.properties.inputFormat, ALLOW.inputFormat, 'properties.inputFormat');
      }
      if (rule.config.properties.outputFormat) {
        checkKeys(rule.config.properties.outputFormat, ALLOW.outputFormat, 'properties.outputFormat');
      }
    }
    if (rule.config.optionSpecs !== undefined) {
      checkKeys(rule.config.optionSpecs, ALLOW.optionSpecs, 'modelConfig.optionSpecs');
      if (rule.config.optionSpecs.maxOutputTokens) {
        checkKeys(rule.config.optionSpecs.maxOutputTokens, ALLOW.maxOutputTokens, 'optionSpecs.maxOutputTokens');
      }
    }
  }
}

function main() {
  if (!fs.existsSync(TARGET)) throw new Error('target not found: ' + TARGET);
  const doc = JSON.parse(fs.readFileSync(TARGET, 'utf-8'));

  const wanted = INSTANCES.map((i) => i.providerId);
  const rules = doc.config.providerConfigRules.providerRules;
  const modelRules = doc.config.modelConfigRules.providerModelRules;

  // Replace only our own entries; other providers stay untouched.
  for (let i = rules.length - 1; i >= 0; i--) {
    if (wanted.indexOf(rules[i].providerId) !== -1) rules.splice(i, 1);
  }
  for (let i = modelRules.length - 1; i >= 0; i--) {
    if (wanted.indexOf(modelRules[i].providerId) !== -1) modelRules.splice(i, 1);
  }
  doc.config.providerOrder = doc.config.providerOrder.filter(
    (id) => wanted.indexOf(id) === -1,
  );

  for (const inst of INSTANCES) {
    rules.push(providerRule(inst, requireKey(inst)));
    for (const model of inst.models) modelRules.push(modelRule(inst, model));
    doc.config.providerOrder.push(inst.providerId);
  }

  validateShapes(doc);
  process.stdout.write('shape check: OK\n');

  if (DRY_RUN) {
    process.stdout.write('dry run — nothing written\n');
    process.stdout.write('providerOrder: ' + JSON.stringify(doc.config.providerOrder) + '\n');
    return;
  }

  // Timestamped backup so successive runs never overwrite the previous good copy.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = TARGET + '.bak-before-trae-' + stamp;
  fs.copyFileSync(TARGET, backup);
  process.stdout.write('backup: ' + backup + '\n');

  const tmp = TARGET + '.tmp-trae';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf-8');
  process.stdout.write('staged: ' + tmp + '\n');
  process.stdout.write('validator available at: ' + VALIDATOR + '\n');

  fs.copyFileSync(tmp, TARGET);
  fs.unlinkSync(tmp);
  process.stdout.write('written: ' + TARGET + '\n');
  process.stdout.write('providerOrder: ' + JSON.stringify(doc.config.providerOrder) + '\n');
}

main();
