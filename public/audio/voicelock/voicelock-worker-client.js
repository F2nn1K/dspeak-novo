function eventWithDetail(type, detail) {
  return new CustomEvent(type, { detail });
}

export class VoiceLockWorkerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VoiceLockWorkerError";
    this.code = code;
  }
}

export class VoiceLockWorkerEngine extends EventTarget {
  constructor(options = {}) {
    super();
    this.options = options;
    this.status = "new";
    this.backend = null;
    this.frameSamples48k = 480;
    this.isEnrolled = false;
    this._nextId = 0;
    this._pending = new Map();
    this._worker = null;
  }

  async initialize() {
    if (this.status === "ready") return this;
    if (this.status === "disposed") {
      throw new VoiceLockWorkerError("DISPOSED", "VoiceLock já foi encerrado");
    }
    this.status = "initializing";
    this._worker = new Worker(
      this.options.workerUrl || "/audio/voicelock/voicelock-worker.js",
      { type: "module", name: "dspeak-voicelock" },
    );
    this._worker.onmessage = ({ data }) => this._onMessage(data);
    this._worker.onerror = (event) => {
      this._rejectAll(
        new VoiceLockWorkerError("WORKER_CRASH", event.message || "Worker VoiceLock falhou"),
      );
    };
    try {
      const engineOptions = { backend: this.options.backend || "auto" };
      if (this.options.manifestUrl) engineOptions.manifestUrl = this.options.manifestUrl;
      if (this.options.ortBaseUrl) engineOptions.ortBaseUrl = this.options.ortBaseUrl;
      const result = await this._request("initialize", {
        options: engineOptions,
      });
      this.backend = result.backend;
      this.frameSamples48k = result.frameSamples48k;
      this.status = "ready";
      return this;
    } catch (error) {
      this.status = "error";
      this._worker?.terminate();
      this._worker = null;
      throw error;
    }
  }

  async enroll(samples) {
    this._assertReady();
    const copy = new Float32Array(samples);
    const result = await this._request("enroll", { samples: copy }, [copy.buffer]);
    this.isEnrolled = true;
    return result;
  }

  async processFrame(samples) {
    this._assertReady();
    if (!this.isEnrolled) {
      throw new VoiceLockWorkerError("NOT_ENROLLED", "Calibre a voz antes de processar");
    }
    const copy = new Float32Array(samples);
    const result = await this._request("process", { samples: copy }, [copy.buffer]);
    return result.samples;
  }

  async reset() {
    this._assertReady();
    await this._request("reset");
  }

  async dispose() {
    if (this.status === "disposed") return;
    this.status = "disposing";
    if (this._worker) {
      try { await this._request("dispose"); } catch (_) {}
      this._worker.terminate();
    }
    this._worker = null;
    this._rejectAll(new VoiceLockWorkerError("DISPOSED", "VoiceLock encerrado"));
    this.isEnrolled = false;
    this.backend = null;
    this.status = "disposed";
  }

  _request(command, payload = {}, transfer = []) {
    if (!this._worker) {
      return Promise.reject(
        new VoiceLockWorkerError("NOT_INITIALIZED", "Worker VoiceLock ausente"),
      );
    }
    const id = ++this._nextId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({ id, command, payload }, transfer);
    });
  }

  _onMessage(data) {
    if (data?.event === "metrics") {
      this.dispatchEvent(eventWithDetail("metrics", data.detail));
      return;
    }
    if (data?.event === "error") {
      this.dispatchEvent(eventWithDetail("error", data.detail));
      return;
    }
    const pending = this._pending.get(data?.id);
    if (!pending) return;
    this._pending.delete(data.id);
    if (data.ok) pending.resolve(data.result);
    else {
      pending.reject(
        new VoiceLockWorkerError(
          data.error?.code || "WORKER_ERROR",
          data.error?.message || "Falha no worker VoiceLock",
        ),
      );
    }
  }

  _rejectAll(error) {
    for (const { reject } of this._pending.values()) reject(error);
    this._pending.clear();
  }

  _assertReady() {
    if (this.status !== "ready") {
      throw new VoiceLockWorkerError("NOT_INITIALIZED", "VoiceLock não está pronto");
    }
  }
}

export default VoiceLockWorkerEngine;
