# Architecture

## Archetype

One provider-neutral session core composes a persistent episode-source tab with one ephemeral top-level playback tab.

```text
Extension Popup
      │
      ▼
Session Core ─────────────► Window Controller
  │   │                         │
  │   └──────────────► Permission Broker
  │
  ├────────────► Episode Site Adapter
  │                 │
  │                 ├─ current episode
  │                 ├─ next episode
  │                 └─ ProviderCandidate
  │
  └────────────► Playback Surface
                    │
                    ├─ open exactly one provider tab
                    ├─ resolve current top-level origin
                    └─ close playback tab
                             │
                             ▼
                      Provider Frame Agent
                             │
                             ├─ detect player technology
                             ├─ provider-owned Google Cast session bridge
                             ├─ JW Player driver (MAIN-world bridge)
                             ├─ HTML5 fallback
                             ├─ native-player viewport presentation
                             ├─ bounded trusted playback activation transport
                             └─ emit canonical media events
```

## Ownership rules

### Session Core
Canonical owner of:
- global session lifecycle (`ACTIVE` until explicit Stop or natural series completion, then `ENDED`; no stored session is exposed as `NONE`);
- episode phase (`ARMING`/`RUNNING`/`NAVIGATING`/`BLOCKED`, with `STOPPED`/`COMPLETED` retained as terminal phase/result labels);
- current playback authority (`NONE`, `LOCAL_PLAYER`, or `CAST`) independently of the episode phase;
- controller tab identity;
- current playback tab identity;
- current episode/next episode;
- selected provider candidate;
- Auto-vs-manual provider mode;
- per-episode attempted-provider/failure ledger;
- bounded runtime failover to the next untried provider in Auto mode;
- transition deduplication;
- stale media-event rejection;
- one `MEDIA_ENDED` -> at most one next-episode transition.

It contains no episode-site selectors and no provider host table.

### Episode Site Adapter
Canonical owner of:
- recognizing supported episode pages;
- episode identity;
- next-episode target derived from page links;
- provider labels/availability;
- site-local provider redirect target translated into canonical `provider-navigation`.

It does not activate the provider player or inspect provider media DOM.

### Playback Surface
Canonical owner of:
- resolving the selected ProviderCandidate to an entry URL;
- creating exactly one temporary top-level provider tab initially **inactive** for provider-origin discovery;
- waiting until the tab leaves the episode-site origin and reaches a stable provider document;
- reporting the current top-level URL/origin/document identity;
- activating that same playback tab only after its current provider origin is permission-ready;
- closing the playback tab.

It does not grant permissions and does not inspect `<video>`.

### Provider Frame Agent
Despite the historical file name, this agent now executes in frame `0` of the top-level provider playback tab.

Canonical owner of:
- detecting the actual player technology in the provider tab;
- using a reusable player driver when available (initially JW Player 8);
- falling back to generic HTMLMediaElement control only when no supported driver exists;
- making the native player container fill the viewport without forcing native fullscreen;
- preserving native player controls/keyboard interaction for recognized players;
- media startup/state/events and replacement handling;
- hands-free player startup recovery through one bounded trusted browser activation when ordinary API/media playback is blocked;
- explicit user-facing recovery only if the bounded automatic path still cannot continue;
- observing provider-created Google Cast Web Sender state and supporting the D-028 retained-sender same-provider JW relay without exposing provider media details to durable extension state.

The JW driver talks to the page's `window.jwplayer` API through a small MAIN-world bridge because ordinary extension content scripts run in an isolated world. The bridge is an implementation under Provider Frame Agent ownership, not a second lifecycle owner. Provider names do not select the driver; detected player technology does.

The `cast-main-bridge.js` helper is an implementation under Provider Frame Agent ownership, not a second session owner. It observes the provider page's existing Cast Web Sender session, retains only admitted session/device metadata, and translates remote PLAYING/FINISHED state into canonical media events. Earlier bounded rejoin/native-control paths remain compatibility/fallback behavior for non-relay cases, but live v0.5.2-v0.5.6 evidence showed they were not sufficient for same-provider JW episode continuity. Under D-028 the old real Cast sender therefore stays alive as a retiring playback surface while the next JW helper page exports exactly its current provider-owned JW playlist item. That opaque item crosses the extension runtime once and is routed to the retained sender's existing `jwplayer().requestCast([item])`; it is never persisted, logged, inspected, normalized, cached, or used to construct QEC-owned Cast media. Under D-030 a same-provider generic HTML5 helper cannot use that JW-only relay: it keeps local playback deferred, requests the existing retained-session rejoin path, and waits for provider-owned Cast remote playback before the old sender is released. A bounded rejoin failure releases the old sender and permits ordinary local fallback. Under D-033/D-034 the same bridge owns semantic remote playback control behind one command contract: it prefers Google `RemotePlayer`/`RemotePlayerController` and falls back to the active provider/Google-owned `chrome.cast.media.Media` when the Framework controller is not exposed. Both drivers support Play/Pause, relative/absolute seek and Stop. Popup/Background route commands but do not become Cast owners, and the bridge verifies the expected active Cast session id before executing them. Neither bridge may read Cast `contentId`, construct its own `MediaInfo`/`LoadRequest`, call `loadMedia()` on QEC's behalf, create its own receiver app, or bypass provider access controls. The first device selection remains provider/Google-owned.

The `gesture-activation.js` transport is also an implementation under Provider Frame Agent ownership, not a separate owner. It may attach `chrome.debugger` only to the canonical playback tab and must detach immediately. Five bounded transports are admitted:
- JW playback: exactly one CDP Space `rawKeyDown` + `keyUp` pair through `Input.dispatchKeyEvent`;
- HTML5 playback: exactly one `Runtime.evaluate(..., userGesture:true)` call that invokes `.play()` only on the exact canonical media element already marked by the Provider Agent;
- retained JW Cast handoff: one `Runtime.evaluate` locator restricted to the visible native `.jw-icon-cast`/semantic Cast control, followed by exactly one tab-local CDP pointer move/press/release sequence at that resolved control;
- retained HTML5 Cast handoff: one `Runtime.evaluate` locator restricted to the already-marked canonical HTML5 player surface and a small allowlist of semantic Cast controls, followed by exactly one tab-local CDP pointer move/press/release sequence at that resolved control;
- retained HTML5 Cast fallback: only when an already-retained session cannot use or exhausts silent `requestSessionById`, one `Runtime.evaluate(..., userGesture:true)` call may invoke only the Cast MAIN-world bridge's fixed `__QEC_CAST_TRUSTED_REQUEST_SESSION__` entry point. That bridge may call Google `CastContext.requestSession()` once so Google's own Cast session UI opens; QEC does not select a receiver or load media.

The Cast pointer sequences do not move the OS cursor or foreground the browser. The HTML5 pointer path is scoped to the canonical media surface and fails closed when no semantic Cast control is found. The HTML5 Cast fallback is not a general page-script escape hatch: the transport may invoke only the fixed bridge entry point and must detach immediately. Arbitrary keys, arbitrary pointer targets/coordinates, arbitrary Runtime.evaluate code, Network/DOM/Fetch/Storage inspection and general-purpose debugger usage remain forbidden.

For generic HTML5 presentation, a detected provider-owned skin/control surface remains the single control owner. QEC suppresses its own overlay and browser-native controls in that case and sizes the provider surface to the viewport. Only a bare/unskinned HTML5 fallback gets QEC's Play/Pause/seek/mute/volume controls. A user-facing semantic Start control remains a last-resort explicit recovery path when automatic bounded activation cannot continue; it must not coordinate-click, click arbitrary anchors/page regions, or introduce provider-specific lifecycle logic.

### Permission Broker
Owns exact HTTP(S) provider-origin permission state. Permission requests originate only from the popup's explicit user gesture. Unknown provider origins are discovered while the temporary playback tab remains inactive; granting permission resumes the same session/tab automatically, so permission discovery never requires a second Start.

### Window Controller
Owns browser-window fullscreen state only. It never owns provider/media DOM and never forces focus.

### Status UI

The popup is a view/command surface over Session Core and never a playback-state owner. While `lifecycle = ACTIVE` and `playbackAuthority = CAST`, it may show D-033/D-034 remote controls only when the canonical Cast status reports a connected session and an available Cast control driver (`RemotePlayerController` or active `chrome.cast.media.Media`). Its seek position/duration are rendered from remote Cast state, not local JW/HTML5 state. Opening the popup from any tab observes and controls the same browser-wide QEC session through Background routing to the canonical playback tab.
Shows session state/start/stop/provider/permission status. It is not a second state owner.

## Runtime flow

```text
Start on supported episode-site controller tab
  -> probe episode + next + providers
  -> choose provider
  -> Playback Surface opens /redirect/... in new inactive discovery tab
  -> redirect settles on external provider origin
  -> exact-origin permission check
     -> if missing: popup grants while controller remains active
     -> activate the existing playback tab after grant
  -> inject player bridge + Provider Agent into playback tab frame 0
  -> detect provider Google Cast SDK/session + JW Player or HTML5 fallback
  -> preserve native player UI / size native surface to viewport
  -> if no sticky Cast continuity is pending: attempt normal player API playback
  -> if sticky same-provider JW D-028 relay is pending: defer local playback, export the helper's opaque current JW item and route it to the retained real sender
  -> if the helper is generic HTML5: do not export media; keep local playback deferred and use the retained-session rejoin path until remote PLAYING or bounded failure
     -> prefer silent requestSessionById(sessionId)
     -> accept only the exact retained session id as a successful rejoin
     -> trigger the provider-owned semantic HTML5 Cast control once so provider code transfers the new episode
     -> if no such control exists and silent rejoin is unavailable/exhausted, request one trusted Google-owned Cast session UI activation through the fixed bridge entry point
  -> otherwise a previously adopted Cast session may use the bounded legacy rejoin/native-control compatibility path
  -> if autoplay is blocked: one bounded player-specific background activation attempt
  -> if provider still fails and mode=Auto:
       record failure -> close playback tab -> re-probe same controller episode
       -> select next untried provider -> repeat provider setup
  -> if all supported providers failed: BLOCKED / NO_WORKING_PROVIDER
  -> local MEDIA_PLAYING or remote Cast PLAYING
  -> local MEDIA_ENDED or remote Cast IDLE/FINISHED
  -> Session Core keeps the global session ACTIVE and changes only the episode phase/authority
  -> local path: clear expected playback identity -> close provider tab -> navigate controller
  -> sticky same-provider JW Cast path: retain the old real sender, navigate controller, open one helper tab, relay the helper's opaque current JW playlist item to the retained sender
  -> JW relay: remote PLAYING promotes the retained sender back to canonical playback and closes the helper
  -> HTML5 rejoin: remote PLAYING makes the helper canonical Cast playback and closes the retiring sender; bounded failure falls back locally
  -> after controller load, repeat
```

## Core invariants

1. Session Core is the only owner of global session lifecycle, episode phase, playback authority, and episode transitions.
2. Episode Site Adapter is the only owner of supported controller-site DOM/episode/provider-entry interpretation.
3. Playback Surface is the only owner of provider-tab create/resolve/close behavior.
4. Provider Agent is the only owner of player-technology/media DOM interpretation; its MAIN-world JW bridge is only an implementation helper.
5. Permission Broker is the only semantic owner of provider host access.
6. At most one playback tab is canonical at a time.
7. Media events are accepted only from the current playback tab, current session, current epoch, frame `0`.
8. Expected playback-tab closure is cleared from state before `tabs.remove`. Unexpected playback-tab loss never ends the global session by itself; it becomes a recoverable `BLOCKED` phase while the session remains `ACTIVE`. Only controller-tab loss, explicit Stop, or natural no-next completion ends the global session.
9. No owner may use OS input/focus as a hidden fallback.
10. `chrome.debugger` is admitted only through the trusted playback-activation transport; the sole CDP input exception is the fixed Space keydown/keyUp pair to the canonical playback tab. All other CDP input and inspection domains remain forbidden.
11. Provider/site variants do not create parallel session logic.
12. Auto tries each supported provider at most once per episode; the ledger resets only when `beginEpisode` advances the epoch.
13. Explicit/manual provider selection is strict and never silently fails over to another provider.
14. Cast device discovery/selection remains provider/Google-owned; QEC may only adopt and boundedly rejoin an already-created Cast session.
15. Cast continuity may never require media URL extraction, `loadMedia()`, LAN scanning, or a QEC-owned receiver application.
