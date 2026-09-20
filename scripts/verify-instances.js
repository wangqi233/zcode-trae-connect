// Verify the local trae2api gateway instance(s) respond and report their
// upstream routing. Reads each bearer key from its .env (never prints it) and
// issues one short chat completion per instance.
//
// Usage:
//   node scripts/verify-instances.js
//       -> repo-root .env on :19960 (optional :19961 if instances/trae-cn/.env exists)
//   node scripts/verify-instances.js --port 19961 --env C:\path\to\.env
//   node scripts/verify-instances.js --instance 'solo:19960:trae2api_extract/trae2api-main/.env' \
//                                    --instance 'cn:19961:instances/trae-cn/.env'

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const MODEL = process.env.TRAE_VERIFY_MODEL || 'deepseek-v4-pro';

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function buildInstances() {
  if (process.argv.includes('--instance')) {
    const out = [];
    process.argv.forEach((a, i) => {
      if (a === '--instance') {
        const spec = String(process.argv[i + 1] || '');
        const [name, port, env] = spec.split(':');
        out.push({ name: name || 'gateway', port: Number(port || 19960), env: path.resolve(ROOT, env || '.env') });
      }
    });
    return out.length ? out : null;
  }
  const instances = [
    {
      name: 'gateway',
      port: Number(argValue('--port', process.env.TRAE_SOLO_PORT || 19960)),
      env: path.resolve(ROOT, argValue('--env', '.env')),
    },
  ];
  const cnDefault = path.join(ROOT, 'instances', 'trae-cn', '.env');
  if (fs.existsSync(cnDefault)) {
    instances.push({ name: 'trae-cn', port: Number(process.env.TRAE_CN_PORT || 19961), env: cnDefault });
  }
  return instances;
}

// Plain string scan: no regex, no shell, nothing interpolated into a command.
function readApiKey(envPath) {
  const text = fs.readFileSync(envPath, 'utf-8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('API_KEY=')) {
      return line.slice('API_KEY='.length).trim();
    }
  }
  throw new Error('API_KEY not found in ' + envPath);
}

function post(port, apiKey, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf-8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          Authorization: 'Bearer ' + apiKey,
        },
        timeout: 180000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
      },
    );
    req.on('timeout', () => { req.destroy(new Error('request timed out')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const instances = buildInstances();
  for (const inst of instances) {
    process.stdout.write('=== ' + inst.name + ' (:' + inst.port + ') ===\n');
    let apiKey;
    try {
      apiKey = readApiKey(inst.env);
    } catch (err) {
      process.stdout.write('  env read failed: ' + err.message + '\n\n');
      continue;
    }

    const started = Date.now();
    try {
      const res = await post(inst.port, apiKey, {
        model: MODEL,
        messages: [{ role: 'user', content: '只回复两个字：收到' }],
        stream: false,
      });
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      process.stdout.write('  HTTP ' + res.status + '  ' + elapsed + 's\n');
      let content = '(unparsable)';
      try {
        const parsed = JSON.parse(res.body);
        content = parsed && parsed.choices && parsed.choices[0]
          ? String(parsed.choices[0].message.content)
          : JSON.stringify(parsed).slice(0, 160);
      } catch (parseErr) {
        content = res.body.slice(0, 160);
      }
      process.stdout.write('  reply: ' + content + '\n');
    } catch (err) {
      process.stdout.write('  FAILED: ' + err.message + '\n');
    }
    process.stdout.write('\n');
  }
}

main();