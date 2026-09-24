import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from 'cesium';
import {
  prepareRoadSurfaces,
  roadSurfaceChunks,
  trafficSurfaceReady,
} from './surface.js';
const road = (coords) => ({
  coords,
  waypoints: coords.map(() => new C.Cartesian3()),
  segmentDist: coords.slice(1).map(() => 0),
});
test('surface points preserve bends, bound spacing, and split rather than decimate long roads', () => {
  const chunks = roadSurfaceChunks([
    [0, 0],
    [0.2, 0],
    [0.2, 0.1],
  ]);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 80));
  assert.ok(chunks.flat().some((p) => p[0] === 0.2 && p[1] === 0));
  for (const c of chunks)
    for (let i = 1; i < c.length; i++)
      assert.ok(
        Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]) * 111320 <=
          150.01,
      );
});
test('per-vertex mesh heights follow terrain, reject invalid samples, and leave shared cache unmodified', async () => {
  const heights = [100, 200, NaN, 9001, -9001];
  let samples = 0;
  const r = road([
    [0, 0],
    [0.001, 0],
    [0.002, 0],
    [0.003, 0],
    [0.004, 0],
  ]);
  const scene = {
    globe: { show: false },
    primitives: { length: 1, get: () => ({ show: true, tilesLoaded: true }) },
    sampleHeightSupported: true,
    sampleHeight: () => heights[samples++],
  };
  const ground = {
    cachedGroundFloor: () => 50,
    reportMeshFloorCell: () => assert.fail('raw sample poisoned shared floor'),
  };
  await prepareRoadSurfaces([r], scene, ground, []);
  assert.equal(samples, 5);
  const actual = r.waypoints.map((p) =>
    Math.round(C.Cartographic.fromCartesian(p).height),
  );
  assert.deepEqual(actual, [103, 203, 53, 53, 53]);
  scene.primitives.get = () => ({ show: true, tilesLoaded: false });
  assert.equal(trafficSurfaceReady(scene), false);
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 10);
  await assert.rejects(
    prepareRoadSurfaces([r], scene, ground, [], abort.signal),
    { name: 'AbortError' },
  );
  assert.equal(samples, 5);
});
test('visible-globe roads floor each vertex without mesh picks', async () => {
  const r = road([
    [0, 0],
    [0.001, 0],
  ]);
  let calls = 0;
  await prepareRoadSurfaces(
    [r],
    {
      globe: { show: true, tilesLoaded: true, getHeight: () => ++calls * 100 },
      sampleHeight: () => assert.fail('mesh sampled'),
    },
    { cachedGroundFloor: () => 20 },
    [],
  );
  assert.equal(calls, 2);
  assert.deepEqual(
    r.waypoints.map((p) => Math.round(C.Cartographic.fromCartesian(p).height)),
    [103, 203],
  );
});
