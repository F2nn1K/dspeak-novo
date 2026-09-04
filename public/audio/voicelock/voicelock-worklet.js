import {
  Float32RingBuffer,
  VOICELOCK_INPUT_SAMPLE_RATE,
} from "./resampler.js";

const PROCESSOR_NAME = "voicelock-processor";
const DEFAULT_FRAME_SAMPLES_48K = 480;
const DEFAULT_MAX_IN_FLIGHT = 8;

/**
 * O worklet só transporta áudio. A inferência ONNX assíncrona permanece no
 * thread principal e responde pelo MessagePort.
 */
class VoiceLockProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requestedMaximum =
      options?.processorOptions?.maxInFlightFrames ?? DEFAULT_MAX_IN_FLIGHT;
    this._maxInFlight = Number.isInteger(requestedMaximum)
      ? Math.max(1, Math.min(32, requestedMaximum))
      : DEFAULT_MAX_IN_FLIGHT;
    const requestedFrame = options?.processorOptions?.frameSamples48k;
    this._frameSamples = requestedFrame === 960
      ? 960
      : DEFAULT_FRAME_SAMPLES_48K;

    this._captureRing = new Float32RingBuffer(this._frameSamples * 2);
    this._playbackRing = new Float32RingBuffer(this._frameSamples * 4);
    this._pendingOutput = new Map();
    this._sentAt = new Map();
    this._nextSequence = 0;
    this._nextOutputSequence = 0;
    this._inFlight = 0;
    this._framesSent = 0;
    this._framesReceived = 0;
    this._framesDropped = 0;
    this._framesFailed = 0;
    this._underrunSamples = 0;
    this._processedSamplesSinceMetrics = 0;
    this._latencyTotalMs = 0;
    this._latencyCount = 0;
    this._latencyMaximumMs = 0;
    this._sampleRateSupported = sampleRate === VOICELOCK_INPUT_SAMPLE_RATE;

    this.port.onmessage = ({ data }) => this._handleMessage(data);
    this.port.onmessageerror = () => {
      this._postError(
        "WORKLET_MESSAGE_ERROR",
        "O worklet recebeu uma mensagem inválida.",
      );
    };

    if (!this._sampleRateSupported) {
      this._postError(
        "UNSUPPORTED_SAMPLE_RATE",
        `O AudioContext deve operar a 48 kHz; recebeu ${sampleRate} Hz.`,
      );
    }
    this.port.postMessage({
      type: "voicelock-ready",
      sampleRate,
      frameSamples: this._frameSamples,
    });
  }

  process(inputs, outputs) {
    const outputChannels = outputs[0] ?? [];
    const quantumSize = outputChannels[0]?.length ?? 128;

    if (this._sampleRateSupported) {
      const inputChannels = inputs[0] ?? [];
      if (inputChannels.length === 1) {
        this._captureRing.push(inputChannels[0]);
      } else if (inputChannels.length > 1) {
        const mono = new Float32Array(inputChannels[0].length);
        for (const channel of inputChannels) {
          for (let index = 0; index < mono.length; index += 1) {
            mono[index] += channel[index] / inputChannels.length;
          }
        }
        this._captureRing.push(mono);
      }
      this._sendCompleteFrames();
    }

    if (outputChannels.length > 0) {
      const monoOutput = outputChannels[0];
      monoOutput.fill(0);
      const written = this._playbackRing.readInto(monoOutput);
      this._underrunSamples += monoOutput.length - written;
      for (
        let channelIndex = 1;
        channelIndex < outputChannels.length;
        channelIndex += 1
      ) {
        outputChannels[channelIndex].set(monoOutput);
      }
    }

    this._processedSamplesSinceMetrics += quantumSize;
    if (this._processedSamplesSinceMetrics >= sampleRate) {
      this._processedSamplesSinceMetrics %= sampleRate;
      this._postMetrics();
    }
    return true;
  }

  _sendCompleteFrames() {
    while (this._captureRing.length >= this._frameSamples) {
      const frame = this._captureRing.pop(this._frameSamples);
      if (this._inFlight >= this._maxInFlight) {
        frame.fill(0);
        this._framesDropped += 1;
        continue;
      }

      const sequence = this._nextSequence;
      this._nextSequence += 1;
      this._inFlight += 1;
      this._framesSent += 1;
      const capturedAtMs = currentTime * 1_000;
      this._sentAt.set(sequence, capturedAtMs);
      this.port.postMessage(
        {
          type: "voicelock-input",
          sequence,
          capturedAtMs,
          samples: frame,
        },
        [frame.buffer],
      );
    }
  }

  _handleMessage(data) {
    if (!data || typeof data.type !== "string") {
      return;
    }
    if (data.type === "voicelock-reset") {
      this._reset();
      return;
    }
    if (data.type === "voicelock-configure") {
      if (Number.isInteger(data.maxInFlightFrames)) {
        this._maxInFlight = Math.max(
          1,
          Math.min(32, data.maxInFlightFrames),
        );
      }
      return;
    }
    if (
      data.type !== "voicelock-output" &&
      data.type !== "voicelock-output-error"
    ) {
      return;
    }
    if (!Number.isInteger(data.sequence) || data.sequence < 0) {
      return;
    }

    const sentAtMs = this._sentAt.get(data.sequence);
    if (sentAtMs !== undefined) {
      const latencyMs = Math.max(0, currentTime * 1_000 - sentAtMs);
      this._latencyTotalMs += latencyMs;
      this._latencyCount += 1;
      this._latencyMaximumMs = Math.max(this._latencyMaximumMs, latencyMs);
      this._sentAt.delete(data.sequence);
      this._inFlight = Math.max(0, this._inFlight - 1);
    }

    let samples;
    if (data.type === "voicelock-output-error") {
      samples = new Float32Array(this._frameSamples);
      this._framesFailed += 1;
    } else if (data.samples instanceof Float32Array) {
      samples = data.samples;
    } else if (data.samples instanceof ArrayBuffer) {
      samples = new Float32Array(data.samples);
    }

    if (!samples || samples.length !== this._frameSamples) {
      samples = new Float32Array(this._frameSamples);
      this._framesFailed += 1;
    }
    if (data.sequence < this._nextOutputSequence) {
      samples.fill(0);
      return;
    }

    this._pendingOutput.set(data.sequence, samples);
    this._flushOrderedOutput();
  }

  _flushOrderedOutput() {
    while (this._pendingOutput.has(this._nextOutputSequence)) {
      const samples = this._pendingOutput.get(this._nextOutputSequence);
      this._pendingOutput.delete(this._nextOutputSequence);
      this._playbackRing.push(samples);
      this._framesReceived += 1;
      this._nextOutputSequence += 1;
    }
  }

  _reset() {
    this._captureRing.clear({ zero: true });
    this._playbackRing.clear({ zero: true });
    for (const samples of this._pendingOutput.values()) {
      samples.fill(0);
    }
    this._pendingOutput.clear();
    this._sentAt.clear();
    this._inFlight = 0;
    this._nextOutputSequence = this._nextSequence;
  }

  _postMetrics() {
    this.port.postMessage({
      type: "voicelock-worklet-metrics",
      sampleRate,
      frameSamples: this._frameSamples,
      framesSent: this._framesSent,
      framesReceived: this._framesReceived,
      framesDropped: this._framesDropped,
      framesFailed: this._framesFailed,
      underrunSamples: this._underrunSamples,
      inFlightFrames: this._inFlight,
      bufferedOutputSamples: this._playbackRing.length,
      averageRoundTripMs:
        this._latencyCount === 0
          ? 0
          : this._latencyTotalMs / this._latencyCount,
      maximumRoundTripMs: this._latencyMaximumMs,
    });
    this._latencyTotalMs = 0;
    this._latencyCount = 0;
    this._latencyMaximumMs = 0;
  }

  _postError(code, message) {
    this.port.postMessage({
      type: "voicelock-worklet-error",
      code,
      message,
    });
  }
}

registerProcessor(PROCESSOR_NAME, VoiceLockProcessor);
