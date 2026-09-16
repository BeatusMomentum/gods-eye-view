# Director: reusable scene playback

Director is the scene playback system. Ordered shot execution, authored timing and playback clocks are separated
from the scene editor and application rendering. This document
also records the proposed next steps; the sharing format and interactions below
are a design plan, not features already available.

## Implemented boundary

`src/director/playback.js`, exported as `gods-eye-view/director`, provides:

- `buildPlaybackQueue(scenes, startSceneId, { single })`: ordered scenes/shots,
  retaining the existing round-robin behavior.
- `playSceneQueue(queue, { token, adapter, previousScene, releaseOnFinish })`:
  sequential execution, cancellation checks and scene release.

The runner imports no renderer, UI, storage, recipe or dataset. An adapter supplies
these phases, in order: `selectShot`, `applyVisual`, `applyLayers`, `travel`,
`settle`, `hold`, `completeShot`. Each receives `{ scene, shot, index, total,
token }`. It also supplies `releaseScene(scene, token?)` and optionally `complete()`.
Callbacks may return promises. Each playback invocation requires its own adapter
state and token; the caller owns camera arbitration and concurrent-run refusal.

The runner checks cancellation after each phase. Adapters must also pass the
abort signal or liveness predicate into pending work: a check between phases
cannot stop a camera flight or network request already in progress. Cleanup
between scenes and on preview exit runs without an aborted token. A refused
initial handoff starts no shot. Final cleanup runs on completion, Stop or failure;
`releaseOnFinish: false` retains the final scene for ordinary playback. Exceptions
propagate so the caller can restore its controls. Empty/already-cancelled queues
acquire no resources. This low-level API expects normalized scene objects;
untrusted file validation belongs at the import boundary.

`src/scenes/playbackAdapter.js` connects this runner to the existing
`SceneDirector`. The latter still owns editor state, saved-project import/export,
camera ownership and asynchronous load/seek arbitration. Pure seek calculations
live in `src/director/timeline.js`; `src/director/clock.js` owns the run/load/shot
tickers, hold deadlines, snapshots and clock subscriptions. Stop settles pending
holds immediately, and revoked tick callbacks cannot affect a replacement clock.
`getPlaybackTimingState()` exposes copied snapshots and an active-timer count for
lifecycle diagnostics without exposing timer handles.

The `director` export also provides `sceneTimingForShot`, `sceneSeekState`,
`cameraAtProgress` and `createPlaybackClock`. Timeline functions receive duration
and hold resolvers; the clock receives timing, running-state and progress callbacks.
They import no renderer, storage, recipe or dataset.

`src/scenes/shotPresentation.js` prepares layer/seek context and resolves holds
and map preferences through a scene-pack registry. The `scenes` export provides
`createScenePackRegistry({ recipes, adapters })`; pass the result as `scenePacks`
in the SceneDirector constructor options. Trusted adapters can supply
`minimumHoldSec(states)`, `resolveVisual(shot, visual, isMapStackAvailable)` and
`cancelMotion(getLayerModule)`. Default composition registers the existing Nepal
presentation rules. These are code-level composition hooks, not executable
modules imported from scene files. Existing media-owner waits remain bounded.

All authored scenes, assets, IDs, source links, attribution and existing JSON
projects are preserved. The Nepal sequence remains the contribution introduced
by @manjunath22466 in #590. Its clips use source links/embeds; comparison images
and river coordinates are bundled. See the
[event pack provenance](../public/events/bhote-koshi-2026/README.md).

## Next changes, in order

1. **Timeline and content separation — implemented.** Pure duration/seek
   calculations, an owned clock and registered presentation rules preserve
   existing recipes and content. Tests cover direct load, forward/backward seek,
   replay, bounded media waits and cancellation at pending transitions.
2. **Versioned scene document — implemented for existing camera-pose shots.**
   [The scene document](SCENE-DOCUMENT.md) preserves version-1/2/3 imports. Bounded validation
   rejects malformed files before replacing current state; legacy migration
   preserves IDs, pack bindings and visual edits. Unreadable saved files are
   protected from fallback writes. Camera anchors, pack manifests and actions
   receive stable IDs with their respective later format extensions.
3. **Camera directions — implemented for pose-to-pose moves.**
   [Version 4](DIRECTOR-CAMERA.md) adds scene-local geographic anchors, explicit
   start/destination poses, easing, duration and holds. Playback and seek share
   the same sampler. Ellipsoidal heights are explicit; terrain-relative input
   is rejected. Existing shots retain ordinary flights. Curved paths, look-at
   targets and visual authoring are later extensions.
4. **Data packs and placement — implemented for bounded assets.**
   [Version 5](DIRECTOR-DATA-PACKS.md) defines a pack manifest with format/version,
   source, attribution/license and optional integrity/size metadata. It distinguishes
   registered asset directories from geographic coordinates, image bounds and
   media anchors. GeoJSON, PNG and native media adapters load with byte/time
   limits and explicit ellipsoid heights. Stop and replacement release resources.
   Paths resolve against a trusted directory base; missing/offline assets fail
   explicitly. Bundles, transforms and terrain-relative placement remain future
   extensions. Scene files carry no credentials or executable modules.
5. **Declarative interactions.** Give pickable features stable IDs and connect
   clicks to a small action registry: show a text/source card, focus an anchor,
   seek a shot, or change an allowed layer state. Define selection feedback,
   keyboard equivalents and precedence with drawing/tracking controls. Validate
   target references and cancel pending actions on Stop, replacement or teardown.
   No JavaScript evaluation or arbitrary HTML in scene files. Branching must
   have explicit loop/transition limits and reproducible reset/seek semantics.
6. **Sharing and authoring.** Add validated preview/import/export, missing-pack
   diagnostics and an optional self-contained bundle. Preserve attribution with
   each pack; a share link does not change an asset's license. A future node graph
   could author this same document, but playback and the format will not require
   a graph editor.

Each step must preserve existing scene editing, keyboard playback, camera
arbitration, layer cleanup, media timing and provider fallback. Acceptance includes
portable runner tests, existing Director regressions and browser playback with
Stop/seek/replay, plus tracking and voice checks. Use reproducible local fixtures
for failures and cancellation, alongside live visual checks for actual content.
