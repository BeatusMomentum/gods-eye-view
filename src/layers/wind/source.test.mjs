import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindSource } from './source.js';
const manifest = { model: 'gfs', grid: { nx: 2, ny: 1, lo1: 0, la1: 90, dx: 180, dy: 180 }, gridUrl: '/api/wind/grid/test.bin' };
const response = (value) => new Response(typeof value === 'object' && !(value instanceof ArrayBuffer) ? JSON.stringify(value) : value);
test('wind source splits a bounded field and preserves unavailable responses', async () => {
  const source = createWindSource({ fetchImpl: async (url) => response(url.includes('manifest') ? manifest : Float32Array.from([1,2,3,4]).buffer) });
  const field = await source.getSnapshot();
  assert.deepEqual([...field.u], [1,2]); assert.deepEqual([...field.v], [3,4]);
  const unavailable = createWindSource({ fetchImpl: async () => response({ unavailable: true }) });
  assert.equal((await unavailable.getSnapshot()).unavailable, true);
});
test('wind source rejects foreign URLs, excessive grids and non-finite values', async () => {
  for (const bad of [{ ...manifest, gridUrl: 'https://example.com/exfil' }, { ...manifest, grid: { ...manifest.grid, nx: 1e9 } }]) {
    let calls = 0;
    const source = createWindSource({ fetchImpl: async () => { calls++; return response(bad); } });
    await assert.rejects(source.getSnapshot(), /Malformed/); assert.equal(calls, 1);
  }
  const source = createWindSource({ fetchImpl: async (url) => response(url.includes('manifest') ? manifest : Float32Array.from([NaN,2,3,4]).buffer) });
  await assert.rejects(source.getSnapshot(), /Malformed/);
});
test('wind source timeout aborts the underlying fetch', async () => {
  const source = createWindSource({ timeoutMs: 5, fetchImpl: (_, { signal }) => new Promise((resolve,reject) => signal.addEventListener('abort', () => reject(signal.reason), { once:true })) });
  await assert.rejects(source.getSnapshot(), /timed out/);
});
