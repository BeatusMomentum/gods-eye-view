import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindLayer, formatWindValidTime, windStats } from './index.js';

const snapshot = (model) => ({ model, grid: { nx: 2, ny: 2 }, cycle: { runIso: '2026-09-14T12:00:00Z', validIso: '2026-09-14T18:00:00Z' } });
function harness(feed) {
  const calls = [];
  const rendering = Object.fromEntries(['attach','start','stop','clear','destroy','setField'].map(name => [name, (...args) => calls.push([name, ...args])]));
  const layer = createWindLayer({ feed, createRendering: () => rendering });
  layer.init({ container: {} }); layer.enable();
  return { layer, calls };
}
test('forecast valid time and source age stay distinct', () => {
  assert.equal(formatWindValidTime('invalid'), null);
  assert.equal(formatWindValidTime('2026-01-05T06:30:00Z'), '2026-01-05 06:30 UTC');
  assert.equal(windStats(snapshot('gfs')).lastUpdate, Date.parse('2026-09-14T12:00:00Z'));
});
test('switching models clears old data and ignores an abort-insensitive late source', async () => {
  const pending = [];
  const { layer, calls } = harness({ getSnapshot: args => new Promise(resolve => pending.push({ ...args, resolve })) });
  const first = layer.update();
  layer.setParams({ model: 'ifs' });
  await Promise.resolve();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getStats().model, 'IFS');
  pending[0].resolve(snapshot('gfs'));
  await first;
  assert.equal(calls.filter(([name]) => name === 'setField').length, 0);
  pending[1].resolve(snapshot('ifs'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls.find(([name]) => name === 'setField')[1].model, 'ifs');
  assert.match(layer.getRowControls().info, /IFS forecast.*Valid: 2026-09-14 18:00 UTC.*Issued: 2026-09-14 12:00 UTC/);
  layer.destroy();
});
test('external and owned cancellation both cancel source work; queued switches stop on disable', async () => {
  let signal;
  const { layer } = harness({ getSnapshot: args => { signal = args.signal; return new Promise(resolve => signal.addEventListener('abort', () => resolve(snapshot('gfs')), { once: true })); } });
  const external = new AbortController();
  const update = layer.update(null, { signal: external.signal });
  layer.disable();
  assert.equal(signal.aborted, true); assert.equal(external.signal.aborted, false);
  assert.equal(await update, false);
  layer.enable();
  const other = layer.update(null, { signal: external.signal });
  external.abort(); assert.equal(signal.aborted, true); await other;
  layer.setParams({ model: 'ifs' }); layer.disable();
  await Promise.resolve(); assert.equal(layer.getStats().loading, false);
  layer.destroy();
});
