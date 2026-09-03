// ai-coustics Voice Focus: a chave longa fica SÓ aqui no servidor.
// O cliente do DSpeak recebe um JWT de ~1h (o SDK no navegador exige isso).
const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN_URL = 'https://api.ai-coustics.io/v1/sdk/tokens';
const MODEL_URL = 'https://artifacts.ai-coustics.io/models/quail-vf-2-2-s-16khz/v6/quail_vf_2_2_s_16khz_gf70x7zf_v14.aicmodel';
const MODEL_CACHE = path.join(__dirname, 'aic-cache', 'quail-vf-2-2-s-16khz.aicmodel');

function readLicense() {
  if (process.env.AIC_SDK_LICENSE && process.env.AIC_SDK_LICENSE.trim()) {
    return process.env.AIC_SDK_LICENSE.trim();
  }
  const candidates = [
    path.join(__dirname, 'key.txt'),
    path.join(__dirname, '..', 'key.txt')
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8').trim();
        if (raw) return raw;
      }
    } catch (e) { /* tenta o próximo */ }
  }
  return '';
}

function decodeApiKey(license) {
  const payload = String(license || '').split('.')[0];
  if (!payload) throw new Error('license-format');
  const json = Buffer.from(payload, 'base64').toString('utf8');
  const parsed = JSON.parse(json);
  if (!parsed.api_key) throw new Error('license-format');
  return parsed.api_key;
}

function httpsJson(url, options) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error('aic-http-' + res.statusCode);
          err.status = res.statusCode;
          err.body = body.slice(0, 300);
          return reject(err);
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(new Error('aic-timeout')); });
    req.end();
  });
}

function httpsDownload(url, destFile) {
  return new Promise((resolve, reject) => {
    const tmp = destFile + '.part';
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    const file = fs.createWriteStream(tmp);
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(tmp); } catch (e) {}
        return httpsDownload(res.headers.location, destFile).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(tmp); } catch (e) {}
        return reject(new Error('model-http-' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        fs.renameSync(tmp, destFile);
        resolve(destFile);
      }));
    });
    req.on('error', (e) => {
      try { fs.unlinkSync(tmp); } catch (err) {}
      reject(e);
    });
  });
}

let cachedApiKey = null;
let modelReady = null;
const tokenHits = new Map(); // ip -> [timestamps]

function apiKey() {
  if (cachedApiKey) return cachedApiKey;
  const license = readLicense();
  if (!license) throw new Error('no-license');
  cachedApiKey = decodeApiKey(license);
  return cachedApiKey;
}

function allowToken(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const list = (tokenHits.get(ip) || []).filter((t) => now - t < windowMs);
  if (list.length >= 12) {
    tokenHits.set(ip, list);
    return false;
  }
  list.push(now);
  tokenHits.set(ip, list);
  return true;
}

async function mintToken() {
  const key = apiKey();
  const auth = Buffer.from(key + ':').toString('base64');
  const data = await httpsJson(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + auth,
      Accept: 'application/json'
    }
  });
  if (!data || !data.token) throw new Error('no-token');
  return { token: data.token, expiresAt: data.expires_at || null };
}

async function ensureModelFile() {
  if (modelReady) return modelReady;
  modelReady = (async () => {
    try {
      const st = fs.statSync(MODEL_CACHE);
      if (st.size > 100000) return MODEL_CACHE;
    } catch (e) { /* baixa abaixo */ }
    console.log('[ai-coustics] Baixando modelo Voice Focus (uma vez, ~5 MB)...');
    await httpsDownload(MODEL_URL, MODEL_CACHE);
    return MODEL_CACHE;
  })();
  return modelReady;
}

function requestIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function mount(app) {
  const wasmDir = path.join(__dirname, 'node_modules', '@ai-coustics', 'aic-sdk-wasm');
  app.use('/vendor/aic-sdk-wasm', (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  }, require('express').static(wasmDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.wasm')) res.type('application/wasm');
    }
  }));

  app.get('/aic/model.aicmodel', async (req, res) => {
    try {
      const file = await ensureModelFile();
      res.type('application/octet-stream');
      res.sendFile(file);
    } catch (e) {
      console.error('[ai-coustics] modelo:', e.message);
      res.status(503).json({ error: 'model-unavailable' });
    }
  });

  app.get('/api/aic/token', async (req, res) => {
    const ip = requestIp(req);
    if (!allowToken(ip)) return res.status(429).json({ ok: false, error: 'rate-limit' });
    try {
      const out = await mintToken();
      res.json({ ok: true, token: out.token, expiresAt: out.expiresAt, enhancementLevel: 0.85 });
    } catch (e) {
      if (e.message === 'no-license') {
        return res.status(503).json({ ok: false, error: 'not-configured' });
      }
      console.error('[ai-coustics] token:', e.message, e.body || '');
      res.status(502).json({ ok: false, error: 'mint-failed' });
    }
  });

  try {
    apiKey();
    console.log('[ai-coustics] Voice Focus configurado — JWT será emitido para o cliente.');
    ensureModelFile().catch((e) => console.warn('[ai-coustics] modelo ainda não baixado:', e.message));
  } catch (e) {
    console.warn('[ai-coustics] Sem AIC_SDK_LICENSE / key.txt — isolamento cai no RNNoise.');
  }
}

module.exports = { mount };
