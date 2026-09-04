import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./resampler.js", import.meta.url), "utf8");
const dsp = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
const {
  Resampler16To48,
  Resampler48To16,
  resample16To48,
  resample48To16,
} = dsp;

function sine(sampleRate, frequency, samples, amplitude = 1) {
  const result = new Float32Array(samples);
  for (let index = 0; index < samples; index += 1) {
    result[index] =
      amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
  }
  return result;
}

function concatenate(parts) {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const result = new Float32Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function processInChunks(resampler, input) {
  const sizes = [1, 2, 7, 128, 511, 960, 13, 64];
  const parts = [];
  let offset = 0;
  let sizeIndex = 0;
  while (offset < input.length) {
    const end = Math.min(input.length, offset + sizes[sizeIndex % sizes.length]);
    parts.push(resampler.process(input.subarray(offset, end)));
    offset = end;
    sizeIndex += 1;
  }
  return concatenate(parts);
}

function rms(values, start = 0) {
  let sum = 0;
  for (let index = start; index < values.length; index += 1) {
    sum += values[index] * values[index];
  }
  return Math.sqrt(sum / Math.max(1, values.length - start));
}

test("48→16→48 kHz produz as quantidades exatas de amostras", () => {
  const input48k = sine(48_000, 1_000, 48_000);
  const output16k = resample48To16(input48k);
  const output48k = resample16To48(output16k);

  assert.equal(output16k.length, 16_000);
  assert.equal(output48k.length, 48_000);
});

test("resampling incremental independe das fronteiras dos chunks", () => {
  const input48k = sine(48_000, 733, 48_137, 0.75);

  const downWhole = new Resampler48To16().process(input48k);
  const downChunked = processInChunks(new Resampler48To16(), input48k);
  assert.deepEqual(downChunked, downWhole);

  const upWhole = new Resampler16To48().process(downWhole);
  const upChunked = processInChunks(new Resampler16To48(), downWhole);
  assert.deepEqual(upChunked, upWhole);
});

test("resampler preserva uma senoide dentro da banda de voz", () => {
  const input48k = sine(48_000, 1_000, 48_000);
  const output16k = resample48To16(input48k);
  const roundTrip48k = resample16To48(output16k);
  const expectedRms = Math.SQRT1_2;

  assert.ok(Math.abs(rms(output16k, 200) - expectedRms) < 0.03);
  assert.ok(Math.abs(rms(roundTrip48k, 600) - expectedRms) < 0.05);
});

test("filtro de 48→16 kHz atenua conteúdo acima de Nyquist", () => {
  const inBand = resample48To16(sine(48_000, 1_000, 48_000));
  const outOfBand = resample48To16(sine(48_000, 12_000, 48_000));

  assert.ok(rms(outOfBand, 200) < rms(inBand, 200) * 0.2);
});

test("reset restaura o estado inicial do resampler", () => {
  const input = sine(48_000, 440, 4_800);
  const resampler = new Resampler48To16();
  const first = resampler.process(input);

  resampler.process(input.subarray(0, 17));
  resampler.reset();
  const afterReset = resampler.process(input);

  assert.deepEqual(afterReset, first);
});
