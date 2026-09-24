import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { tilesForBounds, tileToBBox } from '../../data/tomtomTiles.js';
import { decodeFlowTile } from './flowDecode.js';
import { clipTileLine } from '../../sources/openFreeMap.js';
import { trafficDetailBounds, createTrafficSource } from './source.js';
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
  const expected = decodeFlowTile(fixture, 12, 935, 1686).flatMap((r) =>
    clipTileLine(r.coords, bounds).map((coordinates) => ({
      ...r,
      coordinates,
    })),
  );
  assert.deepEqual(
    data.roads.map((r) => r.flow.closure),
    expected.map((r) => r.closure),
  );
  assert.ok(
    data.roads.every((r) =>
      r.coordinates.every(
        ([lon, lat]) =>
          lon >= bounds.west &&
          lon <= bounds.east &&
          lat >= bounds.south &&
          lat <= bounds.north,
      ),
    ),
  );
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

test('road parsing defers surface reads to the cancellable preparation pass', async () => {
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
  assert.equal(lookups, 0);
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

for (const lat of [51.5, 60])
  test(`z14 detail at ${lat} stays centered within the sixteen-tile cap`, async () => {
    const box = {
      south: lat - 0.025,
      north: lat + 0.025,
      west: -0.155,
      east: -0.105,
    };
    assert.ok(tilesForBounds(box, 14).length > 16);
    const detail = trafficDetailBounds(box);
    assert.ok(tilesForBounds(detail, 14).length <= 16);
    assert.ok(Math.abs((detail.south + detail.north) / 2 - lat) < 1e-10);
    const source = createTrafficSource({
      mapTiles: { fetchBounds: async () => ({ tiles: [], partial: false }) },
    });
    const data = await (await source.requestRoads(box)).json();
    assert.equal(data.detailLimited, true);
    assert.deepEqual(data.detailBounds, detail);
  });
test('TomTom buffers are clipped before caching and preserve direction and flow attributes', async () => {
  const core = tileToBBox(12, 935, 1686);
  const source = createTrafficSource({
    fetchImpl: async () => new Response(fixture),
  });
  const result = await source.fetchFlowForBounds({
    ...core,
    east: core.east - 1e-9,
    south: core.south + 1e-9,
  });
  const decoded = decodeFlowTile(fixture, 12, 935, 1686);
  assert.ok(
    decoded.some((r) =>
      r.coords.some(
        ([x, y]) =>
          x < core.west || x > core.east || y < core.south || y > core.north,
      ),
    ),
  );
  assert.ok(
    result.every((r) =>
      r.coords.every(
        ([x, y]) =>
          x >= core.west - 1e-10 &&
          x <= core.east + 1e-10 &&
          y >= core.south - 1e-10 &&
          y <= core.north + 1e-10,
      ),
    ),
  );
  assert.ok(result.some((r) => r.closure));
});

test('a failed detail pass keeps major roads and exposes separate degraded status', async () => {
  const { createIngestion } = await import('./ingestion.js');
  const state = {
    _loadGeneration: 0,
    _tileCache: new Map(),
    _enabled: true,
    _parseRoads: (data) => data.roads,
  };
  let paints = 0;
  const ingestion = createIngestion({
    state,
    services: {},
    parts: {
      viewport: {
        clampBounds: (b) => b,
        getBoundsCenter: (b) => ({
          lat: (b.north + b.south) / 2,
          lon: (b.east + b.west) / 2,
        }),
      },
      flow: {
        ensureFlowStatus: async () => {},
        applyFlowThenRender: async () => {
          paints++;
          return true;
        },
      },
    },
    source: {
      requestRoads: async (_, opts) => {
        if (!opts.majorOnly) throw new Error('tile request failed');
        return {
          ok: true,
          json: async () => ({
            roads: [],
            roadSource: 'OpenStreetMap tiles',
            partial: false,
          }),
        };
      },
    },
  });
  await ingestion.loadRoadsForBounds(bounds, 350);
  assert.equal(paints, 1);
  assert.equal(state._roadError, null);
  assert.equal(state._detailError, 'Detailed roads unavailable');
  assert.equal(state._roadPartial, true);
  assert.equal(state._fetching, false);
});
