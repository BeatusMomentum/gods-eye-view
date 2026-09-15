import * as Cesium from 'cesium';
import { createWindRendering } from './rendering.js';

/** Format a forecast timestamp explicitly in UTC. */
export function formatWindValidTime(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : null;
}

/** Forecast issue time is source age; valid time is reported separately. */
export function windStats(manifest) {
  const run = Date.parse(manifest?.cycle?.runIso);
  return {
    count: manifest?.grid ? manifest.grid.nx * manifest.grid.ny : 0,
    lastUpdate: Number.isFinite(run) ? run : null,
    error: manifest?.reason || (manifest?.unavailable ? 'Wind unavailable' : null),
  };
}

/** Construct one wind layer with an explicit source and owned animation. */
export function createWindLayer({ feed, cesium = Cesium, container, createRendering = createWindRendering } = {}) {
  if (typeof feed?.getSnapshot !== 'function') throw new TypeError('Wind requires a snapshot source');
  let viewer = null;
  let request = null;
  let enabled = false;
  let rendering = null;
  let manifest = null;
  let error = null;
  let loading = false;
  let rowControlsListener = null;
  const notify = () => rowControlsListener?.();
  const layer = {
    id: 'wind', name: 'Wind', icon: '🌬', source: 'NOAA GFS · FORECAST', updateInterval: 3600_000,
    init(nextViewer) {
      viewer = nextViewer;
      rendering = createRendering({ cesium, container: container ?? nextViewer.container, getViewer: () => viewer });
      rendering.attach();
    },
    enable() { enabled = true; rendering?.start(); },
    disable() {
      enabled = false;
      request?.abort(); request = null; loading = false;
      rendering?.stop(); rendering?.clear();
    },
    async update(nextViewer, { signal } = {}) {
      if (!enabled) return false;
      request?.abort();
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      request = controller;
      loading = true;
      notify();
      try {
        signal?.throwIfAborted();
        const snapshot = await feed.getSnapshot({ signal: controller.signal });
        if (!enabled || controller.signal.aborted || request !== controller) return false;
        manifest = snapshot;
        error = null;
        if (snapshot.unavailable) { rendering.stop(); rendering.clear(); }
        else { rendering.setField(snapshot); rendering.start(); }
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        error = cause?.message || 'Wind source unavailable';
        return true;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) { request = null; loading = false; notify(); }
      }
    },
    getRowControls() {
      const valid = formatWindValidTime(manifest?.cycle?.validIso);
      const run = formatWindValidTime(manifest?.cycle?.runIso);
      return { chips: [], legend: [], info: `GFS forecast · Valid: ${valid || 'Unavailable'} · Issued: ${run || 'Unavailable'}${manifest?.stale ? ' · STALE' : ''}` };
    },
    setRowControlsListener(listener) { rowControlsListener = typeof listener === 'function' ? listener : null; },
    destroy() { layer.disable(); rendering?.destroy(); rendering = null; viewer = null; rowControlsListener = null; },
    getStats() { return { ...windStats(manifest), loading, error: error || windStats(manifest).error }; },
    getParticleCount() { return rendering?.getParticleCount() || 0; },
  };
  return layer;
}
