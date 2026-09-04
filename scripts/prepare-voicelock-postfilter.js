#!/usr/bin/env node
// Baixa os artefatos reproduzíveis do pós-filtro aprovado no teste auditivo.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const ASSETS = [
  {
    relative: path.join('v3', 'pkg', 'df_bg.wasm'),
    url: 'https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3/v3/pkg/df_bg.wasm',
    sha256: '440b5d12b6ea7d95008736f844221d7874ee15de5cb10d3015002470fdba0432',
    license: 'MIT OR Apache-2.0',
    project: 'mezonai/mezon-noise-suppression'
  },
  {
    relative: path.join('v3', 'models', 'DeepFilterNet3_onnx.tar.gz'),
    url: 'https://huggingface.co/weya-ai/hush/resolve/a55d932cbf6344d284ac985f21e7f6e5bc4d38a5/onnx/advanced_dfnet16k_model_best_onnx.tar.gz',
    sha256: '45632ccaa82b71bb743d6caa7c78e983fe2f2790a3af7f6ec48e6ed7ba085df6',
    license: 'Apache-2.0',
    project: 'weya-ai/hush'
  }
];

function digest(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function download(asset, root) {
  const destination = path.join(root, asset.relative);
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`${asset.project}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const actual = digest(data);
  if (actual !== asset.sha256) {
    throw new Error(`${asset.project}: hash divergente (${actual})`);
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, data);
  console.log(`${asset.project}: ${data.length} bytes verificados`);
}

async function main() {
  const argIndex = process.argv.indexOf('--target');
  const root = path.resolve(
    argIndex >= 0 ? process.argv[argIndex + 1] : 'voicelock-models/postfilter'
  );
  for (const asset of ASSETS) await download(asset, root);
  await fs.writeFile(
    path.join(root, 'LICENSES.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), assets: ASSETS }, null, 2) + '\n'
  );
}

main().catch((error) => {
  console.error('[VoiceLock postfilter]', error.message);
  process.exitCode = 1;
});
