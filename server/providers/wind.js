import { fetchGfsWind } from './wind/gfs.js';
import { fetchIfsWind } from './wind/ifs.js';
import { decodeWindGribMessage } from './wind/decode.js';

/** Serve bounded, single-flight, per-model forecast snapshots from fixed providers. */
export function windProxy({ fetchImpl = fetch, now = () => Date.now(), decodeImpl = decodeWindGribMessage, targetDx = 1, ttlMs = 3600_000, timeoutMs = 40_000, models = { gfs: fetchGfsWind, ifs: fetchIfsWind } } = {}) {
  const caches = new Map();
  const loadings = new Map();
  const grids = new Map();
  const attempts = new Map();
  const unavailable = (model) => ({ manifest: { model, schemaVersion: 1, unavailable: true, stale: true, reason: 'Wind upstream unavailable' } });
  const sendJson = (res, value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  function refresh(model) {
    const controller = new AbortController();
    const operation = { controller, waiters: 0, promise: null };
    loadings.set(model, operation);
    attempts.set(model, now());
    operation.promise = (async () => {
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const value = await models[model]({ fetchImpl, now, decodeImpl, targetDx, signal: controller.signal });
        controller.signal.throwIfAborted();
        const { grid, cycle } = value;
        if (!grid.u.every(Number.isFinite) || !grid.v.every(Number.isFinite)) throw new Error('Invalid wind grid');
        const id = `${model}-${cycle.date}-${cycle.hour}-f${cycle.forecastHour || 0}-${targetDx}`;
        const manifest = {
          schemaVersion: 1, model, cycle, fetchedAt: now(), level: value.level, units: value.units,
          grid: { nx: grid.nx, ny: grid.ny, lo1: grid.lo1, la1: grid.la1, dx: grid.dx, dy: grid.dy },
          stale: false, unavailable: false, reason: null,
          gridUrl: `/api/wind/grid/${id}.bin?model=${model}`,
        };
        const state = { id, grid, manifest, fetchedAt: now() };
        caches.set(model, state);
        // Retain the previous issued grid as well to cover a manifest/grid rollover.
        const history = grids.get(model) || new Map();
        history.set(id, state);
        while (history.size > 2) history.delete(history.keys().next().value);
        grids.set(model, history);
        return state;
      } catch {
        if (controller.signal.aborted && operation.waiters === 0) {
          attempts.delete(model);
          return unavailable(model);
        }
        const old = caches.get(model);
        if (old) {
          old.manifest = { ...old.manifest, stale: true, reason: 'Wind upstream unavailable' };
          return old;
        }
        return unavailable(model);
      } finally {
        clearTimeout(timer);
        controller.abort(); // Cancel a sibling request if the other component failed.
        if (loadings.get(model) === operation) loadings.delete(model);
      }
    })();
    return operation;
  }
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const model = url.searchParams.get('model') || 'gfs';
    if (req.method !== 'GET') return sendJson(res, { error: 'method_not_allowed' }, 405);
    if (!['gfs', 'ifs'].includes(model) || !Object.hasOwn(models, model)) return sendJson(res, { error: 'unknown_model' }, 400);
    if (url.pathname.startsWith('/grid/')) {
      const id = url.pathname.slice(6).replace(/\.bin$/, '');
      const state = url.pathname === `/grid/${id}.bin` && grids.get(model)?.get(id);
      if (!state) return sendJson(res, { error: 'unknown_grid' }, 404);
      const bytes = Buffer.concat([Buffer.from(state.grid.u.buffer, state.grid.u.byteOffset, state.grid.u.byteLength), Buffer.from(state.grid.v.buffer, state.grid.v.byteOffset, state.grid.v.byteLength)]);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=3600, immutable' });
      return res.end(bytes);
    }
    if (!['/', '/manifest', '/status'].includes(url.pathname)) return sendJson(res, { error: 'not_found' }, 404);
    let state = caches.get(model);
    if (!state || now() - state.fetchedAt >= ttlMs) {
      let operation = loadings.get(model);
      if (!operation && now() - (attempts.get(model) ?? -Infinity) >= 60_000) operation = refresh(model);
      if (operation) {
        let disconnected = false;
        operation.waiters += 1;
        const close = () => { disconnected = true; if (--operation.waiters === 0) operation.controller.abort(); };
        res.once?.('close', close);
        try { state = await operation.promise; }
        finally { res.removeListener?.('close', close); if (!disconnected) operation.waiters -= 1; }
        if (disconnected) return;
      }
    }
    const manifest = state?.manifest || unavailable(model).manifest;
    if (url.pathname === '/status') { const { gridUrl, ...status } = manifest; return sendJson(res, status); }
    return sendJson(res, manifest);
  };
  return {
    name: 'wind',
    configureServer({ middlewares }) { middlewares.use('/api/wind', handler); },
    configurePreviewServer({ middlewares }) { middlewares.use('/api/wind', handler); },
  };
}
