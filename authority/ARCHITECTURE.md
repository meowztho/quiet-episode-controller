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
                             ├─ JW Player driver (MAIN-world bridge)
                             ├─ HTML5 fallback
                             ├─ native-player viewport presentation
                             ├─ bounded trusted playback activation transport
                             └─ emit canonical media events
```

## Ownership rules

### Session Core
Canonical owner of:
- IDLE/ARMING/RUNNING/NAVIGATING/BLOCKED/STOPPED/COMPLETED lifecycle;
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
- explicit user-facing recovery only if the bounded automatic path still cannot continue.

The JW driver talks to the page's `window.jwplayer` API through a small MAIN-world bridge because ordinary extension content scripts run in an isolated world. The bridge is an implementation under Provider Frame Agent ownership, not a second lifecycle owner. Provider names do not select the driver; detected player technology does.

The `gesture-activation.js` transport is also an implementation under Provider Frame Agent ownership, not a separate owner. It may attach `chrome.debugger` only to the canonical playback tab and must detach immediately. Two bounded transports are admitted:
- JW: exactly one CDP Space `rawKeyDown` + `keyUp` pair through `Input.dispatchKeyEvent`;
- HTML5: exactly one `Runtime.evaluate(..., userGesture:true)` call that invokes `.play()` only on the exact canonical media element already marked by the Provider Agent. The transport does not choose or search for a different media element.

Chromium fixture evidence verifies both transports can carry transient user activation to a background playback target without foreground focus. Arbitrary keys, mouse/pointer input, Network/DOM/Fetch/Storage inspection and general-purpose debugger usage are forbidden.

For generic HTML5 presentation, a detected provider-owned skin/control surface remains the single control owner. QEC suppresses its own overlay and browser-native controls in that case and sizes the provider surface to the viewport. Only a bare/unskinned HTML5 fallback gets QEC's Play/Pause/seek/mute/volume controls. A user-facing semantic Start control remains a last-resort explicit recovery path when automatic bounded activation cannot continue; it must not coordinate-click, click arbitrary anchors/page regions, or introduce provider-specific lifecycle logic.

### Permission Broker
Owns exact HTTP(S) provider-origin permission state. Permission requests originate only from the popup's explicit user gesture. Unknown provider origins are discovered while the temporary playback tab remains inactive; granting permission resumes the same session/tab automatically, so permission discovery never requires a second Start.

### Window Controller
Owns browser-window fullscreen state only. It never owns provider/media DOM and never forces focus.

### Status UI
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
  -> detect JW Player or HTML5 fallback
  -> preserve native player UI / size native surface to viewport
  -> attempt normal player API playback
  -> if autoplay is blocked: one bounded player-specific background activation attempt
  -> if provider still fails and mode=Auto:
       record failure -> close playback tab -> re-probe same controller episode
       -> select next untried provider -> repeat provider setup
  -> if all supported providers failed: BLOCKED / NO_WORKING_PROVIDER
  -> MEDIA_PLAYING
  -> MEDIA_ENDED
  -> Session Core clears playback identity
  -> close provider tab
  -> navigate controller tab to canonical next episode
  -> after controller load, repeat
```

## Core invariants

1. Session Core is the only lifecycle/episode-transition owner.
2. Episode Site Adapter is the only owner of supported controller-site DOM/episode/provider-entry interpretation.
3. Playback Surface is the only owner of provider-tab create/resolve/close behavior.
4. Provider Agent is the only owner of player-technology/media DOM interpretation; its MAIN-world JW bridge is only an implementation helper.
5. Permission Broker is the only semantic owner of provider host access.
6. At most one playback tab is canonical at a time.
7. Media events are accepted only from the current playback tab, current session, current epoch, frame `0`.
8. Expected playback-tab closure is cleared from state before `tabs.remove` so it cannot stop the session.
9. No owner may use OS input/focus as a hidden fallback.
10. `chrome.debugger` is admitted only through the trusted playback-activation transport; the sole CDP input exception is the fixed Space keydown/keyUp pair to the canonical playback tab. All other CDP input and inspection domains remain forbidden.
11. Provider/site variants do not create parallel session logic.
12. Auto tries each supported provider at most once per episode; the ledger resets only when `beginEpisode` advances the epoch.
13. Explicit/manual provider selection is strict and never silently fails over to another provider.
