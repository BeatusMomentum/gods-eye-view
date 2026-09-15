import { readWindBody } from '../../sources/windBody.js';

/** Create a bounded, cancellable source for the same-origin wind provider. */
export function createWindSource({ fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 45_000 } = {}) {
  return {
    async getSnapshot({ signal, model = 'gfs' } = {}) {
      if (!['gfs', 'ifs'].includes(model)) throw new Error('Unknown wind model');
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error('Wind request timed out')), timeoutMs);
      const active = controller.signal;
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(`/api/wind/manifest?model=${model}`, { signal: active, cache: 'no-store', redirect: 'error' });
        if (!response.ok) throw new Error(`Wind HTTP ${response.status}`);
        const manifest = JSON.parse(new TextDecoder().decode(await readWindBody(response, 16_384, active)));
        if (manifest?.unavailable) return manifest;
        const grid = manifest?.grid;
        if (manifest?.model !== model || !grid || !Number.isInteger(grid.nx) || !Number.isInteger(grid.ny) || grid.nx < 1 || grid.ny < 1 || grid.nx * grid.ny > 1_000_000 || ![grid.lo1, grid.la1, grid.dx, grid.dy].every(Number.isFinite) || grid.dx <= 0 || grid.dy <= 0 || Math.abs(grid.nx * grid.dx - 360) > 0.01 || !new RegExp(`^/api/wind/grid/${model}-[\\w.-]+\\.bin\\?model=${model}$`).test(manifest.gridUrl))
          throw new Error('Malformed wind manifest');
        const count = grid.nx * grid.ny;
        const gridResponse = await fetchImpl(manifest.gridUrl, { signal: active, redirect: 'error' });
        if (!gridResponse.ok) throw new Error(`Wind HTTP ${gridResponse.status}`);
        const bytes = await readWindBody(gridResponse, count * 8, active);
        if (bytes.byteLength !== count * 8) throw new Error('Malformed wind grid');
        const values = new Float32Array(bytes.buffer);
        if (!values.every(Number.isFinite)) throw new Error('Malformed wind grid');
        return { ...manifest, u: values.slice(0, count), v: values.slice(count) };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
