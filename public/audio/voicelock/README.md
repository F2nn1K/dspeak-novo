# VoiceLock ONNX no navegador

Runtime ES Modules sem bundler para navegador, Electron renderer e Android
WebView moderno. A inferência roda no thread principal; o AudioWorklet apenas
transporta frames entre Web Audio e `VoiceLockEngine`.

## Assets esperados

O runtime não incorpora modelos nem binários do ONNX Runtime. O servidor deve
expor:

- `/vendor/onnxruntime-web/ort.webgpu.min.mjs` para WebGPU (opcional);
- `/vendor/onnxruntime-web/ort.min.mjs` para wasm;
- os arquivos `.wasm` da mesma versão no mesmo diretório;
- `/models/voicelock/manifest.json`;
- os dois modelos `.onnx` apontados pelo manifest.

As variantes `.js` do ONNX Runtime também são tentadas como compatibilidade.
WebGPU é usado quando há um adapter e as duas sessões abrem corretamente. Em
qualquer falha de criação das sessões, o engine recria ambas com wasm.
No modo `auto`, o manifest decide a preferência. Modelos pequenos devem
preferir `wasm`, pois o custo de despachar cada frame para a GPU pode ser maior
que a própria inferência.

Assets ausentes geram `VoiceLockError` com códigos previsíveis, por exemplo
`MANIFEST_UNAVAILABLE`, `MODEL_ASSET_UNAVAILABLE` e
`ORT_ASSET_UNAVAILABLE`; não há falha silenciosa.

## Manifest

Schema mínimo de `/models/voicelock/manifest.json`:

```json
{
  "schemaVersion": 1,
  "modelVersion": "2026-09-03",
  "runtime": {
    "inputSampleRate": 48000,
    "modelSampleRate": 16000,
    "frameSamples": 320,
    "enrollmentSeconds": 4,
    "embeddingSize": 128,
    "stateShape": [2, 1, 96],
    "preferredBackend": "wasm"
  },
  "models": {
    "encoder": {
      "url": "./encoder.onnx",
      "inputs": {
        "audio": {
          "name": "audio",
          "shape": [1, 64000]
        },
        "lengths": {
          "name": "lengths",
          "shape": [1],
          "type": "float32",
          "value": 1
        }
      },
      "outputs": {
        "embedding": "embedding"
      }
    },
    "extractor": {
      "url": "./extractor.onnx",
      "inputs": {
        "audio": {
          "name": "audio",
          "shape": [1, 320]
        },
        "embedding": {
          "name": "embedding",
          "shape": [1, 128]
        },
        "state": {
          "name": "state",
          "shape": [2, 1, 96]
        }
      },
      "outputs": {
        "audio": "enhanced",
        "state": "state_out"
      }
    }
  }
}
```

`encoder.inputs.lengths` é opcional. Quando presente, aceita `float32`,
`int32` ou `int64`. O `value` padrão é `1` para `float32` e `64000` para
inteiros. Shapes de áudio podem variar na quantidade de dimensões, mas precisam
conter exatamente a quantidade de elementos exigida. O estado segue
`[camadas, 1, dimensão]` e o tensor do extractor deve coincidir com o manifest.

URLs relativas dos modelos são resolvidas em relação ao próprio manifest.

## Uso direto

```js
import VoiceLockEngine from "/audio/voicelock/voicelock-engine.js";

const engine = new VoiceLockEngine();

engine.addEventListener("metrics", ({ detail }) => {
  // detail contém somente latências, backend e contadores; nunca áudio.
  telemetry.record(detail);
});

engine.addEventListener("error", ({ detail }) => {
  console.error(detail.code, detail.message);
});

await engine.initialize();

// Float32Array mono a 48 kHz. Os primeiros 4 segundos são usados.
await engine.enroll(referenceAudio48k);

// Pode ter qualquer tamanho. O retorno tem o mesmo número de amostras.
const enhanced48k = await engine.processFrame(inputAudio48k);

// Limpa rings, resamplers e state ONNX, preservando o enrollment.
await engine.reset();

await engine.dispose();
```

`enroll()` exige no mínimo `192000` amostras (4 s a 48 kHz), converte para
`64000` amostras a 16 kHz e valida um embedding de 128 elementos.
`processFrame()` serializa chamadas concorrentes, acumula áudio em ring buffer
e executa o extractor em blocos declarados no manifest: 160 amostras (10 ms)
ou 320 amostras (20 ms) a 16 kHz. O início da
saída contém silêncio até o primeiro bloco ficar pronto.

## AudioWorklet

O `AudioContext` precisa operar a 48 kHz:

```js
const context = new AudioContext({ sampleRate: 48000 });
await context.audioWorklet.addModule(
  "/audio/voicelock/voicelock-worklet.js",
);

const node = new AudioWorkletNode(context, "voicelock-processor", {
  numberOfInputs: 1,
  numberOfOutputs: 1,
  outputChannelCount: [1],
  processorOptions: { maxInFlightFrames: 8 },
});

node.port.onmessage = async ({ data }) => {
  if (data.type === "voicelock-input") {
    try {
      const samples = await engine.processFrame(data.samples);
      node.port.postMessage(
        {
          type: "voicelock-output",
          sequence: data.sequence,
          samples,
        },
        [samples.buffer],
      );
    } catch (error) {
      node.port.postMessage({
        type: "voicelock-output-error",
        sequence: data.sequence,
        code: error.code ?? "PROCESSING_FAILED",
      });
    }
  } else if (data.type === "voicelock-worklet-metrics") {
    // Somente contadores e latência de ida e volta, sem payload de áudio.
    telemetry.record(data);
  }
};

const source = context.createMediaStreamSource(microphoneStream);
source.connect(node).connect(context.destination);
```

O worklet envia frames de 480 ou 960 amostras a 48 kHz, conforme o manifest,
mantém a ordem das
respostas e limita frames em voo. Se o thread de inferência atrasar além do
limite, ele insere silêncio em vez de acumular memória sem limite.

## Pós-filtro Hush

Depois do TSE, o DSpeak conecta a saída ao Hush no próprio AudioWorklet. O
núcleo JS/WASM é carregado de `vendor/deepfilter-core.js`; o WASM e o modelo
Hush são publicados em `/models/voicelock/postfilter/`.

Prepare os artefatos reproduzíveis com:

```sh
npm run voicelock:prepare-postfilter
```

O script fixa a revisão do modelo e recusa qualquer download cujo SHA-256
divirja. Os arquivos pesados ficam fora do Git e só são promovidos junto com
pesos VoiceLock aprovados.

## Ambiente

- WebGPU requer contexto seguro (`https` ou `localhost`). Sem ele, wasm é usado.
- Sem `crossOriginIsolated`, wasm usa uma thread. Com isolamento, usa até quatro.
- Electron e Android WebView devem permitir ES Modules, `fetch`, WebAssembly e
  servir todos os assets pela mesma origem. Uma página `file://` deve fornecer
  URLs customizadas e uma implementação de `fetch` compatível.
- É possível forçar wasm com `new VoiceLockEngine({ backend: "wasm" })`.
- Para testes/injeção, `ort`, `fetch`, `manifestUrl`, `ortBaseUrl`,
  `ortModuleUrls` e `sessionOptions` podem ser fornecidos no construtor.

## Testes

Os testes são JavaScript puro e não requerem dependências:

```sh
node --test public/audio/voicelock/ring-buffer.test.mjs public/audio/voicelock/resampler.test.mjs
```
