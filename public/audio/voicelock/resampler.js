/**
 * DSP compartilhado pelo VoiceLock.
 *
 * O arquivo é um módulo ES nativo e não depende de DOM, Web Audio ou ONNX.
 */

export const VOICELOCK_INPUT_SAMPLE_RATE = 48_000;
export const VOICELOCK_MODEL_SAMPLE_RATE = 16_000;

function assertFloat32Array(value, name) {
  if (!(value instanceof Float32Array)) {
    throw new TypeError(`${name} deve ser um Float32Array.`);
  }
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} deve ser um inteiro não negativo.`);
  }
}

/**
 * Ring buffer Float32 que cresce sob demanda e preserva a ordem FIFO.
 */
export class Float32RingBuffer {
  constructor(capacity = 1_024) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError("capacity deve ser um inteiro positivo.");
    }

    this._storage = new Float32Array(capacity);
    this._readIndex = 0;
    this._writeIndex = 0;
    this._length = 0;
  }

  get capacity() {
    return this._storage.length;
  }

  get length() {
    return this._length;
  }

  push(values) {
    assertFloat32Array(values, "values");
    if (values.length === 0) {
      return 0;
    }

    this._ensureCapacity(this._length + values.length);

    const firstPart = Math.min(
      values.length,
      this.capacity - this._writeIndex,
    );
    this._storage.set(values.subarray(0, firstPart), this._writeIndex);
    const secondPart = values.length - firstPart;
    if (secondPart > 0) {
      this._storage.set(values.subarray(firstPart), 0);
    }

    this._writeIndex = (this._writeIndex + values.length) % this.capacity;
    this._length += values.length;
    return values.length;
  }

  readInto(target, count = target.length, targetOffset = 0) {
    assertFloat32Array(target, "target");
    assertNonNegativeInteger(count, "count");
    assertNonNegativeInteger(targetOffset, "targetOffset");
    if (targetOffset > target.length) {
      throw new RangeError("targetOffset excede o tamanho de target.");
    }

    const readable = Math.min(
      count,
      this._length,
      target.length - targetOffset,
    );
    if (readable === 0) {
      return 0;
    }

    const firstPart = Math.min(readable, this.capacity - this._readIndex);
    target.set(
      this._storage.subarray(this._readIndex, this._readIndex + firstPart),
      targetOffset,
    );
    const secondPart = readable - firstPart;
    if (secondPart > 0) {
      target.set(this._storage.subarray(0, secondPart), targetOffset + firstPart);
    }

    this._readIndex = (this._readIndex + readable) % this.capacity;
    this._length -= readable;
    if (this._length === 0) {
      this._readIndex = 0;
      this._writeIndex = 0;
    }
    return readable;
  }

  pop(count = this._length) {
    assertNonNegativeInteger(count, "count");
    const result = new Float32Array(Math.min(count, this._length));
    this.readInto(result);
    return result;
  }

  peek(count = this._length) {
    assertNonNegativeInteger(count, "count");
    const readable = Math.min(count, this._length);
    const result = new Float32Array(readable);
    if (readable === 0) {
      return result;
    }

    const firstPart = Math.min(readable, this.capacity - this._readIndex);
    result.set(
      this._storage.subarray(this._readIndex, this._readIndex + firstPart),
      0,
    );
    const secondPart = readable - firstPart;
    if (secondPart > 0) {
      result.set(this._storage.subarray(0, secondPart), firstPart);
    }
    return result;
  }

  discard(count) {
    assertNonNegativeInteger(count, "count");
    const discarded = Math.min(count, this._length);
    this._readIndex = (this._readIndex + discarded) % this.capacity;
    this._length -= discarded;
    if (this._length === 0) {
      this._readIndex = 0;
      this._writeIndex = 0;
    }
    return discarded;
  }

  clear({ zero = false } = {}) {
    if (zero) {
      this._storage.fill(0);
    }
    this._readIndex = 0;
    this._writeIndex = 0;
    this._length = 0;
  }

  _ensureCapacity(required) {
    if (required <= this.capacity) {
      return;
    }

    let nextCapacity = this.capacity;
    while (nextCapacity < required) {
      nextCapacity *= 2;
    }

    const next = new Float32Array(nextCapacity);
    if (this._length > 0) {
      const firstPart = Math.min(
        this._length,
        this.capacity - this._readIndex,
      );
      next.set(
        this._storage.subarray(this._readIndex, this._readIndex + firstPart),
        0,
      );
      const secondPart = this._length - firstPart;
      if (secondPart > 0) {
        next.set(this._storage.subarray(0, secondPart), firstPart);
      }
    }

    this._storage = next;
    this._readIndex = 0;
    this._writeIndex = this._length;
  }
}

function designLowPass(factor, taps) {
  if (!Number.isInteger(taps) || taps < 7 || taps % 2 === 0) {
    throw new RangeError("taps deve ser um inteiro ímpar maior ou igual a 7.");
  }

  // 94% de Nyquist deixa uma pequena banda de transição antes da dizimação.
  const cutoff = 0.94 / (2 * factor);
  const center = (taps - 1) / 2;
  const coefficients = new Float64Array(taps);
  let sum = 0;

  for (let index = 0; index < taps; index += 1) {
    const distance = index - center;
    const sinc =
      distance === 0
        ? 2 * cutoff
        : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
    const window =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * index) / (taps - 1)) +
      0.08 * Math.cos((4 * Math.PI * index) / (taps - 1));
    coefficients[index] = sinc * window;
    sum += coefficients[index];
  }

  for (let index = 0; index < taps; index += 1) {
    coefficients[index] /= sum;
  }
  return coefficients;
}

class FirHistory {
  constructor(coefficients) {
    this._coefficients = coefficients;
    this._samples = new Float32Array(coefficients.length);
    this._writeIndex = 0;
  }

  pushAndFilter(sample, gain = 1) {
    this._samples[this._writeIndex] = sample;
    this._writeIndex = (this._writeIndex + 1) % this._samples.length;

    let sampleIndex =
      (this._writeIndex - 1 + this._samples.length) % this._samples.length;
    let result = 0;
    for (
      let coefficientIndex = 0;
      coefficientIndex < this._coefficients.length;
      coefficientIndex += 1
    ) {
      result +=
        this._coefficients[coefficientIndex] * this._samples[sampleIndex];
      sampleIndex =
        (sampleIndex - 1 + this._samples.length) % this._samples.length;
    }
    return result * gain;
  }

  reset() {
    this._samples.fill(0);
    this._writeIndex = 0;
  }
}

/**
 * Resampler causal e incremental de 48 kHz para 16 kHz.
 */
export class Resampler48To16 {
  constructor({ taps = 31 } = {}) {
    this._factor = VOICELOCK_INPUT_SAMPLE_RATE / VOICELOCK_MODEL_SAMPLE_RATE;
    this._filter = new FirHistory(designLowPass(this._factor, taps));
    this._phase = 0;
  }

  process(input) {
    assertFloat32Array(input, "input");
    const outputLength = Math.floor((this._phase + input.length) / this._factor);
    const output = new Float32Array(outputLength);
    let outputIndex = 0;

    for (let index = 0; index < input.length; index += 1) {
      const filtered = this._filter.pushAndFilter(input[index]);
      this._phase += 1;
      if (this._phase === this._factor) {
        this._phase = 0;
        output[outputIndex] = filtered;
        outputIndex += 1;
      }
    }
    return output;
  }

  reset() {
    this._filter.reset();
    this._phase = 0;
  }
}

/**
 * Resampler causal e incremental de 16 kHz para 48 kHz.
 */
export class Resampler16To48 {
  constructor({ taps = 31 } = {}) {
    this._factor = VOICELOCK_INPUT_SAMPLE_RATE / VOICELOCK_MODEL_SAMPLE_RATE;
    this._filter = new FirHistory(designLowPass(this._factor, taps));
  }

  process(input) {
    assertFloat32Array(input, "input");
    const output = new Float32Array(input.length * this._factor);
    let outputIndex = 0;

    for (let index = 0; index < input.length; index += 1) {
      output[outputIndex] = this._filter.pushAndFilter(
        input[index],
        this._factor,
      );
      outputIndex += 1;
      for (let phase = 1; phase < this._factor; phase += 1) {
        output[outputIndex] = this._filter.pushAndFilter(0, this._factor);
        outputIndex += 1;
      }
    }
    return output;
  }

  reset() {
    this._filter.reset();
  }
}

export function resample48To16(input, options) {
  return new Resampler48To16(options).process(input);
}

export function resample16To48(input, options) {
  return new Resampler16To48(options).process(input);
}
