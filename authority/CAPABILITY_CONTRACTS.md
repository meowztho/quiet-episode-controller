# Capability Contracts

## EpisodeSiteAdapter

### `probe(document, location) -> SiteProbe`
Returns:
- `supported`;
- `episodeIdentity`;
- canonical `nextEpisode` or `null`;
- visible provider candidates;
- diagnostics.

It must not mutate provider playback state.

## ProviderCandidate

```js
{
  key: "site-local-stable-key",
  provider: "VOE | Doodstream | ...",
  available: true,
  activation: {
    kind: "provider-navigation",
    target: "/redirect/123"
  }
}
```

Site-specific DOM attributes do not cross this boundary.

## PlaybackSurface

### `providerEntryUrl(candidate, baseUrl)`
Resolves only `provider-navigation` targets to HTTP(S) URLs.

### `openPlaybackSurface({windowId, candidate, baseUrl})`
- creates one **inactive** temporary playback tab in the controller window so provider-origin permission discovery does not dismiss the popup or steal focus;
- waits for top-level navigation to leave the episode-site origin;
- requires a short stable observation of the resulting provider document;
- returns `{tabId, entryUrl, document}`;
- `activatePlaybackSurface(tabId)` activates that same tab only after current-origin permission is ready;
- closes the created tab on setup failure.

### `currentPlaybackDocument(tabId)`
Returns canonical top-level document identity:

```js
{ tabId, frameId: 0, documentId, url, origin }
```

### `closePlaybackSurface(tabId)`
Best-effort closes only the supplied playback tab.

## ProviderFrameAgent

Runs in frame `0` of the provider playback tab.

### `observe(sessionId)`
Detects/re-detects the canonical player technology. Recognized player drivers own their native API/UI; otherwise the agent falls back to the canonical `<video>`. It applies viewport presentation and emits:
- `MEDIA_FOUND`
- `MEDIA_PLAYING`
- `MEDIA_ENDED`
- `MEDIA_ERROR`
- `MEDIA_STALLED`
- `MEDIA_PLAY_BLOCKED`
- `MEDIA_REPLACED`

### Player drivers and user-facing controls
For a recognized JW Player 8 instance, the agent preserves the native JW UI and uses the page-level JW API for state, play/pause, seek, volume, resize, fullscreen capability, and completion events. A MAIN-world bridge is injected before the isolated Provider Agent so `window.jwplayer` remains accessible without moving lifecycle ownership out of the agent. The driver sizes the player through both viewport CSS and `jwplayer().resize("100%", viewportHeight)`. It preserves native keyboard behavior and repairs only an otherwise-unconsumed real Space key by mapping that user event to native JW play/pause.

For generic HTML5, the Provider Agent first checks whether the canonical video already belongs to a recognized provider-owned control surface such as Plyr/Video.js/DPlayer-style UI. If so, that provider UI remains the single visible control owner; QEC does not add its own overlay or browser-native controls. Only bare/unskinned HTML5 gets the provider-independent QEC Play/Pause/seek/mute/volume overlay. If a provider has not yet materialized a `<video>` but exposes a visible semantic Play control, the explicit user Start action may activate that control synchronously and then re-probe. It must not use coordinates, arbitrary links, OS input, or broad page clicking.

### Playback startup
Recognized player APIs are attempted before generic `HTMLMediaElement.play()`. HTML5 attempt #1 is issued immediately so background-tab timer throttling cannot consume the startup window before any real attempt. Startup remains bounded and can retry transient initialization failures. Player/API events are normalized to the same canonical media events. `AUTOPLAY_BLOCKED` or `PLAY_START_TIMEOUT` admits at most one automatic targeted activation attempt per episode through the constrained `gesture-activation.js` transport: JW receives one CDP Space rawKeyDown/keyUp pair; HTML5 receives one `Runtime.evaluate(userGesture:true)` call to `.play()` only the Provider Agent-marked canonical video. Both attach only to the canonical playback tab and detach immediately. If that still does not produce `MEDIA_PLAYING`, the session remains BLOCKED. Provider attach or `MEDIA_FOUND` does **not** imply successful playback.


### Provider-owned Google Cast continuity

When the provider page already loads the Google Cast Web Sender SDK, the Provider Frame Agent may use a MAIN-world Cast bridge to observe the provider-created Cast session. The first device selection is performed through the provider's own Cast UI.

The bridge emits normalized Cast status only:

```js
{
  available,
  connected,
  sessionId,
  deviceName,
  receiverApplicationId,
  mediaPlayerState,
  mediaIdleReason,
  remoteControlAvailable,
  isMediaLoaded,
  remoteCurrentTime,
  remoteDuration
}
```

Rules:
- a connected session becomes sticky for the current QEC session;
- `beginEpisode` preserves that sticky Cast metadata;
- a new provider tab may receive the saved `sessionId` and retained `receiverApplicationId`; legacy bounded rejoin/Native-Control behavior remains a compatibility/fallback path, not the primary same-provider JW continuity mechanism;
- on natural Cast `MEDIA_ENDED`, the old provider tab becomes a retiring real sender and remains alive while the controller advances and one next-episode helper tab opens;
- when the retiring sender and next selected provider are the same JW-based provider, the helper exports exactly its current provider-owned JW playlist item and emits it once through `CAST_RELAY_ITEM`; Session Core routes the opaque object transiently to the retained sender through `CAST_RELAY_APPLY` and persists only an ephemeral transfer token/state;
- the retained JW sender passes that same object directly to its existing `jwplayer().requestCast([item])`; QEC must not inspect or persist its media fields;
- remote `PLAYING` from the retained sender normalizes to canonical `MEDIA_PLAYING`, promotes that retained sender back to the canonical playback surface for the new epoch, and closes the helper tab; bounded relay failure falls back to ordinary local playback;
- when the same-provider helper resolves to generic HTML5, the JW-only relay is not used: Provider Agent switches to the retained-session rejoin path, defers local HTML5 startup/autoplay, and waits for a matching Cast reconnect plus real remote `PLAYING`;
- retained HTML5 rejoin attempts the documented silent `chrome.cast.requestSessionById(sessionId)` path first; only a current session whose id exactly equals the retained id counts as rejoined;
- after a matching retained HTML5 session is available, Provider Agent requests one trusted activation of a visible semantic Cast control inside the canonical HTML5 player surface so provider code owns transfer/loading of the new episode;
- if no semantic HTML5 Cast control is available and the silent by-id path is unavailable/exhausted, Cast bridge emits one interaction-required signal and the existing trusted-activation transport may invoke only the bridge's fixed `CastContext.requestSession()` entry point with `userGesture:true`, causing Google's own Cast session UI to open;
- that trusted framework request is allowed only for an already-retained sticky session; QEC does not select a receiver, inspect/export HTML5 media, or construct/load Cast media, and remote `PLAYING` remains the only success signal;
- during that HTML5 continuation window, local helper `MEDIA_PLAYING` cannot become canonical playback authority and cannot release the retiring sender; remote `PLAYING` closes the retiring sender, while bounded `stickyResumeFailed` releases it and permits ordinary local HTML5 fallback;
- remote Cast `IDLE` with idle reason `FINISHED` normalizes to canonical `MEDIA_ENDED`;
- no Cast `contentId`/media URL is read or persisted into extension state;
- QEC never constructs its own Cast `MediaInfo`/`LoadRequest`, never invokes media loading with QEC-owned media data, never creates its own Cast receiver, and never scans/selects devices itself; diagnostic wrapping of provider-owned framework and legacy Cast `loadMedia` may record only call/result metadata, API path, autoplay and title-metadata presence and never serialize media arguments/identifiers;
- provider-native JW `requestCast()` is permitted only inside the JW MAIN-world bridge with the current provider-owned playlist object passed directly through, without stream reconstruction or extension-state exposure.
- while Cast is the canonical playback authority, the popup may issue only `TOGGLE_PLAY_PAUSE`, `SEEK_RELATIVE`, `SEEK_TO`, and `STOP`; Background routes them to the canonical playback tab, Provider Agent transports them to the existing Cast bridge, and the bridge rejects a mismatched Cast session id before calling `RemotePlayerController`;
- Cast progress/seek UI uses `RemotePlayer.currentTime`/`duration` and media-loaded state only; local JW/HTML5 playback never becomes a mirror state source for remote controls;
- explicit QEC Stop may best-effort invoke remote `STOP` before the QEC lifecycle ends and the sender tab closes.

Provider/receiver incompatibility is non-fatal: local playback remains the fallback and rejoin/handoff attempts are bounded per playback tab.

## Session Core

The Session Core owns three orthogonal values instead of treating one enum as all session truth:

```text
Global lifecycle:   NONE (no stored session) -> ACTIVE -> ENDED
Episode phase:      ARMING -> RUNNING -> NAVIGATING -> ARMING ...
                              └-> BLOCKED
Terminal labels:    STOPPED | COMPLETED
Playback authority: NONE | LOCAL_PLAYER | CAST
```

`ACTIVE` is the browser-wide single-session lock and the popup Start/Stop authority. Episode phase and playback authority may change many times without ending that lock.

Rules:
- provider attach keeps the episode phase in `ARMING`; only `MEDIA_PLAYING` makes it `RUNNING`;
- controller tab remains the episode-source identity; closing it ends the global lifecycle;
- one `ACTIVE` QEC session is allowed browser-wide; opening the popup from another tab observes that same session and cannot create a second one;
- unexpected loss of the canonical playback tab clears that surface and enters `BLOCKED / PLAYBACK_SURFACE_CLOSED`, but the lifecycle remains `ACTIVE`; explicit Stop remains available;
- media messages are accepted only from the current playback tab + current session/epoch + frame 0;
- one `MEDIA_ENDED` yields at most one transition token;
- on next episode: clear playback identity -> close playback tab -> navigate controller -> re-probe after load;
- no-next: close playback tab -> `COMPLETED` and lifecycle `ENDED`;
- explicit Stop -> `STOPPED` and lifecycle `ENDED`;
- stale old-tab/old-epoch messages are ignored;
- Auto mode keeps a per-episode `attemptedProviders`/`providerFailures` ledger and selects only the next untried candidate in configured priority order;
- provider setup failure, `PLAYER_NOT_FOUND`, `USER_ACTIVATION_REQUIRED`, `MEDIA_ERROR`, or `AUTOPLAY_BLOCKED`/`PLAY_START_TIMEOUT` after the single trusted recovery closes the failed playback tab and re-probes the same controller episode before selecting the next candidate;
- each provider is attempted at most once per episode; exhaustion becomes `NO_WORKING_PROVIDER`;
- manual provider selection disables runtime failover and remains on the explicitly chosen provider;
- a provider-created Cast session, once observed as connected, is retained as session-scoped metadata across episode epochs and offered to the next Provider Agent for bounded rejoin.

## Permission Broker

Input: exact current provider origin.

Output: `GRANTED | REQUIRED`.

The actual `chrome.permissions.request` call occurs only in the popup from an explicit user action. Unknown provider-origin discovery occurs in an inactive playback tab; the **Zugriff erlauben** action resumes that same tab/session automatically, with no second Start and no manual tab cleanup.

## Window Controller

### `enterPlaybackMode(windowId)`
May set the existing Edge/Chrome window to fullscreen after provider attach.

### `restorePlaybackMode(windowId, originalState, changed)`
Best-effort restores the prior window state on stop/completion/session teardown.

No focus forcing.
