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
