import {
  Float32RingBuffer,
  Resampler16To48,
  Resampler48To16,
  VOICELOCK_INPUT_SAMPLE_RATE,
  VOICELOCK_MODEL_SAMPLE_RATE,
  resample48To16,
} from "./resampler.js";

const DEFAULT_FRAME_SAMPLES_16K = 160;
const ENROLLMENT_SECONDS = 4;
const ENROLLMENT_SAMPLES_16K =
  VOICELOCK_MODEL_SAMPLE_RATE * ENROLLMENT_SECONDS;
const EMBEDDING_SIZE = 128;
const DEFAULT_STATE_SHAPE = Object.freeze([2, 1, 128]);

const DEFAULT_OPTIONS = Object.freeze({
  manifestUrl: "/models/voicelock/manifest.json",
  ortBaseUrl: "/vendor/onnxruntime-web/",
  backend: "auto",
});

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shapeSize(shape) {
  return shape.reduce((total, dimension) => total * dimension, 1);
}

function sameShape(left, right) {
  return (
    left.length === right.length &&
    left.every((dimension, index) => dimension === right[index])
  );
}

function assertShape(value, fallback, expectedSize, label) {
  const shape = value ?? fallback;
  if (
    !Array.isArray(shape) ||
    shape.length === 0 ||
    shape.some((dimension) => !Number.isInteger(dimension) || dimension <= 0)
  ) {
    throw new VoiceLockError(
      "INVALID_MANIFEST",
      `${label} deve ser um array de dimensões inteiras positivas.`,
    );
  }
  if (shapeSize(shape) !== expectedSize) {
    throw new VoiceLockError(
      "UNSUPPORTED_MANIFEST",
      `${label} deve conter ${expectedSize} elementos.`,
    );
  }
  return Object.freeze([...shape]);
}

function assertRuntimeValue(value, expected, label) {
  const actual = value ?? expected;
  if (actual !== expected) {
    throw new VoiceLockError(
      "UNSUPPORTED_MANIFEST",
      `${label}=${actual} não é suportado; o runtime requer ${expected}.`,
    );
  }
  return actual;
}

function parseStateShape(value) {
  const shape = value ?? DEFAULT_STATE_SHAPE;
  if (
    !Array.isArray(shape) ||
    shape.length !== 3 ||
    shape.some((dimension) => !Number.isInteger(dimension) || dimension <= 0) ||
    shape[1] !== 1
  ) {
    throw new VoiceLockError(
      "UNSUPPORTED_MANIFEST",
      "runtime.stateShape deve ter formato [camadas, 1, dimensão].",
    );
  }
  return Object.freeze([...shape]);
}

function parseInputDescriptor(
  value,
  fallbackShape,
  expectedSize,
  label,
  { optional = false, allowedTypes = ["float32"] } = {},
) {
  if (value === undefined && optional) {
    return null;
  }

  const descriptor =
    typeof value === "string"
      ? { name: value }
      : isObject(value)
        ? value
        : null;
  if (!descriptor || typeof descriptor.name !== "string" || !descriptor.name) {
    throw new VoiceLockError(
      "INVALID_MANIFEST",
      `${label} deve informar um nome de tensor.`,
    );
  }

  const type = descriptor.type ?? "float32";
  if (!allowedTypes.includes(type)) {
    throw new VoiceLockError(
      "UNSUPPORTED_MANIFEST",
      `${label}.type=${type} não é suportado.`,
    );
  }

  return Object.freeze({
    name: descriptor.name,
    type,
    shape: assertShape(
      descriptor.shape,
      fallbackShape,
      expectedSize,
      `${label}.shape`,
    ),
    value: descriptor.value,
  });
}

function parseOutputDescriptor(value, label) {
  const name = typeof value === "string" ? value : value?.name;
  if (typeof name !== "string" || !name) {
    throw new VoiceLockError(
      "INVALID_MANIFEST",
      `${label} deve informar um nome de tensor.`,
    );
  }
  return Object.freeze({ name });
}

function resolveAssetUrl(value, baseUrl, label, sha256) {
  if (typeof value !== "string" || !value) {
    throw new VoiceLockError(
      "INVALID_MANIFEST",
      `${label} deve informar a URL do modelo.`,
    );
  }
  try {
    const url = new URL(value, baseUrl);
    // Os modelos são servidos como immutable. O hash no URL impede que uma
    // versão nova reutilize o ONNX antigo do cache do navegador.
    if (typeof sha256 === "string" && sha256) {
      url.searchParams.set("v", sha256.slice(0, 16));
    }
    return url.href;
  } catch (cause) {
    throw new VoiceLockError(
      "INVALID_MANIFEST",
      `${label} contém uma URL inválida.`,
      { cause },
    );
  }
}

function parseManifest(rawManifest, manifestUrl) {
  if (!isObject(rawManifest)) {
    throw new VoiceLockError(
      "INVALID_MANIFEST",
      "O manifest VoiceLock deve ser um objeto JSON.",
    );
  }
  if (rawManifest.schemaVersion !== 1) {
    throw new VoiceLockError(
      "UNSUPPORTED_MANIFEST",
      "O runtime aceita somente schemaVersion 1.",
    );
  }

  const runtime = rawManifest.runtime ?? {};
  if (!isObject(runtime)) {
    throw new VoiceLockError(
      "INVALID_MANIFEST",
      "runtime deve ser um objeto.",
    );
  }

  assertRuntimeValue(
    runtime.inputSampleRate,
    VOICELOCK_INPUT_SAMPLE_RATE,
    "runtime.inputSampleRate",
  );
  assertRuntimeValue(
    runtime.modelSampleRate,
    VOICELOCK_MODEL_SAMPLE_RATE,
    "runtime.modelSampleRate",
  );
  const frameSamples = runtime.frameSamples ?? DEFAULT_FRAME_SAMPLES_16K;
  if (![160, 320].includes(frameSamples)) {
    throw new VoiceLockError(
      "UNSUPPORTED_MANIFEST",
      "runtime.frameSamples deve ser 160 (10 ms) ou 320 (20 ms).",
    );
  }
  assertRuntimeValue(
    runtime.enrollmentSeconds,
    ENROLLMENT_SECONDS,
    "runtime.enrollmentSeconds",
  );
  assertRuntimeValue(
    runtime.embeddingSize,
    EMBEDDING_SIZE,
    "runtime.embeddingSize",
  );

  const stateShape = parseStateShape(runtime.stateShape);
  const stateSize = shapeSize(stateShape);

  const models = rawManifest.models;
  if (!isObject(models) || !isObject(models.encoder) || !isObject(models.extractor)) {
    throw new VoiceLockError(
      "INVALID_MANIFEST",
      "models.encoder e models.extractor são obrigatórios.",
    );
  }

  const encoder = models.encoder;
  const extractor = models.extractor;
  if (!isObject(encoder.inputs) || !isObject(encoder.outputs)) {
    throw new VoiceLockError(
      "INVALID_MANIFEST",
      "models.encoder.inputs e models.encoder.outputs são obrigatórios.",
    );
  }
  if (!isObject(extractor.inputs) || !isObject(extractor.outputs)) {
    throw new VoiceLockError(
      "INVALID_MANIFEST",
      "models.extractor.inputs e models.extractor.outputs são obrigatórios.",
    );
  }

  const parsedEncoder = Object.freeze({
    url: resolveAssetUrl(
      encoder.url,
      manifestUrl,
      "models.encoder.url",
      encoder.sha256,
    ),
    inputs: Object.freeze({
      audio: parseInputDescriptor(
        encoder.inputs.audio,
        [1, ENROLLMENT_SAMPLES_16K],
        ENROLLMENT_SAMPLES_16K,
        "models.encoder.inputs.audio",
      ),
      lengths: parseInputDescriptor(
        encoder.inputs.lengths,
        [1],
        1,
        "models.encoder.inputs.lengths",
        {
          optional: true,
          allowedTypes: ["float32", "int32", "int64"],
        },
      ),
    }),
    outputs: Object.freeze({
      embedding: parseOutputDescriptor(
        encoder.outputs.embedding,
        "models.encoder.outputs.embedding",
      ),
    }),
  });

  const parsedExtractor = Object.freeze({
    url: resolveAssetUrl(
      extractor.url,
      manifestUrl,
      "models.extractor.url",
      extractor.sha256,
    ),
    inputs: Object.freeze({
      audio: parseInputDescriptor(
        extractor.inputs.audio,
        [1, frameSamples],
        frameSamples,
        "models.extractor.inputs.audio",
      ),
      embedding: parseInputDescriptor(
        extractor.inputs.embedding,
        [1, EMBEDDING_SIZE],
        EMBEDDING_SIZE,
        "models.extractor.inputs.embedding",
      ),
      state: parseInputDescriptor(
        extractor.inputs.state,
        stateShape,
        stateSize,
        "models.extractor.inputs.state",
      ),
    }),
    outputs: Object.freeze({
      audio: parseOutputDescriptor(
        extractor.outputs.audio,
        "models.extractor.outputs.audio",
      ),
      state: parseOutputDescriptor(
        extractor.outputs.state,
        "models.extractor.outputs.state",
      ),
    }),
  });

  if (!sameShape(parsedExtractor.inputs.state.shape, stateShape)) {
    throw new VoiceLockError(
      "UNSUPPORTED_MANIFEST",
      "O tensor de estado do extractor diverge de runtime.stateShape.",
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    modelVersion:
      typeof rawManifest.modelVersion === "string"
        ? rawManifest.modelVersion
        : "desconhecida",
    preferredBackend:
      runtime.preferredBackend === "webgpu" ? "webgpu" : "wasm",
    frameSamples,
    stateShape,
    stateSize,
    encoder: parsedEncoder,
    extractor: parsedExtractor,
  });
}

function makeEvent(type, detail) {
  if (typeof CustomEvent === "function") {
    return new CustomEvent(type, { detail });
  }
  const event = new Event(type);
  Object.defineProperty(event, "detail", { value: detail });
  return event;
}

function validateFloat32Audio(value, label, { allowEmpty = false } = {}) {
  if (!(value instanceof Float32Array)) {
    throw new VoiceLockError(
      "INVALID_AUDIO",
      `${label} deve ser um Float32Array mono a 48 kHz.`,
    );
  }
  if (!allowEmpty && value.length === 0) {
    throw new VoiceLockError("INVALID_AUDIO", `${label} não pode ser vazio.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Number.isFinite(value[index])) {
      throw new VoiceLockError(
        "INVALID_AUDIO",
        `${label} contém uma amostra não finita.`,
      );
    }
  }
}

function normalizeOrtModule(importedModule) {
  const candidates = [
    importedModule,
    importedModule?.default,
    importedModule?.ort,
    globalThis.ort,
  ];
  return candidates.find(
    (candidate) => candidate?.InferenceSession && candidate?.Tensor,
  );
}

async function releaseSession(session) {
  if (!session) {
    return;
  }
  if (typeof session.release === "function") {
    await session.release();
  } else if (typeof session.dispose === "function") {
    await session.dispose();
  }
}

async function readFloatTensor(tensor, label, expectedSize) {
  if (!tensor) {
    throw new VoiceLockError(
      "INVALID_MODEL_OUTPUT",
      `O modelo não retornou ${label}.`,
    );
  }

  let data;
  try {
    data = tensor.data;
  } catch {
    data = undefined;
  }
  if (data === undefined && typeof tensor.getData === "function") {
    data = await tensor.getData();
  }
  if (!data || typeof data.length !== "number") {
    throw new VoiceLockError(
      "INVALID_MODEL_OUTPUT",
      `${label} não contém dados acessíveis na CPU.`,
    );
  }
  if (data.length !== expectedSize) {
    throw new VoiceLockError(
      "INVALID_MODEL_OUTPUT",
      `${label} retornou ${data.length} elementos; eram esperados ${expectedSize}.`,
    );
  }

  const result =
    data instanceof Float32Array ? new Float32Array(data) : Float32Array.from(data);
  for (let index = 0; index < result.length; index += 1) {
    if (!Number.isFinite(result[index])) {
      result.fill(0);
      throw new VoiceLockError(
        "INVALID_MODEL_OUTPUT",
        `${label} contém valores não finitos.`,
      );
    }
  }
  return result;
}

export class VoiceLockError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message);
    this.name = "VoiceLockError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * Runtime causal do VoiceLock.
 *
 * Eventos:
 * - "metrics": somente tempos, contadores e estado do backend; nunca áudio.
 * - "error": { code, message }; nunca áudio ou tensores.
 */
export class VoiceLockEngine extends EventTarget {
  constructor(options = {}) {
    super();
    if (!isObject(options)) {
      throw new TypeError("options deve ser um objeto.");
    }

    const backend = options.backend ?? DEFAULT_OPTIONS.backend;
    if (!["auto", "webgpu", "wasm"].includes(backend)) {
      throw new RangeError('backend deve ser "auto", "webgpu" ou "wasm".');
    }

    this._options = {
      ...DEFAULT_OPTIONS,
      ...options,
      backend,
      sessionOptions: { ...(options.sessionOptions ?? {}) },
    };
    this._fetch =
      options.fetch ??
      (typeof globalThis.fetch === "function"
        ? globalThis.fetch.bind(globalThis)
        : null);

    this._status = "new";
    this._backend = null;
    this._manifest = null;
    this._ort = options.ort ?? null;
    this._encoderSession = null;
    this._extractorSession = null;
    this._embedding = null;
    this._state = new Float32Array(1);
    this._inputRing = new Float32RingBuffer(DEFAULT_FRAME_SAMPLES_16K * 4);
    this._outputRing = new Float32RingBuffer(DEFAULT_FRAME_SAMPLES_16K * 3 * 4);
    this._downsampler = new Resampler48To16();
    this._upsampler = new Resampler16To48();
    this._queue = Promise.resolve();
    this._initializationPromise = null;
    this._disposePromise = null;
    this._disposeRequested = false;

    this.onmetrics = null;
    this.onerror = null;
  }

  get status() {
    return this._status;
  }

  get backend() {
    return this._backend;
  }

  get isEnrolled() {
    return this._embedding !== null;
  }

  get frameSamples48k() {
    return (this._manifest?.frameSamples ?? DEFAULT_FRAME_SAMPLES_16K) * 3;
  }

  async initialize() {
    this._assertNotDisposed();
    if (this._status === "ready") {
      return this;
    }
    if (this._initializationPromise) {
      return this._initializationPromise;
    }

    this._status = "initializing";
    const startedAt = now();
    const initialization = this._initializeInternal(startedAt)
      .then(() => this)
      .catch((error) => {
        const controlled =
          error instanceof VoiceLockError
            ? error
            : new VoiceLockError(
                "INITIALIZATION_FAILED",
                "Não foi possível inicializar o VoiceLock.",
                { cause: error },
              );
        this._status = "error";
        this._emitError(controlled);
        throw controlled;
      })
      .finally(() => {
        this._initializationPromise = null;
      });
    this._initializationPromise = initialization;
    return initialization;
  }

  enroll(audio48k) {
    this._assertReady();
    validateFloat32Audio(audio48k, "audio48k");
    const requiredSamples =
      VOICELOCK_INPUT_SAMPLE_RATE * ENROLLMENT_SECONDS;
    if (audio48k.length < requiredSamples) {
      throw new VoiceLockError(
        "ENROLLMENT_TOO_SHORT",
        `O enrollment requer 4 segundos (${requiredSamples} amostras a 48 kHz).`,
      );
    }

    // Copia antes de entrar na fila para impedir mutação pelo chamador.
    const enrollment = audio48k.slice(0, requiredSamples);
    return this._enqueue(async () => {
      const startedAt = now();
      const resampleStartedAt = now();
      const audio16k = resample48To16(enrollment);
      const resampleMs = now() - resampleStartedAt;

      const feeds = {};
      const audioInput = this._manifest.encoder.inputs.audio;
      feeds[audioInput.name] = new this._ort.Tensor(
        audioInput.type,
        audio16k,
        audioInput.shape,
      );

      const lengthsInput = this._manifest.encoder.inputs.lengths;
      if (lengthsInput) {
        feeds[lengthsInput.name] = this._makeLengthsTensor(lengthsInput);
      }

      let outputs;
      const inferenceStartedAt = now();
      try {
        outputs = await this._encoderSession.run(feeds);
      } catch (cause) {
        throw new VoiceLockError(
          "ENCODER_INFERENCE_FAILED",
          "O encoder ONNX falhou durante o enrollment.",
          { cause },
        );
      }
      const inferenceMs = now() - inferenceStartedAt;
      const embedding = await readFloatTensor(
        outputs[this._manifest.encoder.outputs.embedding.name],
        "o embedding do encoder",
        EMBEDDING_SIZE,
      );

      this._embedding?.fill(0);
      this._embedding = embedding;
      this._resetStreamState();
      enrollment.fill(0);
      audio16k.fill(0);

      this._emitMetric({
        operation: "enroll",
        totalMs: now() - startedAt,
        resampleMs,
        inferenceMs,
        durationMs: ENROLLMENT_SECONDS * 1_000,
        embeddingSize: EMBEDDING_SIZE,
      });
      return Object.freeze({
        durationSeconds: ENROLLMENT_SECONDS,
        embeddingSize: EMBEDDING_SIZE,
        backend: this._backend,
      });
    }).catch((error) => {
      enrollment.fill(0);
      const controlled =
        error instanceof VoiceLockError
          ? error
          : new VoiceLockError(
              "ENROLLMENT_FAILED",
              "Não foi possível concluir o enrollment.",
              { cause: error },
            );
      this._emitError(controlled);
      throw controlled;
    });
  }

  processFrame(audio48k) {
    this._assertReady();
    if (!this._embedding) {
      throw new VoiceLockError(
        "NOT_ENROLLED",
        "Execute enroll() antes de processFrame().",
      );
    }
    validateFloat32Audio(audio48k, "audio48k", { allowEmpty: true });
    const input = new Float32Array(audio48k);

    return this._enqueue(() => this._processFrameInternal(input)).catch(
      (error) => {
        input.fill(0);
        const controlled =
          error instanceof VoiceLockError
            ? error
            : new VoiceLockError(
                "PROCESSING_FAILED",
                "Não foi possível processar o frame VoiceLock.",
                { cause: error },
              );
        this._emitError(controlled);
        throw controlled;
      },
    );
  }

  reset() {
    this._assertNotDisposed();
    return this._enqueue(async () => {
      this._resetStreamState();
      this._emitMetric({
        operation: "reset",
        totalMs: 0,
        enrollmentPreserved: this._embedding !== null,
      });
    });
  }

  dispose() {
    if (this._disposePromise) {
      return this._disposePromise;
    }
    if (this._status === "disposed") {
      return Promise.resolve();
    }

    this._disposeRequested = true;
    this._status = "disposing";
    const initialization = this._initializationPromise?.catch(() => undefined);
    this._disposePromise = Promise.all([this._queue, initialization])
      .then(async () => {
        await Promise.all([
          releaseSession(this._encoderSession),
          releaseSession(this._extractorSession),
        ]);
        this._encoderSession = null;
        this._extractorSession = null;
        this._embedding?.fill(0);
        this._embedding = null;
        this._state.fill(0);
        this._inputRing.clear({ zero: true });
        this._outputRing.clear({ zero: true });
        this._manifest = null;
        this._ort = null;
        this._backend = null;
        this._status = "disposed";
      })
      .catch((cause) => {
        this._status = "disposed";
        const error = new VoiceLockError(
          "DISPOSE_FAILED",
          "O VoiceLock foi encerrado, mas uma sessão ONNX não liberou corretamente.",
          { cause },
        );
        this._emitError(error);
        throw error;
      });
    return this._disposePromise;
  }

  async _initializeInternal(startedAt) {
    if (!this._fetch) {
      throw new VoiceLockError(
        "FETCH_UNAVAILABLE",
        "Este ambiente não oferece fetch(); forneça options.fetch.",
      );
    }

    const { manifest, manifestUrl } = await this._loadManifest();
    this._manifest = manifest;
    this._state = new Float32Array(manifest.stateSize);
    this._inputRing = new Float32RingBuffer(manifest.frameSamples * 4);
    this._outputRing = new Float32RingBuffer(manifest.frameSamples * 3 * 4);
    const shouldTryWebGpu =
      this._options.backend === "webgpu" ||
      (this._options.backend === "auto" &&
        manifest.preferredBackend === "webgpu");
    const webGpuAvailable = shouldTryWebGpu && await this._hasWebGpu();

    const [ort, binaries] = await Promise.all([
      this._loadOrt(webGpuAvailable),
      Promise.all([
        this._fetchModel(manifest.encoder.url, "encoder"),
        this._fetchModel(manifest.extractor.url, "extractor"),
      ]),
    ]);
    this._ort = ort;

    let fallback = false;
    if (webGpuAvailable && this._options.backend !== "wasm") {
      try {
        await this._createSessions(binaries, "webgpu");
        this._backend = "webgpu";
      } catch {
        fallback = true;
        await this._releaseSessions();
      }
    }

    if (!this._backend) {
      try {
        await this._createSessions(binaries, "wasm");
        this._backend = "wasm";
      } catch (cause) {
        await this._releaseSessions();
        throw new VoiceLockError(
          "SESSION_INITIALIZATION_FAILED",
          "Os modelos ONNX não puderam ser abertos com WebGPU nem com wasm.",
          { cause },
        );
      }
    }

    try {
      this._validateSessionContract(
        this._encoderSession,
        manifest.encoder,
        "encoder",
      );
      this._validateSessionContract(
        this._extractorSession,
        manifest.extractor,
        "extractor",
      );
    } catch (error) {
      await this._releaseSessions();
      this._backend = null;
      throw error;
    }
    this._resetStreamState();
    this._status = "ready";

    this._emitMetric({
      operation: "initialize",
      totalMs: now() - startedAt,
      backend: this._backend,
      webGpuAvailable,
      fallback,
      modelVersion: manifest.modelVersion,
      manifestOrigin: new URL(manifestUrl).origin,
    });
  }

  async _loadManifest() {
    let response;
    try {
      response = await this._fetch(this._options.manifestUrl, {
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch (cause) {
      throw new VoiceLockError(
        "MANIFEST_UNAVAILABLE",
        `Não foi possível carregar ${this._options.manifestUrl}.`,
        { cause },
      );
    }
    if (!response?.ok) {
      throw new VoiceLockError(
        "MANIFEST_UNAVAILABLE",
        `Manifest VoiceLock ausente ou inacessível (HTTP ${response?.status ?? "desconhecido"}).`,
      );
    }

    let rawManifest;
    try {
      rawManifest = await response.json();
    } catch (cause) {
      throw new VoiceLockError(
        "INVALID_MANIFEST",
        "O manifest VoiceLock não contém JSON válido.",
        { cause },
      );
    }

    let manifestUrl;
    try {
      manifestUrl =
        response.url ||
        new URL(this._options.manifestUrl, globalThis.location?.href).href;
    } catch (cause) {
      throw new VoiceLockError(
        "INVALID_MANIFEST",
        "Não foi possível resolver a URL do manifest VoiceLock.",
        { cause },
      );
    }
    return {
      manifest: parseManifest(rawManifest, manifestUrl),
      manifestUrl,
    };
  }

  async _loadOrt(preferWebGpu) {
    if (this._ort?.InferenceSession && this._ort?.Tensor) {
      this._configureOrt(this._ort);
      return this._ort;
    }

    const base = this._options.ortBaseUrl.endsWith("/")
      ? this._options.ortBaseUrl
      : `${this._options.ortBaseUrl}/`;
    const moduleUrls =
      this._options.ortModuleUrls ??
      (preferWebGpu
        ? [
            `${base}ort.webgpu.min.mjs`,
            `${base}ort.min.mjs`,
            `${base}ort.webgpu.min.js`,
            `${base}ort.min.js`,
          ]
        : [`${base}ort.min.mjs`, `${base}ort.min.js`]);

    for (const moduleUrl of moduleUrls) {
      try {
        const imported = await import(moduleUrl);
        const ort = normalizeOrtModule(imported);
        if (ort) {
          this._configureOrt(ort);
          return ort;
        }
      } catch {
        // Tenta a próxima distribuição conhecida do onnxruntime-web.
      }
    }

    throw new VoiceLockError(
      "ORT_ASSET_UNAVAILABLE",
      `onnxruntime-web não foi encontrado em ${base}.`,
    );
  }

  _configureOrt(ort) {
    if (!ort.env?.wasm) {
      throw new VoiceLockError(
        "ORT_INCOMPATIBLE",
        "A distribuição de onnxruntime-web não expõe ort.env.wasm.",
      );
    }
    const base = this._options.ortBaseUrl.endsWith("/")
      ? this._options.ortBaseUrl
      : `${this._options.ortBaseUrl}/`;
    ort.env.wasm.wasmPaths = base;
    ort.env.wasm.proxy = false;
    ort.env.wasm.numThreads =
      globalThis.crossOriginIsolated === true
        ? Math.max(
            1,
            Math.min(4, globalThis.navigator?.hardwareConcurrency ?? 1),
          )
        : 1;
  }

  async _hasWebGpu() {
    if (this._options.backend === "wasm") {
      return false;
    }
    const gpu = globalThis.navigator?.gpu;
    if (!gpu || typeof gpu.requestAdapter !== "function") {
      return false;
    }
    try {
      return Boolean(
        await gpu.requestAdapter({ powerPreference: "high-performance" }),
      );
    } catch {
      return false;
    }
  }

  async _fetchModel(url, label) {
    let response;
    try {
      response = await this._fetch(url, {
        cache: "force-cache",
        credentials: "same-origin",
      });
    } catch (cause) {
      throw new VoiceLockError(
        "MODEL_ASSET_UNAVAILABLE",
        `O modelo ${label} não pôde ser carregado.`,
        { cause },
      );
    }
    if (!response?.ok) {
      throw new VoiceLockError(
        "MODEL_ASSET_UNAVAILABLE",
        `O modelo ${label} está ausente ou inacessível (HTTP ${response?.status ?? "desconhecido"}).`,
      );
    }
    try {
      return await response.arrayBuffer();
    } catch (cause) {
      throw new VoiceLockError(
        "MODEL_ASSET_UNAVAILABLE",
        `A resposta do modelo ${label} não pôde ser lida.`,
        { cause },
      );
    }
  }

  async _createSessions([encoderBytes, extractorBytes], backend) {
    const sessionOptions = {
      ...this._options.sessionOptions,
      executionProviders: [backend],
      graphOptimizationLevel: "all",
      executionMode: "sequential",
    };
    try {
      this._encoderSession = await this._ort.InferenceSession.create(
        encoderBytes,
        sessionOptions,
      );
      this._extractorSession = await this._ort.InferenceSession.create(
        extractorBytes,
        sessionOptions,
      );
    } catch (error) {
      await this._releaseSessions();
      throw error;
    }
  }

  async _releaseSessions() {
    await Promise.all([
      releaseSession(this._encoderSession),
      releaseSession(this._extractorSession),
    ]);
    this._encoderSession = null;
    this._extractorSession = null;
  }

  _validateSessionContract(session, model, label) {
    const expectedInputs = Object.values(model.inputs)
      .filter(Boolean)
      .map((descriptor) => descriptor.name);
    const expectedOutputs = Object.values(model.outputs).map(
      (descriptor) => descriptor.name,
    );
    const missingInput = expectedInputs.find(
      (name) => !session.inputNames.includes(name),
    );
    const missingOutput = expectedOutputs.find(
      (name) => !session.outputNames.includes(name),
    );
    if (missingInput || missingOutput) {
      throw new VoiceLockError(
        "MODEL_CONTRACT_MISMATCH",
        `O manifest não corresponde às entradas/saídas do ${label}: ${
          missingInput ?? missingOutput
        }.`,
      );
    }
  }

  _makeLengthsTensor(descriptor) {
    const defaultValue =
      descriptor.type === "float32" ? 1 : ENROLLMENT_SAMPLES_16K;
    const value = descriptor.value ?? defaultValue;
    let data;
    if (descriptor.type === "int64") {
      data = new BigInt64Array([BigInt(value)]);
    } else if (descriptor.type === "int32") {
      data = new Int32Array([Number(value)]);
    } else {
      data = new Float32Array([Number(value)]);
    }
    return new this._ort.Tensor(descriptor.type, data, descriptor.shape);
  }

  async _processFrameInternal(input) {
    const startedAt = now();
    const resampleInStartedAt = now();
    this._inputRing.push(this._downsampler.process(input));
    const resampleInMs = now() - resampleInStartedAt;

    let blocks = 0;
    let inferenceMs = 0;
    let resampleOutMs = 0;
    while (this._inputRing.length >= this._manifest.frameSamples) {
      const frame16k = this._inputRing.pop(this._manifest.frameSamples);
      const inferenceStartedAt = now();
      const enhanced16k = await this._runExtractor(frame16k);
      inferenceMs += now() - inferenceStartedAt;
      frame16k.fill(0);

      const resampleOutStartedAt = now();
      const enhanced48k = this._upsampler.process(enhanced16k);
      resampleOutMs += now() - resampleOutStartedAt;
      enhanced16k.fill(0);
      this._outputRing.push(enhanced48k);
      blocks += 1;
    }

    const output = new Float32Array(input.length);
    const written = this._outputRing.readInto(output);
    const underrunSamples = output.length - written;
    input.fill(0);

    this._emitMetric({
      operation: "processFrame",
      totalMs: now() - startedAt,
      resampleInMs,
      inferenceMs,
      resampleOutMs,
      blocks,
      inputSamples: output.length,
      underrunSamples,
      queuedInputSamples: this._inputRing.length,
      queuedOutputSamples: this._outputRing.length,
    });
    return output;
  }

  async _runExtractor(frame16k) {
    const inputs = this._manifest.extractor.inputs;
    const feeds = {
      [inputs.audio.name]: new this._ort.Tensor(
        inputs.audio.type,
        frame16k,
        inputs.audio.shape,
      ),
      [inputs.embedding.name]: new this._ort.Tensor(
        inputs.embedding.type,
        this._embedding,
        inputs.embedding.shape,
      ),
      [inputs.state.name]: new this._ort.Tensor(
        inputs.state.type,
        this._state,
        inputs.state.shape,
      ),
    };

    let outputs;
    try {
      outputs = await this._extractorSession.run(feeds);
    } catch (cause) {
      throw new VoiceLockError(
        "EXTRACTOR_INFERENCE_FAILED",
        "O extractor ONNX falhou ao processar um bloco de 160 amostras.",
        { cause },
      );
    }

    const enhanced = await readFloatTensor(
      outputs[this._manifest.extractor.outputs.audio.name],
      "o áudio do extractor",
      this._manifest.frameSamples,
    );
    const nextState = await readFloatTensor(
      outputs[this._manifest.extractor.outputs.state.name],
      "o estado do extractor",
      this._manifest.stateSize,
    );
    this._state.fill(0);
    this._state = nextState;
    return enhanced;
  }

  _resetStreamState() {
    this._state.fill(0);
    this._inputRing.clear({ zero: true });
    this._outputRing.clear({ zero: true });
    this._downsampler.reset();
    this._upsampler.reset();
  }

  _enqueue(operation) {
    this._assertNotDisposed();
    const task = this._queue.then(operation);
    this._queue = task.catch(() => undefined);
    return task;
  }

  _assertReady() {
    this._assertNotDisposed();
    if (this._status !== "ready") {
      throw new VoiceLockError(
        "NOT_INITIALIZED",
        "Execute e aguarde initialize() antes desta operação.",
      );
    }
  }

  _assertNotDisposed() {
    if (this._disposeRequested || this._status === "disposed") {
      throw new VoiceLockError(
        "DISPOSED",
        "Esta instância VoiceLock já foi encerrada.",
      );
    }
  }

  _emitMetric(values) {
    const detail = Object.freeze({
      source: "VoiceLockEngine",
      timestampMs: now(),
      backend: this._backend,
      ...values,
    });
    const event = makeEvent("metrics", detail);
    this.dispatchEvent(event);
    if (typeof this.onmetrics === "function") {
      this.onmetrics(event);
    }
  }

  _emitError(error) {
    const detail = Object.freeze({
      code: error.code,
      message: error.message,
    });
    const event = makeEvent("error", detail);
    this.dispatchEvent(event);
    if (typeof this.onerror === "function") {
      this.onerror(event);
    }
  }
}

export default VoiceLockEngine;
