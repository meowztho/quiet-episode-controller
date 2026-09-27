# START — Quiet Episode Controller

You are the build agent for this repository.

## Mission

Implement the product described by the canonical authorities so a user can intentionally arm a Chrome episode-playback session and then game/work in another application while the browser progresses supported episodes without OS mouse/keyboard automation or repeated focus stealing.

## Mandatory reconstruction

Before material edits:

1. locate repository root;
2. read `AGENTS.md`;
3. read `PROJECT_INDEX.yaml`;
4. read:
   - `authority/VISION.md`
   - `authority/DECISIONS.md`
   - `authority/PRODUCT_REALIZATION.yaml`
   - `authority/ARCHITECTURE.md`
   - `authority/CAPABILITY_CONTRACTS.md`
   - `authority/PROJECT_PLAN.yaml`
   - `authority/ACCEPTANCE_EVIDENCE.yaml`
   - `authority/STATE.yaml`
   - `authority/TEST_STRATEGY.md`
5. inspect git status and relevant diffs;
6. run `python scripts/project_gate.py`.

If `core-first-governance` is available, load/apply it. Its procedure may not override this repository's Product Truth.

## Product gestalt

This is not a desktop macro.

The core workflow is:

```text
explicit Start
  -> arm one playback tab/window
  -> identify episode/site
  -> resolve provider entry from the current supported episode site
  -> open one temporary top-level provider playback tab
  -> detect actual player technology in frame 0
  -> use JW Player native API/UI when present, otherwise HTMLMediaElement fallback
  -> MEDIA_ENDED
  -> close playback tab
  -> navigate persistent episode-site controller to canonical next episode
  -> open a fresh playback tab
  -> repeat
```

The user may be gaming or working elsewhere. Ordinary progression must not touch OS input or repeatedly raise/focus Chrome.

Initial controller sources are AniWorld, SerienStream, and the SerienStream IP mirror. VOE, FileMoon, and Doodstream are expected provider families, but provider-specific details are adapters, never core assumptions.

## Architecture guardrails

- Session Core owns lifecycle and progression.
- Episode Site Adapter owns episode parsing/next target.
- Provider Frame Agent owns player DOM/media events.
- Adapter Registry owns selection.
- Permission Broker owns provider-origin permission.
- Window Controller owns optional one-time Chrome fullscreen mode.
- Status UI is a surface, not state authority.

Player-technology drivers are selected by detected player implementation, not provider name. Use JW Player 8 native API/UI when present; generic HTMLMediaElement is the fallback.

Do not introduce a framework/bundler unless a concrete implementation need justifies it.

Do not implement:
- OS mouse/keyboard automation;
- coordinate clicks;
- F11 automation;
- DRM/access-control bypass;
- media downloading/stream extraction;
- credential automation.

## Current admission

Read STATE. Initially M0 is the only admitted product stage.

For M0, create the smallest real MV3 shell:
- manifest;
- service worker;
- minimal popup/status surface with Start/Stop;
- versioned message envelope;
- adapter interfaces or minimal module boundaries;
- test entrypoints;
- Chrome loadability verification.

Do not prematurely implement live-site selectors in the core.

After satisfying M0:
1. record evidence;
2. update `ACCEPTANCE_EVIDENCE.yaml`;
3. derive/update STATE;
4. rebuild atlas: `python scripts/build_atlas.py`;
5. run `python scripts/project_gate.py`;
6. continue to the next admitted stage without waiting unless a real user/external dependency blocks progress.

## Verification truth

Fixtures prove only fixture behavior.
Live provider claims require live browser execution.

If autoplay is blocked, represent that explicitly; do not "solve" it with intrusive desktop input.

Stop only at:
- Product Complete,
- a genuine external/user decision blocker,
- or explicit user stop.
