import { createDataPackSession } from '../../director/packs/session.js';
import { createPackPresentations } from './presentation.js';

/** Bind selected shot packs to one viewer and expose copied lifecycle diagnostics. */
export function createSceneDataPacks(viewer, { sources = {} } = {}) {
  const session = createDataPackSession({
    sources,
    adapters: createPackPresentations(viewer),
  });
  return {
    ...session,
    apply(scene, shot, token) {
      const wanted = new Set(shot.dataPackIds || []);
      return session.load(
        (scene.dataPacks || []).filter((pack) => wanted.has(pack.id)),
        { anchors: scene.anchors, signal: token?.signal },
      );
    },
  };
}
