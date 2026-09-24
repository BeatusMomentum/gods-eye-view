import { createFlowTileSource } from './flowSource.js';
import { flowSegmentsToRoads } from './flowDecode.js';
import { createOpenFreeMapSource } from '../../sources/openFreeMap.js';
import { validTileBounds } from '../../sources/vectorTiles.js';
export { normalizeOverpassRoads } from '../../sources/overpassRoads.js';

/** Supply tile-derived road geometry and flow availability without Overpass queries. */
export function createTrafficSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  mapTiles = createOpenFreeMapSource({ fetchImpl }),
} = {}) {
  const flow = createFlowTileSource({ fetchImpl });
  return {
    ...flow,
    resetFlowTileCache() {
      flow.resetFlowTileCache();
      mapTiles.clear();
    },
    async requestRoads(box, { majorOnly = false, signal, live = false } = {}) {
      if (
        !validTileBounds(box) ||
        box.north - box.south > 10 ||
        box.east - box.west > 10
      )
        throw new TypeError('A bounded road viewport is required');
      let data;
      if (live) {
        const segments = await flow.fetchFlowForBounds(box, { signal });
        data = {
          roads: flowSegmentsToRoads(segments),
          roadSource: 'TomTom',
          partial: flow.getFlowSessionStats().partial,
        };
      } else {
        const result = await mapTiles.fetchBounds(box, {
          zoom: majorOnly ? 12 : 14,
          signal,
        });
        data = {
          roads: result.tiles.flatMap((tile) => tile.roads),
          roadSource: 'OpenStreetMap tiles',
          partial: result.partial,
        };
      }
      signal?.throwIfAborted();
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        async json() {
          return data;
        },
      };
    },
    async getStatus({ signal } = {}) {
      const timeout = AbortSignal.timeout(8000);
      const response = await fetchImpl('/api/tomtom/status', {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const status = await response.json();
      signal?.throwIfAborted();
      if (typeof status?.hasKey !== 'boolean')
        throw new Error('Malformed traffic status');
      return status;
    },
  };
}
