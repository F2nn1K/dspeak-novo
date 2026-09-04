import VoiceLockEngine from "./voicelock-engine.js";

let engine = null;

function serializeError(error) {
  return {
    code: error?.code || "WORKER_ERROR",
    message: error?.message || "Falha no worker VoiceLock",
  };
}

function reply(id, result, transfer = []) {
  postMessage({ id, ok: true, result }, transfer);
}

function fail(id, error) {
  postMessage({ id, ok: false, error: serializeError(error) });
}

self.onmessage = async ({ data }) => {
  if (!data || !Number.isInteger(data.id) || typeof data.command !== "string") return;
  const { id, command, payload = {} } = data;
  try {
    if (command === "initialize") {
      if (engine) await engine.dispose().catch(() => {});
      engine = new VoiceLockEngine(payload.options || {});
      engine.addEventListener("metrics", ({ detail }) => {
        postMessage({ event: "metrics", detail });
      });
      engine.addEventListener("error", ({ detail }) => {
        postMessage({ event: "error", detail });
      });
      await engine.initialize();
      reply(id, {
        backend: engine.backend,
        frameSamples48k: engine.frameSamples48k,
      });
      return;
    }
    if (!engine) throw Object.assign(new Error("Worker não inicializado"), {
      code: "NOT_INITIALIZED",
    });
    if (command === "enroll") {
      const result = await engine.enroll(payload.samples);
      reply(id, result);
      return;
    }
    if (command === "process") {
      const samples = await engine.processFrame(payload.samples);
      reply(id, { samples }, [samples.buffer]);
      return;
    }
    if (command === "reset") {
      await engine.reset();
      reply(id, {});
      return;
    }
    if (command === "dispose") {
      await engine.dispose();
      engine = null;
      reply(id, {});
      close();
      return;
    }
    throw Object.assign(new Error(`Comando desconhecido: ${command}`), {
      code: "UNKNOWN_COMMAND",
    });
  } catch (error) {
    fail(id, error);
  }
};
