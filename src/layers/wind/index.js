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
  let model = 'gfs';
  let generation = 0;
  let rowControlsListener = null;
  const notify = () => rowControlsListener?.();
  const layer = {
    id: 'wind', name: 'Wind', icon: '🌬', source: 'GFS / ECMWF IFS · FORECAST', updateInterval: 3600_000,
    init(nextViewer) {
      viewer = nextViewer;
      rendering = createRendering({ cesium, container: container ?? nextViewer.container, getViewer: () => viewer });
      rendering.attach();
    },
    enable() { enabled = true; rendering?.start(); },
    disable() {
      enabled = false;
      generation += 1;
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
      generation += 1;
      loading = true;
      notify();
      try {
        signal?.throwIfAborted();
        const snapshot = await feed.getSnapshot({ signal: controller.signal, model });
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
    setParams(params = {}) {
      if (!['gfs', 'ifs'].includes(params.model) || params.model === model) return;
      model = params.model;
      request?.abort(); request = null;
      manifest = null; error = null; loading = enabled;
      rendering?.stop(); rendering?.clear();
      const current = ++generation;
      notify();
      if (enabled) queueMicrotask(() => {
        if (enabled && generation === current) void layer.update(viewer);
      });
    },
    getParams() { return { model }; },
    getRowControls() {
      const valid = formatWindValidTime(manifest?.cycle?.validIso);
      const run = formatWindValidTime(manifest?.cycle?.runIso);
      return { chips: ['gfs', 'ifs'].map((value) => ({ id: `model-${value}`, label: value.toUpperCase(), active: model === value, params: { model: value }, title: value === 'ifs' ? 'ECMWF IFS 10 m forecast' : 'NOAA GFS 10 m forecast' })), legend: [{ label: '0', color: '#1e3a8a' }, { label: '10', color: '#22d3ee' }, { label: '20', color: '#fbbf24' }, { label: '30+ m/s', color: '#ef4444' }], info: `${model.toUpperCase()} forecast · Valid: ${valid || 'Unavailable'} · Issued: ${run || 'Unavailable'}${manifest?.stale ? ' · STALE' : ''}` };
    },
    setRowControlsListener(listener) { rowControlsListener = typeof listener === 'function' ? listener : null; },
    destroy() { layer.disable(); rendering?.destroy(); rendering = null; viewer = null; rowControlsListener = null; },
    getStats() { return { ...windStats(manifest), loading, model: model.toUpperCase(), source: model === 'ifs' ? 'ECMWF IFS' : 'NOAA GFS', validTime: formatWindValidTime(manifest?.cycle?.validIso) || 'Unavailable', error: error || windStats(manifest).error }; },
    getParticleCount() { return rendering?.getParticleCount() || 0; },
  };
  return layer;
}
