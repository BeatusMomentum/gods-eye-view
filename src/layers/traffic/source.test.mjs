import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createTrafficSource } from './source.js';
import { clampBoundsAroundCenter } from '../../data/trafficBounds.js';
const bounds = { south: 30.267, west: -97.744, north: 30.268, east: -97.743 };
const fixture = readFileSync(
  new URL(
    '../../data/fixtures/tomtom-flow-austin-12-935-1686.pbf',
    import.meta.url,
  ),
);
test('flow caches and diagnostics belong to their constructed source', async () => {
  let requestsA = 0,
    requestsB = 0;
  const a = createTrafficSource({
    fetchImpl: async () => {
      requestsA++;
      return new Response(fixture);
    },
  });
  const b = createTrafficSource({
    fetchImpl: async () => {
      requestsB++;
      return new Response(fixture);
    },
  });
  const first = await a.fetchFlowForBounds(bounds);
  assert.ok(first.length > 0);
  await a.fetchFlowForBounds(bounds);
  assert.equal(requestsA, 1);
  assert.equal(b.getFlowSessionStats().tilesFetched, 0);
  b.resetFlowTileCache();
  await a.fetchFlowForBounds(bounds);
  assert.equal(requestsA, 1);
  await b.fetchFlowForBounds(bounds);
  assert.equal(requestsB, 1);
});
test('a cancelled flow body cannot refill its source cache', async () => {
  const controller = new AbortController();
  let calls = 0;
  const source = createTrafficSource({
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      arrayBuffer: async () => {
        calls++;
        if (calls === 1) controller.abort();
        return fixture;
      },
    }),
  });
  await assert.rejects(
    source.fetchFlowForBounds(bounds, { signal: controller.signal }),
    { name: 'AbortError' },
  );
  await source.fetchFlowForBounds(bounds);
  assert.equal(
    calls,
    2,
    'cancelled bytes were not admitted to the decode cache',
  );
});
test('road requests validate bounds and select z12/z14 immutable tile passes', async () => {
  const calls = [];
  const source = createTrafficSource({
    mapTiles: {
      async fetchBounds(box, options) {
        calls.push({ box, ...options });
        return { tiles: [{ roads: [] }], partial: false };
      },
      clear() {},
    },
  });
  await assert.rejects(
    source.requestRoads({ ...bounds, north: Infinity }),
    /bounded road viewport/,
  );
  assert.equal(calls.length, 0);
  await source.requestRoads(bounds, { majorOnly: true });
  await source.requestRoads(bounds);
  assert.deepEqual(
    calls.map((c) => c.zoom),
    [12, 14],
  );
  for (const centerLon of [179.99, -179.99]) {
    const clamped = clampBoundsAroundCenter(
      { south: -0.02, north: 0.02, west: 179.98, east: -179.98 },
      { lat: 0, lon: centerLon },
    );
    await source.requestRoads(clamped);
  }
  assert.equal(calls.length, 4);
});
test('malformed availability is an unavailable source rather than a keyless response', async () => {
  const source = createTrafficSource({
    fetchImpl: async () => new Response('{}'),
  });
  await assert.rejects(source.getStatus(), /Malformed traffic status/);
});

test('traffic construction is inert and parameters belong to each layer', async () => {
  const { createTrafficLayer } = await import('./index.js');
  const source = createTrafficSource({
    fetchImpl: () => assert.fail('construction fetched data'),
  });
  const services = { credits: {}, render: {} };
  const a = createTrafficLayer({ services, source });
  const b = createTrafficLayer({ services, source });
  a.setParams({ densityScale: 2, speedScale: 3, uncoveredRoads: 'hide' });
  assert.equal(a.getParams().densityScale, 2);
  assert.equal(b.getParams().densityScale, 1);
  assert.equal(b.getParams().speedScale, 1);
  assert.equal(b.getParams().uncoveredRoads, 'sim');
});

test('road tile replies respect cancellation even when the tile source ignores it', async () => {
  const abort = new AbortController();
  const source = createTrafficSource({
    mapTiles: {
      async fetchBounds() {
        abort.abort();
        return { tiles: [{ roads: [] }], partial: false };
      },
    },
  });
  await assert.rejects(source.requestRoads(bounds, { signal: abort.signal }), {
    name: 'AbortError',
  });
});

test('live roads come directly from TomTom and never ask for OpenStreetMap geometry', async () => {
  const calls = [];
  const source = createTrafficSource({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(fixture);
    },
    mapTiles: { fetchBounds: () => assert.fail('live mode asked for OSM') },
  });
  const data = await (await source.requestRoads(bounds, { live: true })).json();
  assert.equal(data.roadSource, 'TomTom');
  assert.ok(data.roads.length > 0);
  assert.ok(
    data.roads.every(
      (r) => r.directFlow && r.oneway === 1 && typeof r.flow.level === 'number',
    ),
  );
  assert.ok(data.roads.some((r) => r.flow.closure));
  assert.ok(calls.every((url) => url.startsWith('/api/tomtom/flow/')));
});

test('traffic status is session-cached after settlement, but cancelled discovery can restart', async () => {
  const { createFlow } = await import('./flow.js');
  let calls = 0;
  const state = {};
  const flow = createFlow({
    state,
    services: { credits: { registerDynamicCredit() {} } },
    parts: {},
    source: {
      async getStatus({ signal }) {
        calls++;
        signal?.throwIfAborted();
        return { hasKey: false };
      },
    },
  });
  const first = new AbortController();
  await flow.ensureFlowStatus(first.signal);
  first.abort();
  await flow.ensureFlowStatus(new AbortController().signal);
  assert.equal(calls, 1);
  const retryState = {};
  const retryFlow = createFlow({
    state: retryState,
    services: { credits: {} },
    parts: {},
    source: {
      async getStatus({ signal }) {
        calls++;
        signal.throwIfAborted();
        return { hasKey: false };
      },
    },
  });
  await assert.rejects(retryFlow.ensureFlowStatus(first.signal), {
    name: 'AbortError',
  });
  await retryFlow.ensureFlowStatus(new AbortController().signal);
  assert.equal(calls, 3);
});

test('keyless tile roads read the globe height cache without per-fragment offscreen 3D picks', async () => {
  const { createModel } = await import('./model.js');
  let lookups = 0;
  const model = createModel({
    state: {
      _viewer: {
        scene: {
          sampleHeightSupported: true,
          sampleHeight() {
            assert.fail('offscreen 3D height probe on keyless globe');
          },
          globe: {
            show: true,
            getHeight() {
              lookups++;
              return 0;
            },
          },
        },
      },
    },
    services: {},
    parts: {},
    source: {},
  });
  const roads = model.parseRoads({
    roads: [
      {
        coordinates: [
          [-97.74, 30.27],
          [-97.741, 30.271],
        ],
        type: 'residential',
        oneway: 0,
      },
    ],
  });
  assert.equal(roads.length, 1);
  assert.equal(roads[0].waypoints.length, 2);
  assert.equal(lookups, 1);
});

test('parsed road cache evicts old views by byte budget and never retains partial/live snapshots', async () => {
  const { cacheRoadSnapshot } = await import('./ingestion.js');
  const entries = new Map();
  const entry = () => ({
    major: [
      {
        coords: [
          [1, 2],
          [3, 4],
        ],
      },
    ],
    full: null,
  });
  const first = entry();
  cacheRoadSnapshot(entries, 'old', first);
  cacheRoadSnapshot(entries, 'new', entry(), {
    maxBytes: first.cacheBytes + 1,
  });
  assert.deepEqual([...entries.keys()], ['new']);
  cacheRoadSnapshot(entries, 'new', entry(), { retain: false });
  assert.equal(entries.size, 0);
  cacheRoadSnapshot(entries, 'oversized', entry(), { maxBytes: 1 });
  assert.equal(entries.size, 0);
});
