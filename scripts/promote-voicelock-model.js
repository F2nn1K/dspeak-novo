#!/usr/bin/env node
// Promove pesos treinados para o diretório servido pelo DSpeak somente quando
// qualidade, desempenho, matriz de aparelhos e licenças foram aprovados.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_PLATFORMS = [
  'windows-amd',
  'windows-intel',
  'windows-nvidia',
  'chrome',
  'edge',
  'firefox',
  'android-entry',
  'android-mid'
];
const POSTFILTER_FILES = [
  path.join('postfilter', 'v3', 'pkg', 'df_bg.wasm'),
  path.join('postfilter', 'v3', 'models', 'DeepFilterNet3_onnx.tar.gz'),
  path.join('postfilter', 'LICENSES.json')
];

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function modelFileName(descriptor) {
  const raw = String(descriptor && (descriptor.file || descriptor.url) || '')
    .replace(/^[.][/\\]/, '');
  if (!raw || path.isAbsolute(raw) || raw.includes('..')) {
    throw new Error(`Caminho de modelo inválido: ${raw || '(vazio)'}`);
  }
  return raw;
}

function validateReport(report) {
  const failures = [];
  const q = report.quality || {};
  const r = report.runtime || {};
  const legal = report.legal || {};
  if (!(q.siSdrImprovementDb >= 10)) failures.push('SI-SDRi precisa ser >= 10 dB');
  if (!(q.targetStoi >= 0.90)) failures.push('STOI da voz-alvo precisa ser >= 0,90');
  if (!(q.speakerSwitches === 0)) failures.push('não pode haver troca indevida de locutor');
  if (!(r.frameP95Ms <= 5)) failures.push('p95 por frame precisa ser <= 5 ms');
  if (!(r.latencyP95Ms <= 60)) failures.push('latência adicional p95 precisa ser <= 60 ms');
  if (!(r.realtimeFactor <= 0.25)) failures.push('RTF precisa ser <= 0,25');
  for (const platform of REQUIRED_PLATFORMS) {
    if (!report.platforms || report.platforms[platform] !== true) {
      failures.push(`plataforma não aprovada: ${platform}`);
    }
  }
  if (legal.datasetsApproved !== true) failures.push('licenças dos datasets não aprovadas');
  if (legal.weightsOwned !== true) failures.push('propriedade/permissão dos pesos não aprovada');
  if (!String(report.approvedBy || '').trim()) failures.push('approvedBy obrigatório');
  if (failures.length) throw new Error(failures.join('; '));
  return true;
}

function validateManifest(sourceDir, manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.models) {
    throw new Error('manifest.json inválido ou incompatível');
  }
  for (const key of ['encoder', 'extractor']) {
    const descriptor = manifest.models[key];
    const name = modelFileName(descriptor);
    const file = path.join(sourceDir, name);
    if (!fs.existsSync(file)) throw new Error(`modelo ausente: ${name}`);
    if (!descriptor.sha256) throw new Error(`hash ausente no manifest: ${key}`);
    const actual = sha256(file);
    if (actual !== descriptor.sha256) throw new Error(`hash divergente: ${name}`);
  }
  for (const relative of POSTFILTER_FILES) {
    if (!fs.existsSync(path.join(sourceDir, relative))) {
      throw new Error(`pós-filtro ausente: ${relative}`);
    }
  }
  return true;
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') result.dryRun = true;
    else if (arg.startsWith('--')) result[arg.slice(2)] = argv[++i];
  }
  if (!result.source || !result.target || !result.report) {
    throw new Error('Uso: --source DIR --target DIR --report release-report.json [--dry-run]');
  }
  return result;
}

function promote({ source, target, report: reportFile, dryRun = false }) {
  const sourceDir = path.resolve(source);
  const targetDir = path.resolve(target);
  const manifestFile = path.join(sourceDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const report = JSON.parse(fs.readFileSync(path.resolve(reportFile), 'utf8'));
  validateManifest(sourceDir, manifest);
  validateReport(report);

  const releaseManifest = {
    ...manifest,
    productionReady: true,
    release: {
      approvedAt: new Date().toISOString(),
      approvedBy: String(report.approvedBy),
      reportSha256: sha256(path.resolve(reportFile))
    }
  };
  if (dryRun) return releaseManifest;

  const staging = `${targetDir}.staging-${process.pid}`;
  const backup = `${targetDir}.backup-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const key of ['encoder', 'extractor']) {
    const name = modelFileName(manifest.models[key]);
    fs.copyFileSync(path.join(sourceDir, name), path.join(staging, name));
  }
  fs.cpSync(path.join(sourceDir, 'postfilter'), path.join(staging, 'postfilter'), {
    recursive: true
  });
  fs.writeFileSync(
    path.join(staging, 'manifest.json'),
    JSON.stringify(releaseManifest, null, 2) + '\n'
  );

  if (fs.existsSync(targetDir)) fs.renameSync(targetDir, backup);
  try {
    fs.renameSync(staging, targetDir);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(backup) && !fs.existsSync(targetDir)) fs.renameSync(backup, targetDir);
    throw error;
  }
  return releaseManifest;
}

if (require.main === module) {
  try {
    const result = promote(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({
      ok: true,
      version: result.modelVersion,
      productionReady: result.productionReady
    }));
  } catch (error) {
    console.error('[VoiceLock promote]', error.message);
    process.exitCode = 1;
  }
}

module.exports = { REQUIRED_PLATFORMS, validateReport, validateManifest, promote };
