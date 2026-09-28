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
