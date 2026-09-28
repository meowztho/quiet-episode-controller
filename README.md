# Quiet Episode Controller

Quiet Episode Controller is a Chromium/Edge Manifest V3 extension for hands-free episodic playback while the user is doing something else.

It keeps the supported episode site open as a controller, opens the selected video host in a temporary playback tab, starts playback without taking over OS mouse/keyboard input, and advances to the next episode automatically when playback ends.

## Highlights

- Hands-free episode-to-episode playback after one **Start** action.
- Best used with the controller browser window moved to the monitor where playback should stay fullscreen.
- `Auto` provider mode with bounded `VOE -> Doodstream` runtime failover.
- Native JW Player handling plus HTML5/Plyr-style fallback.
- Experimental sticky Google Cast handoff: choose a device once in the provider player, then QEC attempts to reuse that Cast session for following episodes.
- Supports AniWorld and the SerienStream mirror family through one shared episode-site adapter.
- No OS mouse movement, global keyboard synthesis, Alt-Tab automation, or forced foreground focus.
- Project architecture, acceptance evidence, tests, and agent handoff material are versioned with the source.


## Installation

Quiet Episode Controller is currently installed as an **unpacked extension**.

### Microsoft Edge

1. Download and extract the current `quiet-episode-controller-edge-<version>.zip`.
2. Open `edge://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** / **Entpackte Erweiterung laden**.
5. Select the extracted folder that directly contains `manifest.json`.
6. Pin **Quiet Episode Controller** to the toolbar if you want quick access to Start/Stop and provider selection.
7. Open a supported episode page and use the extension popup.

### Google Chrome / Chromium

1. Download and extract the current extension ZIP.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted folder that directly contains `manifest.json`.

When updating an already installed development build, replace the files in the same extension folder and press **Reload** on the extension page. If host permissions changed between releases, the browser may ask you to confirm the updated permissions once.

## Quick usage

1. Open the episode you want to start with on a supported site.
2. **Recommended for a second monitor:** drag that episode tab into its own Edge/Chrome window and move this window to the monitor where you want the video to play. QEC creates the temporary provider playback tab in this same browser window and can fullscreen that window.
3. Open the QEC popup.
4. Leave **Hoster** on `Auto` for automatic `VOE -> Doodstream` selection and runtime fallback, or choose one provider explicitly.
5. Leave **Edge/Chrome-Fenster für Wiedergabe im Vollbild** enabled if you want the playback window fullscreen.
6. Click **Start** once.
7. After playback starts, you can switch back to your game or other work. QEC does not use OS mouse movement, OS keyboard automation or forced Alt-Tab/focus changes.
8. When the episode ends, QEC closes the temporary playback tab, advances the controller page to the next episode, opens the next provider tab and starts playback automatically.
9. Use **Stop** whenever you want to end the automated session and restore the browser window state.

In `Auto` mode, if the first offered provider cannot start successfully, QEC tries the next supported provider once for that episode. It never loops endlessly between providers.

### Supported controller sites

- `aniworld.to`
- `serienstream.to`
- `s.to`
- `serienstream.cx`
- `http://186.2.175.5/`

Current active providers: **VOE** and **Doodstream**. FileMoon is intentionally deferred because its current CAPTCHA/user gate requires manual interaction.

## Experimental Google Cast mode

QEC v0.5.7 experiments with **retaining the provider tab that already owns the real Google Cast session**, instead of trying to make every new provider tab independently rejoin the receiver. This deliberately does not use the browser's generic “Cast tab” command and QEC does not construct its own Google Cast media request.

For the first test:

1. Start QEC normally and let the provider video begin.
2. Use the **Cast button inside the provider player** and choose your Chromecast/Google Cast device once.
3. Leave the session running. A real framework/remote event — not JW's `cast.active` flag alone — is required before QEC treats Cast as connected.
4. When the remote episode ends, QEC advances the controller and opens the next same-provider VOE/JW page as a temporary helper while the previous provider tab remains alive as the actual Cast sender.
5. The helper obtains its current provider-owned JW playlist item and relays that object **once, opaquely and transiently** to the retained sender. QEC does not persist or log its media fields.
6. The retained sender passes the unchanged object directly to its own `jwplayer().requestCast([item])`. QEC itself does not create `MediaInfo`/`LoadRequest`, read `contentId`, or call `loadMedia()`.
7. Only real remote `PLAYING` counts as success. The retained sender then becomes the canonical playback tab for the new episode/epoch and the helper tab closes. If the relay fails, the helper falls back to normal local playback instead of looping.

The first device picker remains provider/Google-owned. QEC does not scan the LAN or choose a receiver itself. The transient JW item relay is an intentionally narrow exception for same-provider Cast continuity: it is not stored in Session Core or `chrome.storage.session`, is not shown in the popup/Cast trace, and is not exposed as a general media/stream extraction API. Provider changes or Auto failover can still be incompatible with the retained receiver path and therefore fall back to local playback.

Live v0.5.7 verification on 2026-09-28 confirmed the retained-sender relay across two consecutive automatic transitions: Episode 8 -> 9 and Episode 9 -> 10 both continued on the already-selected Chromecast. Live v0.5.8 then confirmed VOE still reports Chromecast as playback authority after rollover. Doodstream exposed a separate HTML5 race: the new local helper could start and cause the retiring sender to close before Cast rejoin resolved. v0.5.9 corrects that race without changing the proven JW relay.

## v0.5.x architecture

A supported episode site stays open as a persistent **controller tab**. v0.5.x supports **AniWorld** plus the SerienStream mirror family **`serienstream.to`**, **`s.to`**, **`serienstream.cx`**, and **`http://186.2.175.5/`** through one shared Episode Site Adapter. For each episode the extension opens exactly one temporary **playback tab** and drives the player there.

```text
Episode-site controller tab
  -> choose VOE / Doodstream
  -> open site-local /redirect/... in an inactive discovery tab
  -> provider redirects settle as top-level navigation
  -> if exact provider access is missing, keep discovery tab inactive and ask once in the still-open popup
  -> after grant, activate the same playback tab
  -> inject Cast + JW MAIN-world bridges + Provider Agent into frame 0
  -> detect player technology
     -> JW Player: preserve native UI/API/shortcuts
     -> otherwise: HTML5 fallback
  -> present the native player across the viewport
  -> attempt normal playback
  -> if autoplay is blocked, perform one bounded player-specific trusted browser activation
  -> in Auto mode only: if that provider still fails, close it and try the next untried provider once
  -> optional: observe/rejoin a provider-created Google Cast session
  -> RUNNING only after a real local or remote Cast playing event
  -> local MEDIA_ENDED or remote Cast FINISHED
  -> close temporary playback tab
  -> navigate controller tab to next episode
  -> repeat
```

No OS mouse movement, OS keyboard synthesis, coordinate clicking, Alt-Tab automation, or forced foreground focus is used.

## Initial provider preference

Default Auto order: `VOE -> Doodstream`.

`Auto` now means both **selection priority and bounded runtime failover**. For each episode, every provider exposed by the controller page is attempted at most once in priority order. Provider setup failure, `PLAYER_NOT_FOUND`, `USER_ACTIVATION_REQUIRED`, `MEDIA_ERROR`, or autoplay/start timeout after the one admitted trusted recovery closes the failed playback tab and advances to the next untried provider. If all offered supported providers fail, the session stops at `NO_WORKING_PROVIDER`; it never loops back to a provider already tried for that episode. The attempt/failure ledger resets on the next episode.

Explicit `VOE` or `Doodstream` selection is strict: manual selection never silently changes provider.

FileMoon is deliberately deferred for now because the current player path presents a CAPTCHA/user gate requiring interaction. QEC does not automate or bypass that gate, and FileMoon is neither selectable nor an implicit fallback.

A provider is used only when the current controller page exposes it.

## JW Player behavior

Provider pages that expose JW Player use the native JW Player UI and API rather than promoting the internal `<video>` above the player.

The Provider Agent:
- keeps native JW controls visible;
- sizes the JW container to the full viewport and calls `jwplayer().resize("100%", viewportHeight)`;
- neutralizes provider wrapper transforms/containment that would otherwise clip a fixed player surface;
- keeps native seek/volume/fullscreen controls;
- repairs only the observed missing Space shortcut by translating the user's real Space key event into native JW play/pause;
- normalizes JW `play`, `pause`, `firstFrame`, `complete`, error and startup events into canonical media events.

## Hands-free playback activation

Normal player API / `video.play()` remains the primary path. If Chromium rejects or times out audible autoplay, QEC performs **at most one bounded trusted playback activation per episode** on the canonical playback tab and detaches immediately:

- **JW Player:** one Space rawKeyDown/keyUp pair through CDP `Input.dispatchKeyEvent`, matching JW's native Play/Pause semantic without OS keyboard input or focus forcing.
- **HTML5/Plyr-style fallback:** one CDP `Runtime.evaluate(..., userGesture:true)` call that invokes `.play()` only on the exact `<video>` already selected and marked by the Provider Agent.
- **Retained JW Cast:** one semantic lookup of JW's visible `.jw-icon-cast` control followed by one tab-local CDP pointer move/press/release on that resolved control. The OS mouse pointer is not moved and the browser is not foregrounded.
- **Retained HTML5 Cast:** only the exact retained Cast session id counts as rejoined. QEC then triggers one visible semantic Cast control inside the canonical HTML5 player surface so the provider owns the new episode transfer. If no such control is available and silent `requestSessionById` is unavailable/exhausted, one `Runtime.evaluate(..., userGesture:true)` may invoke the Cast bridge's fixed trusted `CastContext.requestSession()` entry point so Google's own Cast session UI opens. QEC still does not select a receiver or load media.

The implementation forbids arbitrary keys, arbitrary pointer targets/coordinates, Network/DOM/Fetch/Storage inspection, OS mouse/keyboard events, focus forcing, and general-purpose debugger usage. If the bounded activation still fails, a manual provider selection remains BLOCKED. In Auto mode the Session Core records that provider as failed and tries the next untried provider instead; after all candidates fail it becomes `NO_WORKING_PROVIDER`.

Because `debugger` is a powerful required manifest permission, Edge will show a stronger extension permission warning when v0.4.2 is loaded/reloaded.

## HTML5 fallback

When no supported page API driver exists, the Provider Agent still owns canonical `<video>` discovery. If an existing provider-owned HTML5 skin is detected (for example Plyr/Video.js/DPlayer-style controls), that provider UI remains the **only** visible control surface and QEC does not layer its own or browser-native controls over it. If no provider UI exists, QEC supplies its provider-independent Play/Pause/seek/mute/volume fallback controls.

## Runtime permissions

- `activeTab` — explicit start from the current Episode-site controller tab.
- `debugger` — narrowly constrained activation transport: JW gets one targeted Space pair; canonical HTML5 media gets one `Runtime.evaluate(userGesture:true) -> media.play()` call; retained JW Cast gets one semantic cast-control pointer click; retained HTML5 Cast gets one semantic cast-control click scoped to the canonical player surface and may call the fixed Cast-bridge session-request entry point only as fallback; playback tab only, immediate detach.
- `scripting` — inject the shared episode-site probe and provider player drivers.
- `storage` — persist canonical session state across MV3 service-worker suspension.
- `webNavigation` — resolve the current top-level provider document in the temporary playback tab.
- AniWorld and the SerienStream mirror hosts (`serienstream.to`, `s.to`, `serienstream.cx`, and `186.2.175.5`) are declared directly.
- The currently observed Doodstream alias `https://playmogo.com/*` and current VOE surfaces `https://voe.sx/*` + `https://jeremyparticipantanything.com/*` are declared directly so a fresh install does not need a first-play permission detour for those known providers.
- Any other provider/redirect origin is requested at runtime for the exact current origin. The temporary playback tab stays inactive until that permission is granted, then the same tab/session resumes automatically.

## Verification

Run:

```bash
npm run check
python scripts/build_atlas.py
python scripts/project_gate.py
```

At v0.3.4, Doodstream reaches provider attachment/fullscreen at the current `playmogo.com` origin. Live v0.3.3 evidence then exposed two narrower defects: the HTML5 path layered QEC controls over an existing provider player, and autoplay ended in `PLAY_START_TIMEOUT` with `paused=true`, `ready=4`, `try=0`. Revision `4aec111` fixes those defects by preserving provider-owned HTML5 controls, starting attempt #1 immediately instead of behind a throttled timer, and giving HTML5 the same one-attempt hands-free activation contract through `Runtime.evaluate(userGesture:true)` on the Provider Agent-marked canonical media.

Revision `4aec111` passes 27/27 unit/orchestration tests, both browser fixture suites (including provider-owned HTML5 UI and background user-gesture playback), the static ownership/non-interference gate, package validation, and Project Gate. Live Edge testing has confirmed hands-free VOE startup and Doodstream v0.3.4 fullscreen/autoplay with a single provider-owned control surface. Full multi-episode rollover still requires live verification. FileMoon remains deferred from current scope.

v0.4.0 adds the shared AniWorld/SerienStream/IP-mirror controller adapter in `15f771d` and the non-disruptive exact-provider permission resume path in `1657f12`. The temporary provider tab remains inactive until permission is ready, then the same tab is activated; no second Start is required.

Canonical project truth is routed through `PROJECT_INDEX.yaml`.


v0.4.1 adds bounded per-episode runtime provider failover in Auto mode. Manual provider selection is strict, provider attempts are never repeated within the same episode, and `NO_WORKING_PROVIDER` is explicit when every offered supported provider failed. Deterministic orchestration coverage is recorded under revision `a623a3c`; live cross-provider failover remains to be verified in Edge.

v0.4.2 moves the currently known VOE origins (`voe.sx` and the live-observed `jeremyparticipantanything.com`) into install-time host permissions, matching the already predeclared Doodstream `playmogo.com` path. This removes the one-time first-play `Zugriff erlauben` detour after a fresh install for the known current providers while retaining the exact-origin runtime grant as a fallback for future/rotating aliases.


v0.4.3 updates the shared Episode Site Adapter for the current SerienStream/S.to episode layout. SerienStream-family pages may expose providers as `#episode-links .link-box` entries with `data-provider-name` and a direct `data-play-url`; those entries are normalized into the same canonical `provider-navigation` contract used by AniWorld. `s.to` and `serienstream.cx` are host profiles of the same adapter, not separate implementations. Revision `73fe418` verifies the same episode/provider contract across AniWorld, `serienstream.to`, `s.to`, `serienstream.cx`, and `186.2.175.5`. Live Edge verification of the mirror family remains pending.
## Repository layout

```text
src/         Extension runtime and UI code
tests/       Unit/orchestration and browser-fixture tests
scripts/     Project gate, release build and validation utilities
authority/   Canonical product/architecture/acceptance truth
prompts/     Start/continue/goal handoff prompts for coding agents
```

The files under `authority/`, `AGENTS.md`, `PROJECT_INDEX.yaml`, and `PROJECT_ATLAS.html` are intentionally committed. They are part of the project's durable architecture and verification context rather than disposable build output.

## License

Quiet Episode Controller is released under the [MIT License](LICENSE).


v0.5.0 introduced provider-owned Google Cast observation/continuity. Real-device testing through v0.5.6 established that remote end detection works but that a new VOE/JW tab does not obtain a usable session/media load merely from retained session metadata, CastContext bootstrap, rejoin, `requestCast()` on the new player, or a trusted native Cast-control click. v0.5.7 therefore keeps the already-working old sender alive and relays the next same-provider JW playlist item opaquely to that sender's native `requestCast([item])`; actual remote `PLAYING` remains the sole handoff success signal. QEC still does not construct/load Google Cast media itself.

## v0.5.8 session-state hardening

v0.5.8 separates browser-wide session lifecycle from episode phase and playback authority. While a QEC session is `ACTIVE`, Start is disabled globally and Stop remains available regardless of whether the current episode is arming, navigating, blocked, playing locally, or playing on Chromecast. Unexpected playback-tab loss now blocks the existing session instead of silently marking it stopped and allowing a second managed session. Concurrent Start requests are serialized. The proven v0.5.7 retained-sender JW relay is intentionally unchanged.

## v0.5.9 Doodstream/HTML5 retained-Cast handoff

v0.5.9 preserves the retiring Cast sender while a same-provider HTML5 helper is trying to rejoin the retained Cast session. The JW-only D-028 playlist relay remains unchanged and is never applied to HTML5. Instead the HTML5 helper defers local playback, uses the existing provider-owned Cast-session rejoin path, and waits for real remote `PLAYING`. Only remote success or a bounded rejoin failure may release the retiring sender. Local helper `MEDIA_PLAYING` during that continuation window is diagnostic only and cannot steal playback authority.

## v0.5.10 Doodstream Cast-session UI fallback

Live v0.5.9 Doodstream evidence reached `HTML5_CAST_REJOIN -> CAST_CONTEXT_CONFIGURED` but never reached `REJOIN_REQUESTED`, so the current `playmogo.com` sender surface did not provide the silent by-ID rejoin path used by the generic bridge. v0.5.10 keeps that documented silent path first. If it is unavailable or boundedly exhausted, QEC performs exactly one trusted activation of the Cast bridge's fixed `CastContext.requestSession()` entry point, allowing Google's own Cast session UI to open. QEC does not select a device, extract HTML5 media, or call Cast media loading itself; remote `PLAYING` is still required before the old sender is retired.

## v0.5.11 Doodstream provider-owned Cast transfer

Live v0.5.10 still stopped at `HTML5_CAST_REJOIN -> CAST_CONTEXT_CONFIGURED`, with no dialog and local HTML5 fallback. v0.5.11 corrects the actual split between session recovery and media transfer. A stale/foreign CastContext session no longer suppresses `requestSessionById`; only the exact retained session id does. After the retained session is recovered, QEC triggers exactly one semantic Cast control inside the canonical HTML5 player surface so Doodstream/provider code performs its own Cast media transfer, matching the provider-owned principle already proven by VOE/JW. If no semantic HTML5 Cast control is available, the v0.5.10 Google-owned `requestSession()` UI path remains the bounded fallback. QEC still never inspects/exports Doodstream media or calls Cast `loadMedia()` itself.

## v0.5.12 Chromecast remote controls

When a real Google Cast playback is the current QEC playback authority, the popup now exposes a Chromecast control strip with Play/Pause, −10 s, +10 s and an absolute seek bar. The progress display comes from Google Cast `RemotePlayer` state rather than from the local JW/HTML5 player. Commands are routed only to the canonical playback tab and are revalidated against the active Cast session id before `RemotePlayerController` executes them. The ordinary QEC **Stop** action also makes one best-effort remote media stop before ending the browser-wide QEC session.

Doodstream/playmogo automatic Cast rollover is intentionally deferred after the live v0.5.11 trace again stopped at `CAST_CONTEXT_CONFIGURED`. VOE remains the live-proven Cast-continuity path; the generic Doodstream experiments remain in the code as bounded fallbacks but are not a release blocker while deferred.

## v0.5.13 VOE Cast-control compatibility

A live VOE Chromecast session can be fully authoritative even when the provider page does not expose Google Cast Framework `RemotePlayer`/`RemotePlayerController` to QEC. v0.5.13 keeps the same popup command surface and the same `cast-main-bridge.js` owner, but adds the official active `chrome.cast.media.Media` object as a fallback Cast-control driver. Play/Pause, ±10 s, absolute seek and Stop therefore remain available on such sender surfaces. Remote position comes from the Cast media session (`getEstimatedTime()`/duration), never from the local JW player.

The popup reports the selected Cast driver (`FRAMEWORK_REMOTE_PLAYER` or `LEGACY_MEDIA`) for live diagnostics. Doodstream automatic Cast rollover remains deferred.

Live Edge/Chromecast verification on 2026-09-28 confirmed the v0.5.13 control surface works on VOE and remains usable after the automatic next-episode rollover. This closes the VOE remote-control live check. Doodstream/playmogo retained-Cast rollover remains intentionally deferred and is not claimed as verified.
