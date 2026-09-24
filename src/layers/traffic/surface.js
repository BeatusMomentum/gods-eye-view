import * as Cesium from 'cesium';
import { DOT_HEIGHT_OFFSET, MAX_WAYPOINTS_PER_ROAD } from './policy.js';

/** Only sample a resolved visible surface; the hidden globe says nothing about Google tiles. */
export function trafficSurfaceReady(scene) {
  if (scene.globe?.show) return scene.globe.tilesLoaded !== false;
  let found = false;
  for (let i = 0; i < (scene.primitives?.length || 0); i++) {
    const primitive = scene.primitives.get(i);
    if (!primitive.show || typeof primitive.tilesLoaded !== 'boolean') continue;
    found = true;
    if (!primitive.tilesLoaded) return false;
  }
  return found;
}

/** Preserve bends and insert height samples at most 150 m apart, splitting long roads. */
export function roadSurfaceChunks(coordinates) {
  const chunks = [];
  let chunk = [coordinates[0]];
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1],
      b = coordinates[i];
    const metres =
      Math.hypot(
        (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180),
        b[1] - a[1],
      ) * 111320;
    const steps = Math.max(1, Math.ceil(metres / 150));
    for (let j = 1; j <= steps; j++) {
      const point =
        j === steps
          ? b
          : [
              a[0] + ((b[0] - a[0]) * j) / steps,
              a[1] + ((b[1] - a[1]) * j) / steps,
            ];
      chunk.push(point);
      if (chunk.length === MAX_WAYPOINTS_PER_ROAD) {
        chunks.push(chunk);
        chunk = [point];
      }
    }
  }
  if (chunk.length > 1) chunks.push(chunk);
  return chunks;
}

const validHeight = (height) =>
  Number.isFinite(height) && Math.abs(height) <= 9000;

/** Prepare local ellipsoidal waypoint heights, without writing unvalidated shared floor cells. */
export async function prepareRoadSurfaces(
  roads,
  scene,
  ground,
  excluded,
  signal,
) {
  const deadline = Date.now() + 30_000;
  while (!trafficSurfaceReady(scene)) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('Road surface still loading');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const samples = new Map();
  let work = 0;
  const carto = new Cesium.Cartographic();
  for (const road of roads) {
    for (let i = 0; i < road.coords.length; i++) {
      signal?.throwIfAborted();
      const [lon, lat] = road.coords[i];
      const key = `${lon.toFixed(6)},${lat.toFixed(6)}`;
      let height = samples.get(key);
      if (height === undefined) {
        carto.longitude = Cesium.Math.toRadians(lon);
        carto.latitude = Cesium.Math.toRadians(lat);
        carto.height = 0;
        const floor = ground?.cachedGroundFloor?.(lat, lon);
        const terrain = scene.globe?.show
          ? scene.globe.getHeight?.(carto)
          : undefined;
        let sampled;
        if (
          !scene.globe?.show &&
          scene.sampleHeightSupported &&
          trafficSurfaceReady(scene)
        ) {
          try {
            sampled = scene.sampleHeight(carto, excluded);
          } catch {
            /* unresolved mesh */
          }
        }
        height = validHeight(sampled)
          ? sampled
          : validHeight(floor)
            ? floor
            : 0;
        if (validHeight(floor)) height = Math.max(height, floor);
        if (validHeight(terrain)) height = Math.max(height, terrain);
        samples.set(key, height);
      }
      Cesium.Cartesian3.fromDegrees(
        lon,
        lat,
        height + DOT_HEIGHT_OFFSET,
        undefined,
        road.waypoints[i],
      );
      if (++work % 32 === 0)
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (let i = 0; i < road.segmentDist.length; i++)
      road.segmentDist[i] = Cesium.Cartesian3.distance(
        road.waypoints[i],
        road.waypoints[i + 1],
      );
  }
  signal?.throwIfAborted();
}
