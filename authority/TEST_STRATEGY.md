# Test Strategy

## Principle

Evidence must match the owner boundary. Fixture success never proves current live provider compatibility.

## 1. Session/Core tests
Cover:
- Start/Stop;
- exactly one browser-wide `ACTIVE` controller session, including concurrent Start attempts from different tabs;
- global lifecycle independently from episode phase and playback authority;
- playback-tab identity;
- unexpected canonical playback-tab closure blocks but does not silently end/release the session;
- duplicate `MEDIA_ENDED`;
- stale session/epoch/playback-tab rejection;
- no-next completion;
- blocked states;
- Auto failover after terminal provider failure;
- every provider attempted at most once per episode;
- `NO_WORKING_PROVIDER` after candidate exhaustion;
- manual provider selection never fails over.

## 2. Episode-site DOM fixtures
Cover:
- episode identity;
- next episode from links;
- same/lower episode loop rejection;
- visible provider candidates;
- canonical `provider-navigation` targets;
- VOE/Doodstream labels without provider-host guessing.

## 3. Playback Surface tests
Cover:
- provider entry URL resolution;
- exactly one temporary tab creation;
- top-level redirect settlement outside the controller site;
- current document/origin resolution;
- setup-failure cleanup.

## 4. Provider media fixtures
Cover:
- `<video>` discovery;
- viewport presentation;
- play attempt;
- Play/Pause/seek/mute/volume control surface;
- autoplay block -> explicit Start -> `MEDIA_PLAYING` recovery;
- pre-video semantic Play activation -> `<video>` discovery;
- playing/ended/error/stalled;
- video replacement;
- autoplay block.

## JW bridge feedback-loop regression

A provider fixture must verify that `PROBE`/JW `STATUS` do not cause additional
`PRESENT_VIEWPORT` commands, while JW `READY` and real window resize still
synchronize presentation once per trigger. The prior implementation loop was
bounded during diagnosis to avoid saturating Chromium memory; the baseline
reached the safety cap at 26 viewport/status pairs, and the corrected code
settled after one initial viewport command and one status response. This
fixture is not a long-duration Edge/Chromecast memory measurement.

## Cast relay state-write ordering

Simulate an older `CAST_STATUS` session-storage write held during
`CAST_RELAY_PLAYING` promotion. After the confirmed handoff closes the helper,
its tab-removal event must never resurrect the helper as canonical or enter
`PLAYBACK_SURFACE_CLOSED`. The test must fail against the previous unprotected
background dispatcher. Keep explicit Stop and stale message behavior intact.
This does not establish true Cast media progress at the receiver.

## First-episode JW startup with Cast bridge present

Load the real JW and Cast main-world bridges together, attach a provider on a
fresh episode with no retained Cast session, and verify JW normal `PLAY` reaches
`MEDIA_PLAYING` with no unexpected Cast handoff. This fixture cannot establish
live provider autoplay policy or the exact cause of the user's Edge symptom.

## Deferred Cast near-end completion recovery

v0.5.17's experimental timer-based end fallback was withdrawn in v0.5.18
after a user reported that even first-episode player start stopped working.
Until a hardware-level reproduction identifies an appropriate trigger, keep
the v0.5.16 Cast completion behavior and do not treat a near-end paused player
as a completed episode. A future change must be tested together with cold
initial start and connected/reconnected Chromecast playback.

## 5. Extension/live Edge verification
For each provider family record:
- date/revision;
- controller episode;
- provider selected;
- provider entry + current top-level origin class;
- permission flow;
- video found/play result;
- viewport presentation;
- `MEDIA_ENDED` -> playback tab close -> controller next episode -> new playback tab;
- foreground/focus interference observations.

M5/M6 cannot be completed by fixtures alone.


## Experimental Google Cast continuity

Deterministic fixture coverage must prove that a natural remote Cast end keeps the old sender tab alive as a retiring playback surface while preserving the retained session ID/device metadata, that the saved session ID plus receiver application ID are passed to the next provider page, that the new page initializes its existing `CastContext` with the retained app ID/`ORIGIN_SCOPED`/`resumeSavedSession` before `requestSessionById`, and that rejoin reconnects the session. The rejoined JW player must follow the provider-owned native Cast-control path while suppressing local startup; provider-owned media load must be observable on both Framework and legacy Cast API shapes without request/media identifiers escaping into QEC state; remote PLAYING maps to `MEDIA_PLAYING`, remote FINISHED maps to `MEDIA_ENDED`, and the retiring sender closes only after new canonical playback succeeds. Generic HTML5 fixtures must additionally prove that if `requestSessionById` is unavailable/exhausted, the bridge emits one interaction requirement, only the fixed trusted Cast-session request is admitted with `userGesture:true`, Google/Provider remains media owner, and local HTML5 still cannot become canonical before remote success or bounded fallback. Static checks must reject direct Cast page-API access outside the MAIN-world Cast bridge, reject arbitrary debugger Runtime.evaluate use, reject `contentId`/`MediaInfo` extraction/construction, and reject QEC-owned Cast media loading. Real Chromecast/Google Cast continuity remains `live_browser` evidence and cannot be inferred from fixtures.
