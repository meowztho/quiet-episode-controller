# Decisions

## D-001 — Chromium Manifest V3
**Status:** SETTLED

Use a standard Chrome/Edge compatible Manifest V3 extension.

## D-002 — Browser APIs/DOM only
**Status:** USER_REQUIREMENT

No OS mouse movement, OS keyboard synthesis, arbitrary/OS coordinate clicking, Alt-Tab automation, or forced foreground focus. A bounded tab-local trusted pointer event may target only the already-resolved native JW Cast control under D-024; it must not move the OS pointer or become a general coordinate-click capability.

## D-003 — Core + adapters
**Status:** SETTLED_ARCHITECTURE

The session lifecycle is provider-neutral. AniWorld, SerienStream, the SerienStream IP mirror, VOE, DoodStream, and future integrations stay behind site/provider contracts.

## D-004 — Player-technology driver first, HTMLMediaElement fallback
**Status:** SETTLED_ARCHITECTURE

Provider playback is selected by the actual player technology, not by provider name. A recognized reusable player technology (initially JW Player 8) uses its native page API/events/UI. Generic `<video>` control remains the fallback when no supported player driver is present. Providers do not get duplicated lifecycle code merely because they can host the same player technology.

## D-005 — Browser-window fullscreen + native-player viewport presentation
**Status:** SETTLED_ARCHITECTURE

After the first provider is attached, the existing browser window may enter fullscreen once. If a recognized player container exists, the provider agent makes that container fill the viewport while preserving the player's native controls and keyboard behavior. Only the generic HTML5 fallback promotes the canonical `<video>` itself. Do not depend on repeated `Element.requestFullscreen()`.

## D-006 — Safe failure beats intrusive fallback
**Status:** USER_REQUIREMENT_DERIVED

Autoplay/player failures become passive BLOCKED states. They never authorize desktop input automation.

## D-007 — Narrow known-provider permission + non-disruptive exact runtime redirect permissions
**Status:** SETTLED_ARCHITECTURE

Known current provider entry origins may be predeclared narrowly when an extra runtime permission click would break the hands-free goal. The currently observed Doodstream alias `https://playmogo.com/*` is predeclared. Any unknown or changed provider/redirect origin remains behind the exact-origin runtime permission gate and can only be granted from an explicit popup user action. To avoid the old Start → active tab → reopen popup → grant → restart loop, provider-origin discovery uses an **inactive** temporary playback tab. After grant, QEC reuses and activates that exact tab and resumes the existing session automatically.

## D-008 — Plain MV3 JavaScript by default
**Status:** DELEGATED_TECHNICAL_DECISION_WITH_DEFAULT

No framework/bundler unless a concrete need appears.

## D-009 — Live compatibility is evidence, not assumption
**Status:** VERIFICATION_RULE

Fixture/unit success does not prove current provider behavior. Real Edge/Chrome execution is required for live claims.

## D-010 — Session state survives MV3 worker suspension
**Status:** IMPLEMENTED_ARCHITECTURE

Session Core owns semantics; `chrome.storage.session` is only the persistence transport.

## D-011 — Persistent controller tab + ephemeral playback tab
**Status:** USER_DECISION

The selected supported episode site remains open in one controller tab. Each episode has one canonical provider playback tab. Normally, at media end that playback tab closes, the controller navigates to the next episode, and a new playback tab is created. Under the D-028 same-provider Cast continuity path only, the previous canonical Cast sender may remain temporarily as a retiring sender while one next-episode helper tab obtains the next JW item; the overlap ends as soon as remote `PLAYING` or bounded local fallback resolves the handoff.

The controller tab owns no media DOM. The playback tab owns no episode sequencing knowledge.

## D-012 — Provider candidates converge to top-level navigation
**Status:** IMPLEMENTED_ARCHITECTURE

The site adapter emits:

```js
{
  key,
  provider,
  available,
  activation: {
    kind: "provider-navigation",
    target: "/redirect/..."
  }
}
```

The Playback Surface resolves that target relative to the current episode, opens it in a temporary tab, and waits until navigation leaves the episode-site origin and settles on the current provider document.

## D-013 — Current top-level provider origin owns injection permission
**Status:** IMPLEMENTED_ARCHITECTURE

The first redirect hostname is not authoritative. `chrome.webNavigation.getFrame({frameId:0})` for the playback tab is re-read before permission and injection. A provider-side origin hop creates a new permission boundary instead of reusing stale access.

## D-014 — Tab lifecycle is explicit
**Status:** SUPERSEDED_IN_PART_BY_D-029

Closing the controller tab terminates the global session and closes any owned playback surfaces. Programmatic episode transition clears the playback-tab identity before closing it so expected closure cannot be mistaken for an unexpected surface loss. D-029 supersedes the former rule that manually closing the current playback tab terminates the whole session: playback-surface loss now blocks the active session instead of silently releasing the browser-wide session lock.

## D-015 — Initial provider set
**Status:** USER_DECISION

Current deterministic preference is `VOE -> Doodstream`. The popup allows either current provider to be preferred explicitly. FileMoon is not a selectable or fallback provider. Availability still comes from the current controller page; no provider is invented when absent.


## D-016 — Bounded trusted JW activation for hands-free startup
**Status:** USER_REQUIREMENT + SETTLED_ARCHITECTURE

The product target is no additional media click after the explicit extension Start action. Ordinary JW `play()` remains primary. When JW reports autoplay denial or startup timeout, the Provider Agent may request exactly one trusted activation attempt for the current episode.

The first implementation used CDP `Runtime.evaluate(..., userGesture:true)`, but live Edge evidence showed that this still did not start audible JW playback. The admitted transport now uses `chrome.debugger` only on the canonical playback tab and dispatches exactly one `Space` keydown/keyUp pair through CDP `Input.dispatchKeyEvent`, then detaches immediately. Chromium fixture evidence confirms that this targeted background-tab event is `isTrusted`, carries transient user activation, and does not require bringing the playback tab/window to the OS foreground. Arbitrary keys, OS mouse input, general pointer automation, Network/DOM/Fetch/Storage inspection, arbitrary coordinates, and focus forcing remain forbidden. D-024 separately admits one semantically resolved JW Cast-control click. Failure returns to explicit BLOCKED state.

The stronger `debugger` manifest permission and its browser warning are accepted as the cost of the hands-free requirement. This exception is semantic: it reproduces only JW's documented Space Play/Pause interaction inside the playback target; it is not a general browser-input capability.

## D-017 — JW viewport and Space compatibility are technology-driver concerns
**Status:** IMPLEMENTED_ARCHITECTURE

Provider wrappers may alter JW layout or consume the Space key. The JW driver, not provider-specific code, owns these compatibility corrections:
- preserve native JW controls;
- neutralize clipping/transform containment around the canonical JW surface;
- use JW `resize("100%", viewportHeight)` in addition to viewport CSS;
- map only the user's real, otherwise-unconsumed Space key to native JW play/pause.

Other JW keyboard shortcuts stay native. The ordinary shortcut adapter never synthesizes keys; the separate hands-free recovery exception is governed exclusively by D-016 and is limited to its fixed targeted Space pair.


## D-018 — FileMoon deferred from current provider scope
**Status:** USER_DECISION

FileMoon is removed from automatic selection, explicit popup selection, and current M5 provider acceptance. The user observed a `captcha-gate__intro`/user-gate requiring a player click and chose to defer FileMoon rather than automate that gate. The generic JW driver remains provider-neutral and reusable if FileMoon is reconsidered later.


## D-019 — Single HTML5 control owner + bounded trusted HTML5 activation
**Status:** IMPLEMENTED_ARCHITECTURE + LIVE_FAILURE_CORRECTION

Live Doodstream evidence on 2026-09-27 reached `playmogo.com`, entered browser fullscreen, exposed an existing provider player UI, but v0.3.3 layered QEC controls over it and ended in `PLAY_START_TIMEOUT` with `paused=true`, `ready=4`, `try=0`.

The correction stays inside Provider Frame Agent ownership:
- the agent marks exactly one selected HTML5 media element as canonical;
- a detected provider-owned HTML5 skin/control surface remains the only visible player UI; QEC and browser-native controls are suppressed there;
- only bare/unskinned HTML5 receives QEC fallback controls;
- HTML5 startup attempt #1 runs immediately rather than through a possibly throttled background timer;
- on `AUTOPLAY_BLOCKED` / `PLAY_START_TIMEOUT`, exactly one `Runtime.evaluate(..., userGesture:true)` activation may call `.play()` on the already-marked canonical media element in the playback tab, then the debugger detaches immediately.

This does not authorize media discovery in the debugger transport, arbitrary DOM inspection, arbitrary script execution, general page clicking, OS input, OS mouse input, arbitrary coordinates, focus forcing, or repeated activation loops. D-024 is the only separate pointer-input exception. JW continues to use its separate fixed Space transport from D-016.


## D-018 — Shared episode-source adapter profiles
**Status:** IMPLEMENTED_ARCHITECTURE

AniWorld plus the SerienStream mirror family (`serienstream.to`, `s.to`, `serienstream.cx`, and `http://186.2.175.5/`) use one canonical Episode Site Adapter contract. Mirror host differences are declarative host/path profiles only. The adapter accepts both the AniWorld/legacy hoster-link layout and the current SerienStream/S.to `#episode-links .link-box[data-play-url]` layout, normalizing both to the same provider-navigation contract. Provider selection, next-episode rules, and playback lifecycle must not be copied per site or mirror.


## D-019 — Known live provider origins are install-time permissions
**Status:** USER_REQUIREMENT + IMPLEMENTED_ARCHITECTURE

The hands-free goal includes the very first playback after a fresh installation. Therefore provider origins that have been confirmed by current live evidence may be declared narrowly in `host_permissions` instead of forcing a first-play runtime grant. Current install-time provider origins are `https://playmogo.com/*`, `https://voe.sx/*`, and `https://jeremyparticipantanything.com/*`.

This is deliberately not a blanket `https://*/*` admission. Unknown or rotated provider origins still use the exact-origin optional permission flow and resume the same inactive playback tab after the user grants access. When current live provider aliases change, update the narrow known-origin set with evidence rather than broadening access silently.


## D-020 — Auto provider selection owns bounded runtime failover
**Status:** USER_DECISION + IMPLEMENTED_ARCHITECTURE

`Auto` means more than initial provider priority. For each episode, Session Core owns a per-episode provider-attempt ledger. It selects the first available provider in configured priority order, permits the provider's one bounded startup-recovery attempt, and if the provider then reaches a terminal setup/playback failure it closes that playback tab and tries the next untried provider exposed by the same controller episode.

Terminal failover reasons include provider setup/attach failure, `PLAYER_NOT_FOUND`, `USER_ACTIVATION_REQUIRED`, `MEDIA_ERROR`, and `AUTOPLAY_BLOCKED`/`PLAY_START_TIMEOUT` after the one trusted recovery attempt. `MEDIA_STALLED` alone is not terminal because transient stalls must not cause provider churn. Permission-required state is also not treated as provider failure: the exact-origin permission workflow remains explicit.

A provider is attempted at most once per episode. If no untried supported provider remains, the session becomes `BLOCKED / NO_WORKING_PROVIDER`. `beginEpisode` resets the attempt/failure ledger. Explicit `VOE` or `Doodstream` selection is strict and disables runtime failover.


## D-021 — Provider-owned Google Cast session continuity
**Status:** USER_DECISION + EXPERIMENTAL_IMPLEMENTATION

The user wants Chromecast/Google Cast continuity without switching to generic browser tab casting. The first device selection remains inside the provider player's own Cast UI because that path preserves the provider's sender/receiver behavior. Once the provider page exposes a connected Google Cast Web Sender session, QEC may retain only its `sessionId`, device name, receiver application ID, and remote playback state for the current QEC session.

On later episodes QEC may call the provider page's existing `chrome.cast.requestSessionById(sessionId)` a bounded number of times to rejoin the same Cast session. Remote Cast PLAYING/FINISHED state feeds the existing canonical media lifecycle so automatic next-episode progression can work while local video is paused after handoff.

QEC must not scan the LAN, auto-select a device, extract Cast/media `contentId`, call `loadMedia()`, create a receiver application, or reconstruct provider stream requests. Provider/receiver incompatibility is allowed to fall back to ordinary local playback. This feature remains experimental until verified against a real Cast device and at least one live provider.


## D-022 — Cast completion is event-driven; hidden-page startup escalates early
**Status:** LIVE_FAILURE_CORRECTION + IMPLEMENTED_ARCHITECTURE

Live v0.5.0 evidence showed that a connected provider-created Cast session could remain visible to QEC as `MEDIA_PLAYING` even after the receiver had naturally finished. Therefore Cast lifecycle observation must not depend on periodic `getMediaSession()` polling alone. The Cast MAIN-world bridge owns event-driven observation through the provider-loaded Google Cast `RemotePlayerController`; polling remains a compatibility fallback only.

A natural remote end is accepted from either explicit `IDLE + FINISHED` media status or a bounded equivalent: the Cast session remains connected, remote playback was previously observed, remote media becomes unloaded/idle, and the last loaded remote position was within three seconds of the known duration. This fallback must not classify an early manual stop as episode completion. All resulting end signals still enter the single canonical `MEDIA_ENDED` lifecycle and Session Core deduplicates navigation.

Live Chrome evidence also showed ~10-second startup delay/intermittent failure. Ordinary provider play remains the first action, but hidden-page timer retries are not allowed to delay the trusted recovery for most of the 12-second startup window. JW attempt #1 runs immediately, then requests the existing one-attempt targeted trusted activation after approximately 1.2 seconds without real PLAY/FIRST_FRAME. HTML5 requests the same bounded trusted activation early after policy rejection, a hanging play promise, or a resolved-but-still-paused first start. The long startup deadline remains the terminal verification/failover bound rather than the normal recovery latency.


## D-023 — Retained Cast rejoin must update the new JW episode through JW's native Cast API
**Status:** SUPERSEDED_BY_D-028

Live v0.5.1 evidence proved that Cast completion can advance the controller and open the next VOE episode while the saved Cast session remains visible, but `requestSessionById(sessionId)` alone does not move the new episode to the receiver. Rejoin is therefore only session transport, not media handoff.

When a later episode is using JW Player and a sticky provider-created Cast session is successfully rejoined, Provider Agent must temporarily suppress local JW startup and ask the existing JW player to update that Cast session through JW's native `requestCast()` API. The current playlist item may be obtained inside the JW MAIN-world bridge and passed directly to `requestCast([currentItem])`; that playlist object was originally prohibited from crossing extension messages. Live v0.5.2-v0.5.6 evidence showed that same-page/rejoin variants did not transfer the next episode; D-028 therefore supersedes only that transport prohibition with a narrower user-approved transient relay while retaining the no-persistence/no-inspection/no-own-load boundary.

The Cast handoff is bounded. If the retained session cannot rejoin or JW cannot hand off the current item within the resume window, ordinary local playback remains the fallback. Remote `PLAYING` is the success signal for the new episode; only then does canonical media state become `GoogleCast`. This preserves the provider's own Cast implementation instead of introducing a QEC-owned receiver or `loadMedia()` path.


## D-024 — Retained Cast media handoff uses the provider-owned native JW Cast control
**Status:** LIVE_FAILURE_CORRECTION + EXPERIMENTAL_IMPLEMENTATION

Live v0.5.2 evidence showed that `requestSessionById()` plus JW `requestCast([currentItem])` still left Chromecast `Seb` connected to the old episode while the new episode failed to transfer. The user's original manual action — clicking JW's own Cast control — remains the only live-proven media handoff path.

For a later episode with a retained provider-created Cast session, QEC therefore first rejoins that session, suppresses local JW startup, resolves only JW's native `.jw-icon-cast` control, and requests one trusted tab-local pointer click on that control through the existing `gesture-activation.js` debugger transport. The click is delivered to the playback tab via CDP and does not move the OS pointer, focus the browser, or permit arbitrary coordinate automation. JW's native `cast` event (`active`, `available`, `deviceName`) is observed as the player-level confirmation surface; remote `PLAYING` remains the canonical successful media-handoff signal.

The first device picker remains manual/provider-owned. QEC never selects a LAN device itself. If the native JW Cast control is unavailable, the prior JW `requestCast()` path may be attempted only as a bounded fallback. If neither path produces remote `PLAYING` within the resume window, QEC returns to local playback instead of looping.


## D-025 — Natural Cast completion releases the old sender without stopping the receiver
**Status:** LIVE_FAILURE_CORRECTION + EXPERIMENTAL_IMPLEMENTATION

Live v0.5.3 evidence showed that the retained device/session metadata survived, but the next VOE tab remained at `Cast: Seb · Wiederverbinden…` and eventually played locally. This indicates that keeping the receiver application alive is not sufficient if the previous provider tab remains the active sender owner until teardown.

At a natural remote episode end, the Cast MAIN-world bridge must therefore preserve the existing `sessionId`/device metadata and call the provider page's existing `CastContext.endCurrentSession(false)` before emitting canonical `MEDIA_ENDED`. The boolean `false` is required: it disconnects the old sender while leaving the receiver application running. QEC must not use `endCurrentSession(true)`/JW `stopCasting()` for this continuity path because those stop the receiver application and may require a new device-selection flow.

The next provider tab then receives the retained `sessionId`, attempts bounded `requestSessionById(sessionId)`, suppresses local JW startup during that resume window, and only then triggers the provider-owned JW Cast control. Failure remains bounded and falls back to local playback. This is still experimental until a live receiver confirms that the same device resumes without another picker.


## D-026 — Cast episode continuity uses sender overlap and provider-owned media load tracing
**Status:** LIVE_FAILURE_CORRECTION + EXPERIMENTAL_IMPLEMENTATION

Live v0.5.4 evidence showed that `CastContext.endCurrentSession(false)` ended the practical Chromecast path for VOE/Chrome instead of leaving a reusable receiver session for the next page. D-025 is therefore superseded for this provider path.

At natural remote completion the old provider playback tab remains alive as a retiring sender while the controller advances and the next provider tab opens. Session Core owns this overlap through `retiringPlaybackTabId`; the old tab is closed only after the new canonical playback tab emits real `MEDIA_PLAYING` (remote Cast preferred, local fallback if bounded Cast resume fails). The new provider page attempts `requestSessionById(sessionId)` while the old sender still exists, waits for the resumed session state, and then triggers JW's provider-owned native Cast control.

Google Cast requires a media load after session join. QEC still does not construct a `MediaInfo`/`LoadRequest`, read `contentId`, or call `loadMedia()` itself. For diagnostics only, the MAIN-world Cast bridge may wrap the provider-created `CastSession.loadMedia` function and emit metadata-only trace events `LOAD_MEDIA_CALLED`, `LOAD_MEDIA_SUCCEEDED`, or `LOAD_MEDIA_FAILED`. Arguments/media identifiers are never serialized into extension state. The popup exposes the bounded Cast trace so one real-device run can identify the exact failing stage.


## D-027 — Retained Cast rejoin initializes the new sender context before session resume
**Status:** LIVE_FAILURE_CORRECTION + EXPERIMENTAL_IMPLEMENTATION

Live v0.5.5 evidence showed a sharper failure boundary than sender overlap alone. After automatic episode rollover the new VOE/JW page reported `JW_CAST_ACTIVE`, but QEC remained at `Cast: Seb · Wiederverbinden…` and eventually played locally. The receiver displayed “Default media”. When the user then cast manually, the trace changed to repeated rejoin requests followed by `SESSION_STARTED`, JW Cast became active, canonical media became `GoogleCast`, and the receiver displayed the episode title. Therefore JW's cast-active event is not proof that the new page owns a usable Cast session or that the episode media has been loaded.

Google Cast Web Sender requires `CastContext.setOptions()` before Cast interaction is supported. For a retained QEC Cast session, the next provider page now receives both the saved `sessionId` and saved `receiverApplicationId`. Before bounded `requestSessionById(sessionId)`, the MAIN-world Cast bridge may initialize the page's existing CastContext with that exact retained application ID, `chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED`, and `resumeSavedSession=true`. This does not scan or select a receiver; the receiver was selected manually in the original provider-owned picker.

The provider remains owner of media construction/loading. QEC still must not read `contentId`, construct `MediaInfo`/`LoadRequest`, or call media load itself. To localize the real provider handoff, the Cast bridge may instrument both the Framework `CastSession.loadMedia` path and legacy `chrome.cast.Session.loadMedia` path before the manual/native handoff occurs. Only call/result metadata, API path, autoplay and a boolean indicating whether title metadata exists may cross into QEC state; media identifiers and request objects remain page-local. Remote `PLAYING` remains the only successful handoff signal.


## D-028 — Same-provider JW Cast continuity relays the next playlist item to the retained real sender
**Status:** USER_APPROVED + EXPERIMENTAL_IMPLEMENTATION

Live v0.5.6 evidence showed `JW_CAST_ACTIVE -> CAST_CONTEXT_CONFIGURED` without `SESSION_STARTED`/`SESSION_RESUMED`, without any provider `LOAD_MEDIA_*`, with local JW fallback and the Chromecast still showing “Default media”. Manual provider Cast immediately created the real session/media path and displayed the episode title. This confirms that JW's player-level `cast.active` flag is diagnostic only and must not create, clear, or identify a QEC Cast connection. Framework session events and actual remote playback own that truth.

For same-provider JW continuity, QEC may keep the previous episode's provider tab alive as the **retained real Cast sender** while one next-episode helper tab opens. The helper may obtain exactly its current provider-owned `jwplayer().getPlaylistItem()` object and send it through the dedicated `CAST_RELAY_ITEM -> CAST_RELAY_APPLY` runtime contract. The background worker may validate only that the payload is an object and route it with an ephemeral transfer token; it must not persist, log, inspect, normalize, cache, or derive media identifiers/URLs from the object. Session Core stores only relay token/state, never the item.

The retained sender passes that same opaque object directly to its existing provider-owned `jwplayer().requestCast([item])`. QEC still must not construct `MediaInfo`, construct `LoadRequest`, read `contentId`, call `loadMedia()`, download media, or expose a general stream-extraction facility. This is a narrow continuity exception, not a new media ownership path. It applies only when the retiring sender and next selected provider are the same provider and both use the existing JW driver.

Remote `PLAYING` from the retained sender is the only successful relay signal. On success Session Core promotes that retained sender back to the canonical playback surface for the new episode/epoch and closes the helper tab. On bounded relay failure or ordinary local `MEDIA_PLAYING` in the helper, the relay is discarded and QEC falls back to the existing local lifecycle. The transient playlist object must be absent from `chrome.storage.session`, popup/status diagnostics, Cast trace, and durable acceptance artifacts.

## D-029 — Global session lifecycle is independent from episode phase and playback authority
**Status:** USER_OBSERVATION_CORRECTION + IMPLEMENTED_ARCHITECTURE

Live v0.5.7 testing proved same-provider Chromecast rollover across Episode 8 -> 9 -> 10, but also exposed that popup Start/Stop state could become inconsistent after rollover and that the local JW player was no longer the playback authority. A single `state` enum was carrying three different responsibilities: whether QEC still owned a browser-wide session, what the current episode transition was doing, and which playback surface was authoritative.

Session Core remains the sole owner and now stores those responsibilities orthogonally: `lifecycle` is `ACTIVE` until explicit Stop or natural no-next completion, `state` remains the episode phase/result, and `playbackAuthority` is `NONE`, `LOCAL_PLAYER`, or `CAST`. The popup derives Start/Stop availability only from the global lifecycle. Therefore an active session remains locked browser-wide through `ARMING`, `RUNNING`, `NAVIGATING`, `BLOCKED`, Cast relay, and playback-surface replacement.

Unexpected loss of the canonical playback tab is no longer equivalent to Stop. Session Core clears the lost surface, records `BLOCKED / PLAYBACK_SURFACE_CLOSED`, preserves `ACTIVE`, and retains Cast authority when a remote Cast playback was the last proven authority. Closing the controller tab, explicit Stop, or natural series completion still ends the global lifecycle. Concurrent Start requests are serialized so they cannot create two QEC-owned sessions before storage has observed the first one.

This change does not alter D-028 media relay semantics and does not add a second session manager, provider-specific lifecycle path, or new persistence owner.

## D-030 — Retained Cast sender survives HTML5 helper startup until Cast rejoin resolves
**Status:** USER_OBSERVATION_CORRECTION + EXPERIMENTAL_IMPLEMENTATION

Live v0.5.8 testing confirmed VOE/JW rollover remained successful, but exposed a different same-provider Doodstream/HTML5 race. After remote episode completion the next Doodstream helper began local HTML5 playback immediately; the background treated any helper `MEDIA_PLAYING` as local fallback and closed the retiring Cast sender before the retained Cast session could rejoin. The observed next-episode state was therefore local `HTML5` playback with `Cast: Seb · Wiederverbinden…`, despite provider-owned Cast load tracing.

Session Core remains the single lifecycle/authority owner. While a sticky Cast session has a `retiringPlaybackTabId`, non-`GoogleCast` helper playback is not allowed to become canonical playback authority. The provider agent keeps the helper's local HTML5 playback deferred during the bounded continuation window. Because D-028's opaque media relay is explicitly JW-only, an HTML5 helper does not export media; it switches the existing continuation attempt to the already-admitted retained-session rejoin path and waits for the provider page's own Cast framework to produce real remote playback.

A confirmed matching Cast reconnect moves the HTML5 helper to `awaiting_remote`; real `REMOTE_PLAYING` is the only success signal and only then may the retiring sender close. If the bounded retained-session attempt fails, `stickyResumeFailed` releases the retiring sender and ordinary local HTML5 startup becomes the fallback. QEC still does not inspect/export HTML5 media URLs, construct Cast media requests, call `loadMedia()`, or add provider-specific session ownership.

## D-031 — Retained HTML5 Cast rejoin may request Google-owned session UI when silent by-ID rejoin is unavailable
**Status:** USER_OBSERVATION_CORRECTION + EXPERIMENTAL_IMPLEMENTATION

Live v0.5.9 Doodstream evidence narrowed the failure further. The next `playmogo.com` helper correctly entered `HTML5_CAST_REJOIN` and configured the retained receiver application (`CAST_CONTEXT_CONFIGURED`), but no `REJOIN_REQUESTED` event ever followed. The helper therefore stayed local (`MEDIA_PLAYING · player=HTML5`) while the sticky device remained `Seb · wird für diese Session beibehalten`. This is distinct from the v0.5.8 premature-retiring-tab race: v0.5.9 preserved the overlap, but the current Doodstream sender surface did not expose a usable silent `chrome.cast.requestSessionById(sessionId)` path.

The Cast MAIN-world bridge remains the sole owner of page-level Cast API access. It still tries the documented silent `requestSessionById(sessionId)` path first. If that API is absent, or the bounded rejoin attempts are exhausted without reconnecting, the bridge emits one `REJOIN_INTERACTION_REQUIRED` signal. Provider Agent may then request exactly one trusted activation through the existing `gesture-activation.js` transport. That activation calls only the bridge's fixed `__QEC_CAST_TRUSTED_REQUEST_SESSION__` entry point with transient user activation; the bridge in turn calls Google `cast.framework.CastContext.getInstance().requestSession()` once so Google's own Cast session UI can open.

This fallback is allowed only for an already-existing sticky Cast session on the canonical HTML5 helper. It is not first-device discovery, does not select a receiver, does not inspect media, and does not create or call `MediaInfo`, `LoadRequest`, or `loadMedia()` on QEC's behalf. Provider/Google code remains responsible for the actual receiver session and provider-owned media load. Real remote `PLAYING` remains the only successful handoff signal; otherwise the existing bounded timeout releases the retiring sender and falls back to local HTML5 playback.

## D-032 — Retained HTML5 Cast continuation must trigger the provider-owned Cast control after session recovery
**Status:** USER_OBSERVATION_CORRECTION + EXPERIMENTAL_IMPLEMENTATION

Live v0.5.10 Doodstream evidence again stopped at `HTML5_CAST_REJOIN -> CAST_CONTEXT_CONFIGURED`; no Google Cast dialog appeared and the next episode remained local HTML5. Inspection of the implementation exposed two separate gaps. First, the Cast bridge treated any `CastContext.getCurrentSession()` object as sufficient to suppress `requestSessionById`, even when its session id did not match the retained QEC session. Second, even a correctly recovered Cast session only restores sender/session ownership; unlike the JW D-028 path it does not itself transfer the new HTML5 episode to the receiver.

The Cast MAIN-world bridge therefore considers a rejoin satisfied only when the current session id exactly matches the retained `sessionId`; a stale/foreign session no longer suppresses the documented by-id rejoin attempt. Once the retained HTML5 session is available, Provider Agent requests exactly one provider-owned Cast-control activation before waiting for remote playback. The existing `gesture-activation.js` transport may resolve only a visible semantic Cast control inside the already-marked canonical HTML5 player surface (`google-cast-launcher`, known player Cast-control classes, or a Cast-labelled button) and issue one tab-local CDP pointer move/press/release sequence at that resolved control. No arbitrary page coordinate or provider-specific lifecycle owner is introduced.

If no semantic HTML5 Cast control exists, D-031 remains the bounded fallback: one trusted call to the fixed Cast bridge `CastContext.requestSession()` entry point may open Google's own session UI. QEC still never selects a receiver, inspects/exports HTML5 media, constructs `MediaInfo`/`LoadRequest`, or calls `loadMedia()` itself. The provider remains responsible for loading the new episode; only real remote `PLAYING` completes the handoff.

## D-033 — Chromecast playback controls use the existing Cast remote controller
**Status:** USER_DECISION + IMPLEMENTED_ARCHITECTURE

After live v0.5.7/v0.5.8 VOE rollover succeeded, the local JW/web player was no longer a reliable control surface for the remote receiver. The Chromecast is therefore the playback authority while `playbackAuthority = CAST`; QEC does not attempt to keep a second local player synchronized with it.

The existing `cast-main-bridge.js` `RemotePlayer`/`RemotePlayerController` path remains the sole page-level Cast control owner. The popup may issue only a small semantic command contract through Background -> canonical playback tab -> Provider Agent -> Cast bridge: `TOGGLE_PLAY_PAUSE`, `SEEK_RELATIVE`, `SEEK_TO`, and `STOP`. Background accepts those commands only for the active QEC session while the stored Cast session is connected, remote control is available, and Cast is the current playback authority. The bridge revalidates the expected Cast `sessionId` before executing any command.

The popup displays Cast controls only from remote Cast state: remote player state, current time, duration and media-loaded state. It never derives the Cast seek bar from JW/HTML5 local playback. Explicit QEC Stop performs a best-effort remote media stop before ending the QEC lifecycle and closing the sender surface. No new Cast/session owner, media extraction, receiver selection, or QEC-owned media loading is introduced.

## D-034 — Cast remote control supports the active sender's framework or legacy media control surface
**Status:** USER_OBSERVATION_CORRECTION + IMPLEMENTED_ARCHITECTURE

Live v0.5.12 VOE evidence showed a valid QEC Cast authority (`Wiedergabe: Chromecast`, connected device, GoogleCast media) while the popup control strip remained hidden. The release package contained the controls; the actual gating failure was that D-033 treated `cast.framework.RemotePlayer`/`RemotePlayerController` as the only valid Cast command surface. The live JW/VOE sender can expose an active `chrome.cast.media.Media` session without exposing that Framework controller pair to QEC.

`cast-main-bridge.js` remains the sole page-level Cast control owner. It now resolves one control driver behind the existing semantic contract: prefer Framework `RemotePlayerController`; otherwise, when the active Cast session exposes a loaded `chrome.cast.media.Media` with `play`, `pause`, `seek`, and `stop`, use that provider/Google-owned media object. The popup and Background continue to route only `TOGGLE_PLAY_PAUSE`, `SEEK_RELATIVE`, `SEEK_TO`, and `STOP`; they do not learn either implementation.

Remote progress also stays Cast-owned. The bridge prefers Framework `RemotePlayer` time/duration; on the legacy-media driver it uses `Media.getEstimatedTime()`/`currentTime` and the active media duration. The expected Cast session id is still revalidated before commands. No new Cast/session owner, media extraction, receiver selection, or QEC-owned `loadMedia()` path is introduced.

**Live verification (2026-09-28):** Edge + Chromecast testing on VOE confirmed the v0.5.13 control surface works and continues to work after the automatic next-episode rollover. This verifies D-034 on the live VOE path; Doodstream/playmogo retained-Cast rollover remains deferred.
