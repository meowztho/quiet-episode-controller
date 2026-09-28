# Research / External Constraints

Checked/reconciled through 2026-09-27.

## Current architectural conclusion

The first implementation controlled provider media inside AniWorld's embedded cross-origin iframe. Live Edge testing proved that provider-side redirect/origin churn made that path unnecessarily fragile.

The current v0.2 architecture instead uses AniWorld only as the episode/provider-entry source. Its `/redirect/...` provider entry is opened in a temporary **top-level playback tab**. The extension then resolves the current top-level provider document with `chrome.webNavigation.getFrame({frameId: 0})`, requests that exact origin when necessary, and injects the generic media agent there.

This removes the need for `webRequest`, sub-frame identity tracking, and site-side provider clicking.

## Fullscreen/presentation constraint

DOM `requestFullscreen()` is activation-sensitive, so repeated native element-fullscreen transitions are not the primary unattended primitive. The Window Controller keeps the browser window fullscreen. Recognized JW Player surfaces are expanded through fixed viewport CSS plus the documented JW `resize(width, height)` API; wrapper transform/containment that would clip fixed descendants is neutralized locally by the JW driver. Generic HTML5 remains a fallback presentation path.

## Autoplay / startup constraint

Ordinary media/JW `play()` may be rejected by browser autoplay policy. v0.3 first tried a narrowly constrained CDP `Runtime.evaluate(..., userGesture:true)` recovery, but live Edge evidence showed that audible JW playback still did not start. v0.3.1 therefore changes only the activation transport: `chrome.debugger` attaches to the canonical playback tab, dispatches exactly one Space rawKeyDown/keyUp pair with CDP `Input.dispatchKeyEvent`, and detaches immediately. A Chromium fixture with another page kept in front verified that the playback document receives the targeted Space as `isTrusted: true` with `navigator.userActivation.isActive: true`. This is browser-targeted input to the playback target, not Windows/OS keyboard input; it does not require foregrounding Edge. Arbitrary keys, mouse/pointer input, Network/DOM/Fetch/Storage inspection, coordinates, and focus forcing remain forbidden.

A separate class of startup failure is transient provider/media initialization (`AbortError`, source replacement, metadata not ready). Those conditions remain bounded/retried and `RUNNING` is declared only after a real player/media playing event.

## Current open verification questions

1. Does opening AniWorld's current provider redirect as a top-level tab work for the current VOE/DoodStream provider set without provider-specific referrer/embed restrictions?
2. Does the final provider top-level document expose the playable `<video>` directly in frame 0, or does any provider introduce a nested cross-origin player iframe?
3. Does ordinary `video.play()` succeed in the user's Edge profile for each provider?
4. Can DoodStream be exercised again when its current service path is available?
5. Does a real `MEDIA_ENDED` close the playback tab, advance the background AniWorld controller, and create exactly one fresh playback tab without focusing Edge over the user's game/work?

## Current player-technology evidence (2026-09-27)

The user-provided direct playback URL `https://jeremyparticipantanything.com/e/ddhl1ul2kwbv` resolves as a VOE embed page. Current public VOE operator notes from August 2026 report a JW Player update to 8.49.5, and JW Player's current web API exposes play/pause/seek/volume/state/completion events plus native keyboard shortcuts. This invalidates the earlier assumption that promoting the raw `<video>` is the best primary control path for provider pages that expose JW Player.

Implementation consequence: inject a MAIN-world JW bridge, preserve the native `.jwplayer` container/UI, normalize JW events into the existing Provider Agent contract, and retain generic HTMLMediaElement behavior only as fallback.

References:
- https://jeremyparticipantanything.com/e/ddhl1ul2kwbv
- https://wjunction.com/threads/voe-sx-1-premium-video-hosting-ultra-fast-reliable-premium-statistics-auto-payouts-api-anti-adblock.250463/page-98
- https://docs.jwplayer.com/players/docs/jw8-reference
- https://docs.jwplayer.com/players/docs/players-web-player-accessibility
- https://developer.chrome.com/docs/extensions/reference/api/scripting


Additional v0.3/v0.3.1 references:
- https://developer.chrome.com/docs/extensions/reference/api/debugger
- https://chromedevtools.github.io/devtools-protocol/tot/Input/
- https://docs.jwplayer.com/players/reference/resize_width_-_height_


## Deferred provider note — FileMoon

Live Edge testing on 2026-09-27 exposed a FileMoon `captcha-gate__intro`/user-gate requiring a player click. The user explicitly deferred FileMoon from the current hands-free provider set. Current implementation must not select it automatically or explicitly and must not automate/bypass that gate.

## 2026-09-27 Doodstream live retest

User Edge evidence reached a Doodstream playback tab at `https://playmogo.com` but stopped before provider attachment with `PROVIDER_PERMISSION_REQUIRED`. Because fullscreen is intentionally entered only after provider attachment, the observed lack of fullscreen/autostart at that point does not yet prove a Dood player defect. Current public ecosystem evidence also identifies `playmogo.com` as a DoodStream alias. v0.3.3 therefore predeclares only `https://playmogo.com/*`; later redirect origins still require exact runtime permission and remain observable.


## 2026-09-27 Doodstream post-permission live evidence

User Edge evidence on v0.3.3 reached the Doodstream player after the `playmogo.com` permission correction. Browser fullscreen succeeded. The page already exposed its own player controls, while QEC's generic HTML5 overlay produced a second control surface. Playback did not start automatically; popup evidence was `BLOCKED / PLAY_START_TIMEOUT / MEDIA_PLAY_BLOCKED / paused=true / ready=4 / try=0`. This narrows the defect to the HTML5 fallback/startup path rather than provider navigation, permission, or window-fullscreen ownership. v0.3.4 preserves provider-owned HTML5 controls, runs the first HTML5 play attempt immediately, and adds one bounded background-tab `userGesture:true` activation for the Provider Agent-marked canonical media. Live success remains pending user Edge retest.


## 2026-09-27 Doodstream v0.3.4 live success

User Edge retest confirmed the v0.3.4 Doodstream correction works: fullscreen, hands-free autoplay, and the single provider-owned control surface all function on the observed `playmogo.com` path. This validates the Doodstream HTML5/Plyr-style driver path for that live surface/date; it does not remove the need for future compatibility evidence when provider implementations change.

## v0.4.0 controller-source and permission UX

AniWorld, SerienStream, and the SerienStream IP mirror now share one Episode Site Adapter. Unknown provider origins are still exact-permission boundaries, but the provider redirect is resolved in an inactive playback tab. If access is needed, the popup remains the user-action surface; after permission grant, QEC activates and reuses the same tab/session automatically rather than requiring tab cleanup and another Start.


## 2026-09-28 Google Cast continuity research

The user's player-side Cast behavior matches the Google Cast Web Sender model: the browser page remains a sender/controller while playback runs on a receiver. Google's Web Sender documentation exposes `cast.framework.CastContext.getCurrentSession()` for the active `CastSession`, `CastSession.getCastDevice()` for the connected device, and remote player/session status events. Google's advanced Web Sender guidance explicitly documents saving a `CastSession` ID and later rejoining with `chrome.cast.requestSessionById(sessionId)`.

QEC therefore reuses only the provider-created Cast session. It does not use browser tab mirroring as the primary path and does not build its own media load request. The first picker remains provider/Google-owned. A MAIN-world bridge observes session/device/remote-state metadata, boundedly requests rejoin on the next provider page, and maps remote FINISHED to the existing episode-end contract.

References:
- https://developers.google.com/cast/docs/web_sender/integrate
- https://developers.google.com/cast/docs/web_sender/advanced


## 2026-09-28 live Cast-end and Chrome startup findings

Real user testing of v0.5.0 on VOE proved partial Cast integration: QEC adopted the provider-created Cast session, retained device `Seb`, and reported `MEDIA_PLAYING · player=GoogleCast`. At the natural receiver end, however, QEC remained `RUNNING`; therefore the polling-only `getMediaSession()` end detector was insufficient for the live provider/receiver path. A plausible provider behavior is that the terminal `IDLE/FINISHED` media status is transient or the media session is removed before the 500 ms poll observes it.

Google's current Web Sender guidance recommends registering `RemotePlayerController` listeners for remote player/media state changes. v0.5.1 therefore treats `PLAYER_STATE_CHANGED`, `IS_MEDIA_LOADED_CHANGED`, `MEDIA_INFO_CHANGED`, and `IS_CONNECTED_CHANGED` as the primary Cast observation path. Polling remains only a fallback. If a previously playing remote item unloads while the Cast session remains connected and its last loaded position was within three seconds of the known duration, QEC normalizes that as remote natural completion even when `getMediaSession()` has already disappeared. Early manual stop away from the end is not classified as completion.

The same live report found Chrome noticeably slower and less reliable than Edge: startup often took roughly ten seconds and once required a second Start. QEC's JW startup previously retried ordinary provider `play()` for up to 12 seconds before trusted activation. Chrome documents background/hidden-tab timer throttling, so v0.5.1 removes the timer dependency from JW attempt #1 and requests the already-bounded trusted activation after ~1.2 seconds without a real PLAY/FIRST_FRAME. HTML5 similarly escalates early on policy rejection, hanging play promises, or resolved-but-still-paused playback while keeping the long timeout only as final verification/failover.

References:
- https://developers.google.com/cast/docs/web_sender/integrate
- https://developers.google.com/cast/docs/reference/web_sender/cast.framework.RemotePlayerController
- https://developer.chrome.com/blog/background_tabs
- https://developer.chrome.com/blog/timer-throttling-in-chrome-88


## 2026-09-28 native JW Cast-control handoff finding

Live v0.5.2 testing falsified the assumption that `jwplayer().requestCast([currentItem])` on a newly loaded provider page reproduces the player's manual Cast handoff. Chromecast `Seb` remained connected with the previous episode instead of receiving the new one.

Current JW documentation confirms that the player exposes a `cast` event carrying `active`, `available`, and `deviceName`, and its skin exposes the Chromecast control as `.jw-icon-cast`. JW documents `requestCast()` as the public API to cast/update media, but historical JW issue #3441 records an important behavioral distinction: a programmatic click on a Cast launcher did not behave like a real user click, while clicking JW's own Cast button manually did. That is consistent with the user's live observation that player-native Cast behaves differently from browser/tab casting and with v0.5.2 failing despite an active rejoined Cast session.

v0.5.3 therefore tests the provider-native path directly: after rejoining the already chosen device/session, QEC uses a trusted tab-local CDP pointer event on the semantic JW Cast control and observes JW's `cast` event plus remote `PLAYING`. This remains a narrow player-control transport, not general mouse automation.

Sources: JW `cast` events and casting API (`docs.jwplayer.com/players/reference/cast-events`, `.../casting`), JW CSS skin reference for `.jw-icon-cast`, Google Cast Web Sender advanced session rejoin guidance, and jwplayer/jwplayer issue #3441 for the manual-vs-programmatic Cast-control behavior.


## 2026-09-28 sender-overlap and provider loadMedia finding

Live v0.5.4 testing showed that calling `endCurrentSession(false)` before the next episode caused the Chromecast path to end and did not automatically reconnect. This falsifies the previous sender-release hypothesis for the current VOE/JW provider behavior.

Google Cast Web Sender documentation explicitly separates session rejoin from media loading: `requestSessionById(sessionId)` rejoins an existing Cast session, while `CastSession.loadMedia(loadRequest)` loads new media. Google's advanced guide notes that after rejoin the sender must add its own business logic to load new content or only resume the session. JW's native Cast control is therefore expected to be the provider-owned code path that constructs the next episode's Cast media request. v0.5.5 keeps the old sender alive during rejoin and instruments only whether the provider-owned `loadMedia()` was called/succeeded/failed; request/media identifiers are not emitted.

Sources: Google Cast Web Sender integration/advanced-session documentation and JW Player Cast/requestCast documentation.


## 2026-09-28 CastContext initialization and dual load-path finding

Live v0.5.5 testing narrowed the failure further. Automatic rollover reached a new VOE/JW page that emitted `JW_CAST_ACTIVE`, but the retained session remained at `Wiederverbinden…` and local JW playback started. The Chromecast displayed “Default media”. A subsequent manual provider Cast produced `SESSION_STARTED`, switched QEC to `GoogleCast`, and caused the receiver to display the episode title. This means player-level cast-active state can exist without a usable resumed sender session/media load.

Google's Web Sender reference states that Cast interaction is not supported until `CastContext.setOptions()` has been called. `ORIGIN_SCOPED` auto-join allows a sender with the same application ID and origin to connect to a running session regardless of tab, and `CastOptions.resumeSavedSession` exists specifically for session rejoin. QEC v0.5.6 therefore passes the already-observed receiver application ID to the next provider page and initializes its CastContext before `requestSessionById()`.

Google also exposes both the modern `cast.framework.CastSession.loadMedia()` and the legacy `chrome.cast.Session.loadMedia(...)` API. v0.5.5 only wrapped the modern session instance after discovery and could therefore miss the real manual JW load. v0.5.6 instruments both provider-owned paths as early as the Cast SDK permits, while retaining the rule that no request object, `contentId`, or media URL leaves the provider page.

Sources: Google Cast Web Sender integration, `CastContext`, `CastOptions`, `AutoJoinPolicy`, framework `CastSession`, and legacy `chrome.cast.Session` references; JW Player `requestCast()`/Cast documentation.

## 2026-09-28 Doodstream silent Cast-rejoin API gap

Live v0.5.9 Doodstream evidence reached `HTML5_CAST_REJOIN -> CAST_CONTEXT_CONFIGURED` but never emitted `REJOIN_REQUESTED`. The helper remained local HTML5 while the retained device metadata stayed present. In the implementation, `REJOIN_REQUESTED` is emitted only after an actual `chrome.cast.requestSessionById(sessionId)` call, so the live trace is evidence that the current Doodstream/playmogo sender surface did not expose a usable silent by-ID rejoin path at that point.

Google's current Web Sender advanced guide still documents `chrome.cast.requestSessionById(sessionId)` as the way to rejoin a known Cast session. The Framework reference separately documents `CastContext.requestSession()` as the API that opens Google's Cast selection/session UI. v0.5.10 therefore preserves `requestSessionById` as the preferred silent path and uses `CastContext.requestSession()` only as a one-shot, trusted-user-activation fallback for an already-retained HTML5 Cast session when silent rejoin is unavailable or exhausted. QEC still does not select the receiver or construct/load media.

References:
- https://developers.google.com/cast/docs/web_sender/advanced
- https://developers.google.com/cast/docs/reference/web_sender/chrome.cast
- https://developers.google.com/cast/docs/reference/web_sender/cast.framework.CastContext

## 2026-09-28 Doodstream session-rejoin vs media-transfer finding

Live v0.5.10 again stopped at `HTML5_CAST_REJOIN -> CAST_CONTEXT_CONFIGURED` with no Cast dialog and no remote playback. Code inspection showed that the previous fallback targeted only Cast session acquisition. It did not reproduce the provider-owned action that causes the new HTML5 episode to be loaded on the receiver. The bridge also treated any `CastContext.getCurrentSession()` result as sufficient to skip `requestSessionById`, even if that session id was not the retained QEC session.

Google's Web Sender documentation distinguishes these responsibilities: `requestSessionById(sessionId)` rejoins an existing session, while media transfer remains application business logic and normally occurs through the sender application's own media-loading path. `CastContext.requestSession()` opens Google's session UI but does not by itself define the provider's new-media load. v0.5.11 therefore preserves the provider as media-transfer owner: only an exact retained session-id match satisfies rejoin, then QEC triggers one visible semantic Cast control inside the canonical HTML5 player surface. If no such control exists, the existing Google-owned `requestSession()` fallback remains available. Remote `PLAYING` remains the only accepted success signal.

References:
- https://developers.google.com/cast/docs/web_sender/advanced
- https://developers.google.com/cast/docs/web_sender/integrate
- https://developers.google.com/cast/docs/reference/web_sender/cast.framework.CastContext

## 2026-09-28 Cast remote-control surface

Google's current Web Sender integration documentation explicitly assigns loaded-media PLAY/PAUSE, STOP and SEEK control to `cast.framework.RemotePlayerController`, with playback state exposed by `RemotePlayer`. v0.5.12 therefore uses that already-instantiated controller as the single remote-control implementation instead of synchronizing or proxying the provider's local JW/HTML5 player. QEC's popup only routes semantic commands to the canonical provider sender and renders progress from remote Cast time/duration state.

Reference: https://developers.google.com/cast/docs/web_sender/integrate

## 2026-09-28 Cast legacy-media control fallback

The live v0.5.12 VOE test proved that a connected, authoritative Chromecast session does not guarantee that `cast.framework.RemotePlayer`/`RemotePlayerController` are exposed on the sender surface. Google's Web Sender reference also exposes loaded-media playback control directly on `chrome.cast.media.Media`: `play`, `pause`, `seek`, `stop`, plus `getEstimatedTime()` for current position. v0.5.13 therefore keeps `RemotePlayerController` as the preferred driver and uses the active Cast media session only as a compatibility fallback behind the same Cast-bridge command contract.

References:
- https://developers.google.com/cast/docs/web_sender/integrate
- https://developers.google.com/cast/docs/reference/web_sender/chrome.cast.media.Media

## 2026-09-28 v0.5.13 VOE remote-control live verification

Real Edge + Chromecast testing confirmed that the v0.5.13 compatibility driver closes the v0.5.12 popup-control defect on the live VOE/JW sender. The QEC Cast control surface works against the active Chromecast and remains functional after the automatic next-episode rollover. This is stronger than the local fixture evidence because it exercises the production extension, the provider-owned sender, the actual Chromecast receiver, and the retained-sender episode transition together.

This result verifies the VOE remote-control path only. Doodstream/playmogo automatic retained-Cast rollover remains explicitly deferred after repeated live traces stopped at `CAST_CONTEXT_CONFIGURED`; no Doodstream Cast-continuity claim is inferred from the VOE result.
