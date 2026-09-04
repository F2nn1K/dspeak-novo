import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./resampler.js", import.meta.url), "utf8");
const dsp = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
const { Float32RingBuffer } = dsp;

test("ring buffer preserva FIFO ao contornar e crescer", () => {
  const ring = new Float32RingBuffer(4);

  ring.push(new Float32Array([1, 2, 3]));
  assert.deepEqual(ring.pop(2), new Float32Array([1, 2]));

  ring.push(new Float32Array([4, 5, 6, 7, 8]));
  assert.ok(ring.capacity >= 6);
  assert.equal(ring.length, 6);
  assert.deepEqual(ring.peek(), new Float32Array([3, 4, 5, 6, 7, 8]));
  assert.equal(ring.length, 6);
  assert.deepEqual(ring.pop(), new Float32Array([3, 4, 5, 6, 7, 8]));
  assert.equal(ring.length, 0);
});

test("ring buffer lê em destino, descarta e limpa", () => {
  const ring = new Float32RingBuffer(3);
  const target = new Float32Array(5);
  target.fill(-1);

  ring.push(new Float32Array([10, 20, 30]));
  assert.equal(ring.readInto(target, 2, 1), 2);
  assert.deepEqual(target, new Float32Array([-1, 10, 20, -1, -1]));
  assert.equal(ring.discard(10), 1);
  assert.equal(ring.length, 0);

  ring.push(new Float32Array([40, 50]));
  ring.clear({ zero: true });
  assert.equal(ring.length, 0);
  assert.deepEqual(ring.pop(), new Float32Array());
});

test("ring buffer rejeita contratos inválidos", () => {
  assert.throws(() => new Float32RingBuffer(0), RangeError);

  const ring = new Float32RingBuffer();
  assert.throws(() => ring.push([1, 2]), TypeError);
  assert.throws(() => ring.pop(-1), RangeError);
  assert.throws(
    () => ring.readInto(new Float32Array(1), 1, 2),
    RangeError,
  );
});
