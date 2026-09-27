import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptMessage,
  beginEpisode,
  createSession,
  markProviderAttached,
  recordMedia,
  recordProviderFailure,
  selectProvider,
  setPlaybackTab,
  stop
} from "../../src/core/session.js";
import { SessionState } from "../../src/core/protocol.js";

function runningSession() {
  let session = createSession({ sessionId: "s1", tabId: 10, windowId: 20, fullscreen: true });
  session = beginEpisode(session, {
    supported: true,
    episodeIdentity: { site: "aniworld", seriesSlug: "black-torch", season: 1, episode: 1, url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-1" },
    nextEpisode: { site: "aniworld", seriesSlug: "black-torch", season: 1, episode: 2, url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-2" },
    diagnostics: []
  });
  session = setPlaybackTab(session, 30);
  session = markProviderAttached(session);
  return recordMedia(session, "MEDIA_PLAYING", {}).session;
}


test("provider attach alone stays ARMING until media actually plays", () => {
  let session = createSession({ sessionId: "s1", tabId: 10, windowId: 20, fullscreen: true });
  session = beginEpisode(session, {
    supported: true,
    episodeIdentity: { site: "aniworld", seriesSlug: "black-torch", season: 1, episode: 1, url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-1" },
    nextEpisode: null,
    diagnostics: []
  });
  session = setPlaybackTab(session, 30);
  session = markProviderAttached(session);
  assert.equal(session.state, SessionState.ARMING);

  session = recordMedia(session, "MEDIA_FOUND", { paused: true, readyState: 1 }).session;
  assert.equal(session.state, SessionState.ARMING);

  session = recordMedia(session, "MEDIA_PLAYING", { paused: false, readyState: 4 }).session;
  assert.equal(session.state, SessionState.RUNNING);
});

test("session start/episode transition produces one navigation action", () => {
  const session = runningSession();
  assert.equal(session.state, SessionState.RUNNING);
  assert.equal(session.epoch, 1);

  const first = recordMedia(session, "MEDIA_ENDED", {});
  assert.equal(first.session.state, SessionState.NAVIGATING);
  assert.equal(first.action?.type, "NAVIGATE_NEXT");
  assert.equal(first.action?.target.episode, 2);

  const duplicate = recordMedia(first.session, "MEDIA_ENDED", {});
  assert.equal(duplicate.action, null);
  assert.equal(duplicate.session.transitionToken, first.session.transitionToken);
});

test("no next episode completes instead of navigating", () => {
  let session = runningSession();
  session = { ...session, nextEpisode: null };
  const result = recordMedia(session, "MEDIA_ENDED", {});
  assert.equal(result.session.state, SessionState.COMPLETED);
  assert.equal(result.action?.type, "COMPLETE");
});

test("blocked playback is explicit and stop prevents stale restart", () => {
  let session = runningSession();
  const blocked = recordMedia(session, "MEDIA_PLAY_BLOCKED", { reason: "AUTOPLAY_BLOCKED" }).session;
  assert.equal(blocked.state, SessionState.BLOCKED);
  assert.equal(blocked.blockedReason, "AUTOPLAY_BLOCKED");

  session = stop(blocked);
  assert.equal(session.state, SessionState.STOPPED);
  assert.equal(session.playbackTabId, null);
  const ignored = recordMedia(session, "MEDIA_PLAYING", {}).session;
  assert.equal(ignored.state, SessionState.STOPPED);
});

test("media messages are accepted only from the current playback tab", () => {
  const session = runningSession();
  assert.equal(acceptMessage(session, { sessionId: "s1", epoch: 1, tabId: 30 }), true);
  assert.equal(acceptMessage(session, { sessionId: "old", epoch: 1, tabId: 30 }), false);
  assert.equal(acceptMessage(session, { sessionId: "s1", epoch: 0, tabId: 30 }), false);
  assert.equal(acceptMessage(session, { sessionId: "s1", epoch: 1, tabId: 10 }), false);
  assert.equal(acceptMessage(session, { sessionId: "s1", epoch: 1, tabId: 31 }), false);
});

test("unsupported page fails closed", () => {
  const initial = createSession({ sessionId: "s1", tabId: 1, windowId: 2 });
  const session = beginEpisode(initial, { supported: false, diagnostics: ["URL_NOT_SUPPORTED"] });
  assert.equal(session.state, SessionState.BLOCKED);
  assert.equal(session.blockedReason, "UNSUPPORTED_EPISODE_PAGE");
});


test("provider attempts and failures are scoped to one episode", () => {
  let session = createSession({
    sessionId: "s1",
    tabId: 10,
    windowId: 20,
    providerPriority: ["VOE", "Doodstream"],
    providerFailoverEnabled: true
  });
  session = beginEpisode(session, {
    supported: true,
    episodeIdentity: { site: "aniworld", seriesSlug: "black-torch", season: 1, episode: 1, url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-1" },
    nextEpisode: null,
    diagnostics: []
  });
  session = selectProvider(session, { provider: "VOE", key: "v" });
  session = recordProviderFailure(session, "PLAY_START_TIMEOUT");
  session = selectProvider(session, { provider: "Doodstream", key: "d" });

  assert.deepEqual(session.attemptedProviders, ["VOE", "Doodstream"]);
  assert.equal(session.providerFailures.length, 1);
  assert.equal(session.providerFailures[0].provider, "VOE");

  session = beginEpisode(session, {
    supported: true,
    episodeIdentity: { site: "aniworld", seriesSlug: "black-torch", season: 1, episode: 2, url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-2" },
    nextEpisode: null,
    diagnostics: []
  });
  assert.deepEqual(session.attemptedProviders, []);
  assert.deepEqual(session.providerFailures, []);
});
