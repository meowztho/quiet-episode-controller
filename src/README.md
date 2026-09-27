# src

Runtime ownership:

- `core/session.js` — canonical session lifecycle, episode transition deduplication, controller/playback tab identities.
- `sites/episode-site-adapter.js` — shared episode-source contract for AniWorld, SerienStream, and the SerienStream IP mirror: episode identity, same-origin next-episode resolution, and provider entry candidates only.
- `sites/episode-site-content.js` — versioned message bridge for the shared episode-source adapter.
- `providers/playback-surface.js` — exactly one temporary top-level provider tab for the current episode, provider redirect settlement, and playback-tab close.
- `providers/frame-agent.js` — player-technology/media discovery/control/events plus viewport presentation inside the provider tab.
- `providers/registry.js` — provider-name normalization and deterministic preference selection.
- `permissions/permission-broker.js` — exact current provider-origin permission state.
- `window/window-controller.js` — optional Edge/Chrome window fullscreen state.
- `background.js` — composition/orchestration only; it must not absorb site DOM or media DOM rules.

Normal flow:

`episode-source controller tab -> provider redirect URL -> temporary provider tab -> media ended -> close provider tab -> controller tab next episode -> repeat`.
