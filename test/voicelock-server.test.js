const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readManifest, hasHushPostFilter } = require('../voicelock-server');

test('readManifest só habilita manifesto com os dois modelos presentes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dspeak-voicelock-'));
  try {
    const manifest = {
      version: 'test-1',
      encoder: { file: 'encoder.onnx' },
      extractor: { file: 'extractor.onnx' }
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    assert.equal(readManifest(dir), null);

    fs.writeFileSync(path.join(dir, 'encoder.onnx'), 'encoder');
    assert.equal(readManifest(dir), null);

    fs.writeFileSync(path.join(dir, 'extractor.onnx'), 'extractor');
    assert.equal(readManifest(dir).version, 'test-1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readManifest rejeita JSON inválido', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dspeak-voicelock-'));
  try {
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{');
    assert.equal(readManifest(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readManifest aceita schema do runtime browser', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dspeak-voicelock-'));
  try {
    fs.writeFileSync(path.join(dir, 'encoder.onnx'), 'encoder');
    fs.writeFileSync(path.join(dir, 'extractor.onnx'), 'extractor');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      modelVersion: 'browser-1',
      models: {
        encoder: { url: './encoder.onnx' },
        extractor: { url: './extractor.onnx' }
      }
    }));
    assert.equal(readManifest(dir).modelVersion, 'browser-1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Hush só fica disponível com WASM e modelo presentes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dspeak-voicelock-'));
  try {
    const wasm = path.join(dir, 'postfilter', 'v3', 'pkg', 'df_bg.wasm');
    const model = path.join(
      dir,
      'postfilter',
      'v3',
      'models',
      'DeepFilterNet3_onnx.tar.gz'
    );
    fs.mkdirSync(path.dirname(wasm), { recursive: true });
    fs.mkdirSync(path.dirname(model), { recursive: true });
    assert.equal(hasHushPostFilter(dir), false);
    fs.writeFileSync(wasm, 'wasm');
    assert.equal(hasHushPostFilter(dir), false);
    fs.writeFileSync(model, 'model');
    assert.equal(hasHushPostFilter(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
