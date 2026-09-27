# Decisions

## D-001 — Chromium Manifest V3
**Status:** SETTLED

Use a standard Chrome/Edge compatible Manifest V3 extension.

## D-002 — Browser APIs/DOM only
**Status:** USER_REQUIREMENT

No OS mouse movement, OS keyboard synthesis, coordinate clicking, Alt-Tab automation, or forced foreground focus.

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

The selected supported episode site remains open in one controller tab. Each episode gets one temporary provider playback tab. At media end, that playback tab closes, the controller navigates to the next episode, and a new playback tab is created.

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
**Status:** IMPLEMENTED_ARCHITECTURE

Closing the controller tab terminates the session and closes any playback tab. Closing the current playback tab manually also terminates the session. Programmatic episode transition clears the playback-tab identity before closing it so that expected closure cannot be mistaken for user cancellation.

## D-015 — Initial provider set
**Status:** USER_DECISION

Current deterministic preference is `VOE -> Doodstream`. The popup allows either current provider to be preferred explicitly. FileMoon is not a selectable or fallback provider. Availability still comes from the current controller page; no provider is invented when absent.


## D-016 — Bounded trusted JW activation for hands-free startup
**Status:** USER_REQUIREMENT + SETTLED_ARCHITECTURE

The product target is no additional media click after the explicit extension Start action. Ordinary JW `play()` remains primary. When JW reports autoplay denial or startup timeout, the Provider Agent may request exactly one trusted activation attempt for the current episode.

The first implementation used CDP `Runtime.evaluate(..., userGesture:true)`, but live Edge evidence showed that this still did not start audible JW playback. The admitted transport now uses `chrome.debugger` only on the canonical playback tab and dispatches exactly one `Space` keydown/keyUp pair through CDP `Input.dispatchKeyEvent`, then detaches immediately. Chromium fixture evidence confirms that this targeted background-tab event is `isTrusted`, carries transient user activation, and does not require bringing the playback tab/window to the OS foreground. Arbitrary keys, mouse input, Network/DOM/Fetch/Storage inspection, OS input, coordinates, and focus forcing remain forbidden. Failure returns to explicit BLOCKED state.

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

This does not authorize media discovery in the debugger transport, arbitrary DOM inspection, arbitrary script execution, page clicking, OS input, mouse input, coordinates, focus forcing, or repeated activation loops. JW continues to use its separate fixed Space transport from D-016.


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
