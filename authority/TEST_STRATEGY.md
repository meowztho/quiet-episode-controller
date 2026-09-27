# Test Strategy

## Principle

Evidence must match the owner boundary. Fixture success never proves current live provider compatibility.

## 1. Session/Core tests
Cover:
- Start/Stop;
- exactly one controller session;
- playback-tab identity;
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
