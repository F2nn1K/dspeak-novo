// Picovoice Koala (supressor de ruído): a AccessKey fica SÓ aqui no servidor.
// O cliente pede a chave em /api/koala/key (com rate-limit por IP) — assim ela
// não fica chumbada no HTML público. O modelo (~4 MB) também é servido por nós
// (/koala/model.pv), baixado uma vez do GitHub oficial e cacheado em disco.
const fs = require('fs');
const path = require('path');
const https = require('https');

const MODEL_URL = 'https://raw.githubusercontent.com/Picovoice/koala/main/lib/common/koala_params.pv';
const MODEL_CACHE = path.join(__dirname, 'aic-cache', 'koala_params.pv');

function readAccessKey() {
  if (process.env.KOALA_ACCESS_KEY && process.env.KOALA_ACCESS_KEY.trim()) {
    return process.env.KOALA_ACCESS_KEY.trim();
  }
  const candidates = [
    path.join(__dirname, '.secrets', 'koala.key'),
    path.join(__dirname, 'koala.key')
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

let modelReady = null;
const keyHits = new Map(); // ip -> [timestamps]

function allowKey(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const list = (keyHits.get(ip) || []).filter((t) => now - t < windowMs);
  if (list.length >= 12) {
    keyHits.set(ip, list);
    return false;
  }
  list.push(now);
  keyHits.set(ip, list);
  return true;
}

async function ensureModelFile() {
  if (modelReady) return modelReady;
  modelReady = (async () => {
    try {
      const st = fs.statSync(MODEL_CACHE);
      if (st.size > 100000) return MODEL_CACHE;
    } catch (e) { /* baixa abaixo */ }
    console.log('[koala] Baixando modelo Koala (uma vez, ~4 MB)...');
    await httpsDownload(MODEL_URL, MODEL_CACHE);
    return MODEL_CACHE;
  })();
  return modelReady;
}

function requestIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function mount(app) {
  app.get('/koala/model.pv', async (req, res) => {
    try {
      const file = await ensureModelFile();
      res.type('application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(file);
    } catch (e) {
      console.error('[koala] modelo:', e.message);
      res.status(503).json({ error: 'model-unavailable' });
    }
  });

  app.get('/api/koala/key', (req, res) => {
    const ip = requestIp(req);
    if (!allowKey(ip)) return res.status(429).json({ ok: false, error: 'rate-limit' });
    const key = readAccessKey();
    if (!key) return res.status(503).json({ ok: false, error: 'not-configured' });
    res.json({ ok: true, accessKey: key });
  });

  if (readAccessKey()) {
    console.log('[koala] Supressor Koala configurado — chave será entregue ao cliente.');
    ensureModelFile().catch((e) => console.warn('[koala] modelo ainda não baixado:', e.message));
  } else {
    console.warn('[koala] Sem KOALA_ACCESS_KEY / .secrets/koala.key — supressor cai no RNNoise.');
  }
}

module.exports = { mount };
