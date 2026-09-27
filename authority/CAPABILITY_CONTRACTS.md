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

## Session Core

```text
IDLE -> ARMING -> RUNNING -> NAVIGATING -> ARMING -> RUNNING ... -> COMPLETED
                    │
                    └-> BLOCKED
Any active state -> STOPPED
```

Rules:
- provider attach keeps the session in `ARMING`; only `MEDIA_PLAYING` makes it `RUNNING`;
- controller tab remains the episode-source identity;
- media messages are accepted only from the current playback tab + current session/epoch + frame 0;
- one `MEDIA_ENDED` yields at most one transition token;
- on next episode: clear playback identity -> close playback tab -> navigate controller -> re-probe after load;
- no-next: close playback tab -> COMPLETED;
- stale old-tab/old-epoch messages are ignored;
- Auto mode keeps a per-episode `attemptedProviders`/`providerFailures` ledger and selects only the next untried candidate in configured priority order;
- provider setup failure, `PLAYER_NOT_FOUND`, `USER_ACTIVATION_REQUIRED`, `MEDIA_ERROR`, or `AUTOPLAY_BLOCKED`/`PLAY_START_TIMEOUT` after the single trusted recovery closes the failed playback tab and re-probes the same controller episode before selecting the next candidate;
- each provider is attempted at most once per episode; exhaustion becomes `NO_WORKING_PROVIDER`;
- manual provider selection disables runtime failover and remains on the explicitly chosen provider.

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
