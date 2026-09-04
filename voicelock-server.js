// DSpeak VoiceLock — entrega do runtime/modelo e telemetria estritamente técnica.
// O áudio e a assinatura vocal nunca chegam a este módulo: a inferência acontece
// no navegador/Electron/WebView do usuário.
const express = require('express');
const fs = require('fs');
const path = require('path');

const DEFAULT_MODEL_DIR = path.join(__dirname, 'voicelock-models');
const metricsHits = new Map();
const HUSH_ASSETS = [
  path.join('postfilter', 'v3', 'pkg', 'df_bg.wasm'),
  path.join('postfilter', 'v3', 'models', 'DeepFilterNet3_onnx.tar.gz')
];

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0].trim();
}

function allowMetric(ip) {
  const now = Date.now();
  const cutoff = now - 10 * 60 * 1000;
  const hits = (metricsHits.get(ip) || []).filter((at) => at > cutoff);
  if (hits.length >= 60) return false;
  hits.push(now);
  metricsHits.set(ip, hits);
  return true;
}

function readManifest(modelDir) {
  try {
    const file = path.join(modelDir, 'manifest.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const encoder = parsed && (parsed.encoder || (parsed.models && parsed.models.encoder));
    const extractor = parsed && (parsed.extractor || (parsed.models && parsed.models.extractor));
    const version = parsed && (parsed.version || parsed.modelVersion);
    if (!parsed || !version || !encoder || !extractor) return null;
    const assetName = (model) => {
      const raw = String(model.file || model.url || '').replace(/^[.][/\\]/, '');
      if (!raw || path.isAbsolute(raw) || raw.includes('..')) return null;
      return raw;
    };
    const required = [assetName(encoder), assetName(extractor)].filter(Boolean);
    if (required.length !== 2) return null;
    if (!required.every((name) => fs.existsSync(path.join(modelDir, name)))) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function hasHushPostFilter(modelDir) {
  return HUSH_ASSETS.every((name) => fs.existsSync(path.join(modelDir, name)));
}

function finiteNumber(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
}

function cleanMetric(body) {
  const allowedBackends = new Set(['wasm', 'webgpu', 'unknown']);
  const allowedPlatforms = new Set(['electron', 'web', 'android-webview', 'unknown']);
  return {
    event: String(body.event || '').slice(0, 40),
    backend: allowedBackends.has(body.backend) ? body.backend : 'unknown',
    platform: allowedPlatforms.has(body.platform) ? body.platform : 'unknown',
    initMs: finiteNumber(body.initMs, 0, 120000),
    frameP95Ms: finiteNumber(body.frameP95Ms, 0, 1000),
    underruns: finiteNumber(body.underruns, 0, 100000),
    errorCode: String(body.errorCode || '').slice(0, 80)
  };
}

function mount(app) {
  const modelDir = process.env.VOICELOCK_MODEL_DIR || DEFAULT_MODEL_DIR;
  const ortDir = path.join(__dirname, 'node_modules', 'onnxruntime-web', 'dist');

  app.use('/vendor/onnxruntime-web', express.static(ortDir, {
    setHeaders(res, filePath) {
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      if (filePath.endsWith('.mjs')) res.type('text/javascript');
      if (filePath.endsWith('.wasm')) res.type('application/wasm');
    }
  }));

  app.use('/models/voicelock', express.static(modelDir, {
    fallthrough: true,
    setHeaders(res, filePath) {
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      if (filePath.endsWith('.onnx')) res.type('application/octet-stream');
      if (path.basename(filePath) !== 'manifest.json') {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));

  app.get('/api/voicelock/config', (_req, res) => {
    const manifest = readManifest(modelDir);
    const postFilterAvailable = hasHushPostFilter(modelDir);
    const releaseApproved = !!manifest && (
      manifest.productionReady === true ||
      process.env.VOICELOCK_ALLOW_UNTRAINED === '1'
    );
    const enabled = process.env.VOICELOCK_ENABLED === '1' && releaseApproved && postFilterAvailable;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      enabled,
      experimental: true,
      manifestUrl: enabled ? '/models/voicelock/manifest.json' : null,
      postFilterBaseUrl: enabled ? '/models/voicelock/postfilter' : null,
      fallbackMode: process.env.VOICELOCK_LEGACY_FALLBACK === '0' ? 'hush' : 'legacy',
      version: manifest ? (manifest.version || manifest.modelVersion) : null,
      enrollmentSeconds: 4,
      reason: enabled
        ? null
        : (!manifest
            ? 'model-unavailable'
            : (!releaseApproved
                ? 'model-not-approved'
                : (!postFilterAvailable ? 'postfilter-unavailable' : 'disabled')))
    });
  });

  app.post(
    '/api/voicelock/metrics',
    express.json({ limit: '4kb', type: 'application/json' }),
    (req, res) => {
      const ip = clientIp(req);
      if (!allowMetric(ip)) return res.status(429).json({ ok: false });
      const metric = cleanMetric(req.body || {});
      // Sem username, IP, áudio ou embedding no log.
      console.log('[VoiceLock metric]', JSON.stringify(metric));
      res.json({ ok: true });
    }
  );

  const manifest = readManifest(modelDir);
  const releaseApproved = !!manifest && (
    manifest.productionReady === true ||
    process.env.VOICELOCK_ALLOW_UNTRAINED === '1'
  );
  const postFilterAvailable = hasHushPostFilter(modelDir);
  if (process.env.VOICELOCK_ENABLED === '1' && releaseApproved && postFilterAvailable) {
    console.log(`[VoiceLock] runtime habilitado; modelo ${manifest.version || manifest.modelVersion}.`);
  } else {
    const reason = !manifest
      ? 'modelo ausente'
      : (!releaseApproved
          ? 'modelo ainda não aprovado'
          : (!postFilterAvailable ? 'pós-filtro Hush ausente' : 'flag desligada'));
    console.log(`[VoiceLock] aguardando pesos próprios; ${reason}.`);
  }
}

module.exports = { mount, readManifest, hasHushPostFilter };
