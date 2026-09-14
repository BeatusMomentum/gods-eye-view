import { advectParticle, sampleWind, windColor, windSpeed } from './model.js';

/**
 * Canvas particle renderer for a global wind field.
 *
 * Particles are advected in lon/lat by the sampled field and projected to the
 * screen through Cesium each frame. Particles hidden by the globe are skipped
 * with an `EllipsoidalOccluder`, and trails fade into a translucent backdrop.
 *
 * @param {{cesium: object, container: HTMLElement, getViewer: Function}} options
 */
export function createWindRendering({ cesium, container, getViewer } = {}) {
  let canvas = null;
  let context = null;
  let field = null;
  let particles = [];
  let frame = null;
  let running = false;
  let lastTime = 0;
  let cssWidth = 1;
  let cssHeight = 1;

  const randomParticle = () => ({
    lon: Math.random() * 360 - 180,
    lat: Math.random() * 178 - 89,
    age: Math.random() * 180,
  });

  const budget = () =>
    Math.max(3000, Math.min(8000, Math.floor((cssWidth * cssHeight) / 1000)));

  const seed = () => {
    particles = [];
    const limit = budget();
    for (let i = 0; i < limit; i += 1) particles.push(randomParticle());
  };

  const resize = (viewer) => {
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    const sceneCanvas = viewer?.scene?.canvas;
    cssWidth = sceneCanvas?.clientWidth || container?.clientWidth || 1;
    cssHeight = sceneCanvas?.clientHeight || container?.clientHeight || 1;
    canvas.width = Math.floor(cssWidth * ratio);
    canvas.height = Math.floor(cssHeight * ratio);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    context.setTransform?.(ratio, 0, 0, ratio, 0, 0);
  };

  /** Project lon/lat to CSS pixels, or null when hidden by the globe. */
  const project = (scene, occluder, lon, lat) => {
    const cartesian = cesium.Cartesian3.fromDegrees(lon, lat, 0);
    if (occluder && !occluder.isPointVisible(cartesian)) return null;
    return cesium.SceneTransforms.worldToWindowCoordinates(scene, cartesian);
  };

  const draw = (time) => {
    frame = null;
    if (!running) return;
    const viewer = getViewer?.();
    if (!viewer || viewer.isDestroyed?.()) return;
    resize(viewer);
    const dt = lastTime ? Math.min(1, Math.max(0, (time - lastTime) / 1000)) : 0.016;
    lastTime = time;
    context.fillStyle = 'rgba(0, 0, 0, 0.08)';
    context.fillRect(0, 0, cssWidth, cssHeight);
    if (!field) {
      frame = globalThis.requestAnimationFrame(draw);
      return;
    }
    const scene = viewer.scene;
    const occluder = cesium.EllipsoidalOccluder
      ? new cesium.EllipsoidalOccluder(cesium.Ellipsoid.WGS84, scene.camera.positionWC)
      : null;
    for (const particle of particles) {
      const wind = sampleWind(field, particle.lon, particle.lat);
      const before = { lon: particle.lon, lat: particle.lat };
      advectParticle(particle, wind, dt, { speedScale: 8 });
      particle.age += dt;
      const point = project(scene, occluder, particle.lon, particle.lat);
      const offscreen =
        !point ||
        point.x < 0 ||
        point.y < 0 ||
        point.x > cssWidth ||
        point.y > cssHeight;
      if (particle.age > 240 || offscreen) {
        Object.assign(particle, randomParticle());
        continue;
      }
      const previous = project(scene, occluder, before.lon, before.lat);
      if (!previous) continue;
      context.strokeStyle = windColor(windSpeed(wind.u, wind.v));
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.lineTo(point.x, point.y);
      context.stroke();
    }
    frame = globalThis.requestAnimationFrame(draw);
  };

  return {
    /** Create and append the overlay canvas. */
    attach() {
      if (canvas) return;
      canvas = document.createElement('canvas');
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.pointerEvents = 'none';
      canvas.style.zIndex = '1';
      context = canvas.getContext('2d');
      container.appendChild(canvas);
    },
    /** Install a wind field and (re)seed particles. */
    setField(next) {
      field = next;
      if (canvas) {
        resize(getViewer?.());
        seed();
      }
    },
    /** Start the animation loop. Safe to call before a field is installed. */
    start() {
      if (running || !canvas) return;
      running = true;
      lastTime = 0;
      frame = globalThis.requestAnimationFrame(draw);
    },
    /** Stop the animation loop. */
    stop() {
      running = false;
      if (frame !== null) globalThis.cancelAnimationFrame(frame);
      frame = null;
    },
    /** Clear the canvas and particles without removing the canvas. */
    clear() {
      particles = [];
      context?.clearRect(0, 0, cssWidth, cssHeight);
    },
    /** Stop and remove the overlay canvas. Idempotent. */
    destroy() {
      this.stop();
      this.clear();
      canvas?.remove();
      canvas = null;
      context = null;
    },
    /** Test seam: the current particle count. */
    getParticleCount() {
      return particles.length;
    },
  };
}
