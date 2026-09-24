#!/usr/bin/env node
/**
 * qa-overpass-offload.mjs — keyless/keyed source replacement acceptance gate.
 *
 * Run: node scripts/qa-overpass-offload.mjs http://localhost:4173
 *      node scripts/qa-overpass-offload.mjs --url http://localhost:4173
 *
 * Flies to Austin at 2 km, enables Street Traffic, Mapped Installations and
 * ALPR, then checks rendered road dots, ALPR entities, and military markers
 * and polygon outlines near Camp Mabry. Records the traffic road-source label
 * and rejects every browser request to an Overpass host or public Nominatim.
 * Server-side zero egress is separately pinned in src/overpassOffload.test.mjs.
 * Uses real source responses; no provider interception or fabricated records.
 * Screenshots and a JSON result go to qa-shots/ (gitignored). Exits nonzero on
 * a failed assertion. Works against keyed or keyless dev servers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'Usage: node scripts/qa-overpass-offload.mjs [--url] <dev-server-url> [--headful]\nChecks Austin traffic, ALPR, Camp Mabry military areas, source labels and zero browser Overpass/Nominatim requests. Writes qa-shots/.',
  );
  process.exit(0);
}
const url = args.includes('--url')
  ? args[args.indexOf('--url') + 1]
  : args.find((arg) => !arg.startsWith('--'));
if (!url || !['http:', 'https:'].includes(new URL(url).protocol))
  throw new Error('Supply a running dev server URL; see --help');
const shots = path.resolve('qa-shots');
await fs.mkdir(shots, { recursive: true });
const browser = await puppeteer.launch({
  headless: !args.includes('--headful'),
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {}),
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});
const result = {
  url,
  forbiddenRequests: [],
  errors: [],
  consoleErrors: [],
  failedRequests: [],
  traffic: null,
  alpr: null,
  military: null,
  screenshots: [],
};
let page;
try {
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  page.on('request', (request) => {
    const host = new URL(request.url()).hostname.toLowerCase();
    if (host.includes('overpass') || host === 'nominatim.openstreetmap.org')
      result.forbiddenRequests.push(request.url());
  });
  page.on('pageerror', (error) => result.errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && result.consoleErrors.length < 30)
      result.consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    if (result.failedRequests.length < 30) {
      const target = new URL(request.url());
      result.failedRequests.push({
        target: target.origin + target.pathname,
        error: request.failure()?.errorText,
      });
    }
  });
  console.log('Loading viewer...');
  const navigationUrl = new URL(url);
  navigationUrl.searchParams.set('welcome', '0');
  await page.goto(navigationUrl.href, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
    { timeout: 60_000, polling: 500 },
  );
  await page.keyboard.press('Escape');
  async function fly(lat, lon, height = 2000, heading = 0, pitch = -75) {
    await page.evaluate(
      async (view) => {
        const { viewer } = window.__godsEyeView;
        viewer.camera.cancelFlight();
        await new Promise((resolve) =>
          viewer.camera.flyTo({
            destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
              latitude: (view.lat * Math.PI) / 180,
              longitude: (view.lon * Math.PI) / 180,
              height: view.height,
            }),
            orientation: {
              heading: (view.heading * Math.PI) / 180,
              pitch: (view.pitch * Math.PI) / 180,
              roll: 0,
            },
            duration: 0,
            complete: resolve,
            cancel: resolve,
          }),
        );
      },
      { lat, lon, height, heading, pitch },
    );
  }
  async function shot(name) {
    // Let tile refinement and temporary height-pick framebuffers settle before capture.
    await page
      .waitForFunction(
        () => window.__godsEyeView.viewer.scene.globe.tilesLoaded,
        { timeout: 15_000, polling: 250 },
      )
      .catch(() => {});
    await page.evaluate(async () => {
      window.__godsEyeView.requestRender('qa-overpass-offload');
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    const filename = `overpass-offload-${name}.png`;
    await page.screenshot({ path: path.join(shots, filename) });
    result.screenshots.push(filename);
  }
  console.log('Checking Austin traffic and ALPR...');
  await fly(30.2672, -97.7431);
  for (const id of ['traffic', 'military-installations', 'alpr-cameras']) {
    console.log(`Enabling ${id}...`);
    await page.evaluate(
      (layerId) =>
        Promise.race([
          window.__godsEyeView.dataManager.setEnabled(layerId, true),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Layer enable timed out')),
              30_000,
            ),
          ),
        ]),
      id,
    );
  }
  await page.waitForFunction(
    () => {
      const layers = window.__godsEyeView.dataManager.layers;
      return ['traffic', 'alpr-cameras'].every((id) => {
        const s = layers.get(id).module.getStats();
        return s.count > 0 && !s.loading && !s.error;
      });
    },
    { timeout: 120_000, polling: 500 },
  );
  const austin = await page.evaluate(() => {
    const { viewer, dataManager } = window.__godsEyeView;
    const traffic = dataManager.layers.get('traffic').module.getStats();
    const alpr = dataManager.layers.get('alpr-cameras').module.getStats();
    let cameraEntities = 0;
    for (let i = 0; i < viewer.dataSources.length; i++)
      for (const entity of viewer.dataSources.get(i).entities.values) {
        if (
          String(entity.id).startsWith('alpr:') &&
          entity.billboard &&
          entity.show
        )
          cameraEntities++;
      }
    return { traffic, alpr, cameraEntities, sourceLabel: traffic.loadingLabel };
  });
  result.traffic = austin.traffic;
  result.alpr = austin.alpr;
  result.sourceLabel = austin.sourceLabel;
  assert.ok(austin.traffic.count > 0, 'road dots rendered');
  assert.ok(austin.cameraEntities > 0, 'ALPR camera entities rendered');
  assert.match(austin.sourceLabel, /Roads: (TomTom|OpenStreetMap tiles)/);
  await shot('austin');
  console.log('Checking Camp Mabry...');
  const before = await page.evaluate(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('military-installations')
        .module.getStats().lastUpdate,
  );
  await fly(30.314, -97.763, 2000, 25, -80);
  await page.waitForFunction(
    (prior) => {
      const s = window.__godsEyeView.dataManager.layers
        .get('military-installations')
        .module.getStats();
      return s.count > 0 && !s.loading && !s.error && s.lastUpdate !== prior;
    },
    { timeout: 120_000, polling: 500 },
    before,
  );
  result.military = await page.evaluate(() => {
    const { viewer, dataManager } = window.__godsEyeView;
    const center = viewer.scene.globe.ellipsoid.cartographicToCartesian({
      latitude: (30.314 * Math.PI) / 180,
      longitude: (-97.763 * Math.PI) / 180,
      height: 0,
    });
    const records = dataManager.layers
      .get('military-installations')
      .module.getNearby(center, 4000);
    const ids = new Set(records.map((r) => r.id));
    let markers = 0,
      outlines = 0;
    for (let i = 0; i < viewer.dataSources.length; i++)
      for (const entity of viewer.dataSources.get(i).entities.values) {
        if (!ids.has(entity.id) || !entity.show) continue;
        if (entity.billboard || entity.point) markers++;
        if (entity.polygon || entity.polyline) outlines++;
      }
    return {
      markers,
      outlines,
      names: records.map((r) => r.name),
      stats: dataManager.layers.get('military-installations').module.getStats(),
    };
  });
  assert.ok(result.military.markers > 0, 'military markers near Camp Mabry');
  assert.ok(
    result.military.outlines > 0,
    'military polygon outlines near Camp Mabry',
  );
  await shot('camp-mabry');
  await fly(30.314, -97.763, 650, 125, -45);
  await shot('camp-mabry-close');
  assert.deepEqual(
    result.forbiddenRequests,
    [],
    'zero Overpass/Nominatim browser requests',
  );
  result.passed = true;
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  result.passed = false;
  result.failure = error.message;
  if (page) {
    await page
      .screenshot({ path: path.join(shots, 'overpass-offload-failure.png') })
      .catch(() => {});
    result.diagnostic = await page
      .evaluate(() => ({
        text: document.body.innerText.slice(0, 3000),
        layers: [...(window.__godsEyeView?.dataManager?.layers || [])]
          .filter(([id]) =>
            ['traffic', 'military-installations', 'alpr-cameras'].includes(id),
          )
          .map(([id, entry]) => [id, entry.module.getStats()]),
      }))
      .catch(() => null);
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  await fs.writeFile(
    path.join(shots, 'overpass-offload-result.json'),
    JSON.stringify(result, null, 2),
  );
  await browser.close();
}
