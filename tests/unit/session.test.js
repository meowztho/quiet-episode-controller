import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptMessage,
  beginCastRelay,
  beginEpisode,
  clearRetainedCast,
  createSession,
  isPrepareStalled,
  isSessionActive,
  markPlaybackSurfaceLost,
  markProviderAttached,
  recordCastStatus,
  recordMedia,
  recordProviderFailure,
  recordStallRecoveryAttempt,
  requireProviderPermission,
  retirePlaybackSurface,
  selectProvider,
  setPlaybackTab,
  stop
} from "../../src/core/session.js";
import { PlaybackAuthority, SessionLifecycle, SessionState } from "../../src/core/protocol.js";

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


test("cast session becomes sticky and survives episode advancement", () => {
  let session = createSession({ sessionId: "s1", tabId: 10, windowId: 20 });
  session = beginEpisode(session, {
    supported: true,
    episodeIdentity: { site: "aniworld", seriesSlug: "black-torch", season: 1, episode: 1, url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-1" },
    nextEpisode: null,
    diagnostics: []
  });

  session = recordCastStatus(session, {
    available: true,
    connected: true,
    sessionId: "cast-123",
    deviceName: "Wohnzimmer TV",
    receiverApplicationId: "CC1AD845",
    mediaPlayerState: "PLAYING"
  });

  assert.equal(session.cast.sticky, true);
  assert.equal(session.cast.connected, true);
  assert.equal(session.cast.sessionId, "cast-123");
  assert.equal(session.cast.deviceName, "Wohnzimmer TV");

  session = beginEpisode(session, {
    supported: true,
    episodeIdentity: { site: "aniworld", seriesSlug: "black-torch", season: 1, episode: 2, url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-2" },
    nextEpisode: null,
    diagnostics: []
  });

  assert.equal(session.cast.sticky, true);
  assert.equal(session.cast.sessionId, "cast-123");
  assert.equal(session.cast.deviceName, "Wohnzimmer TV");
});


test("JW Cast diagnostics cannot create or clear framework-owned connection state", () => {
  let session = createSession({ sessionId: "s1", tabId: 10, windowId: 20 });
  session = recordCastStatus(session, {
    jwCastActive: true,
    jwCastAvailable: true,
    jwCastDeviceName: "Seb",
    traceEvent: "JW_CAST_ACTIVE"
  });
  assert.equal(session.cast.connected, false);
  assert.equal(session.cast.sticky, false);
  assert.equal(session.cast.sessionId, null);

  session = recordCastStatus(session, {
    available: true,
    connected: true,
    sessionId: "cast-123",
    deviceName: "Seb",
    receiverApplicationId: "CC1AD845",
    traceEvent: "SESSION:SESSION_STARTED"
  });
  assert.equal(session.cast.connected, true);
  assert.equal(session.cast.sessionId, "cast-123");

  session = recordCastStatus(session, {
    jwCastActive: false,
    traceEvent: "JW_CAST_INACTIVE"
  });
  assert.equal(session.cast.connected, true, "diagnostic-only JW state must not clear framework connection state");
  assert.equal(session.cast.sessionId, "cast-123");
  assert.equal(session.cast.jwCastActive, false);
});


test("global session lifecycle stays active independently of episode phase", () => {
  let session = createSession({ sessionId: "s1", tabId: 10, windowId: 20 });
  assert.equal(session.lifecycle, SessionLifecycle.ACTIVE);
  assert.equal(isSessionActive(session), true);
  assert.equal(session.playbackAuthority, PlaybackAuthority.NONE);

  session = beginEpisode(session, {
    supported: true,
    episodeIdentity: { site: "aniworld", seriesSlug: "black-torch", season: 1, episode: 1, url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-1" },
    nextEpisode: { site: "aniworld", seriesSlug: "black-torch", season: 1, episode: 2, url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-2" },
    diagnostics: []
  });
  session = setPlaybackTab(session, 30);
  session = recordMedia(session, "MEDIA_PLAYING", { playerKind: "JWPlayer" }).session;
  assert.equal(session.state, SessionState.RUNNING);
  assert.equal(session.lifecycle, SessionLifecycle.ACTIVE);
  assert.equal(session.playbackAuthority, PlaybackAuthority.LOCAL);

  const ended = recordMedia(session, "MEDIA_ENDED", { playerKind: "JWPlayer" });
  assert.equal(ended.session.state, SessionState.NAVIGATING);
  assert.equal(ended.session.lifecycle, SessionLifecycle.ACTIVE);
  assert.equal(ended.session.playbackAuthority, PlaybackAuthority.NONE);
});

test("unexpected playback-surface loss blocks but does not end the global session", () => {
  let session = runningSession();
  session = recordCastStatus(session, {
    available: true,
    connected: true,
    sessionId: "cast-123",
    mediaPlayerState: "PLAYING"
  });
  assert.equal(session.playbackAuthority, PlaybackAuthority.CAST);

  session = markPlaybackSurfaceLost(session);
  assert.equal(session.lifecycle, SessionLifecycle.ACTIVE);
  assert.equal(isSessionActive(session), true);
  assert.equal(session.state, SessionState.BLOCKED);
  assert.equal(session.blockedReason, "PLAYBACK_SURFACE_CLOSED");
  assert.equal(session.playbackTabId, null);
  assert.equal(session.playbackAuthority, PlaybackAuthority.CAST);
});

test("retained JW relay ignores helper-side GoogleCast playback until the retiring sender proves relay success", () => {
  let session = runningSession();
  session = recordCastStatus(session, {
    connected: true,
    sessionId: "cast-123",
    receiverApplicationId: "CC1AD845",
    mediaPlayerState: "PLAYING"
  });
  session = retirePlaybackSurface(session);
  session = beginEpisode(session, {
    supported: true,
    episodeIdentity: { site: "aniworld", seriesSlug: "black-torch", season: 1, episode: 2, url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-2" },
    nextEpisode: null,
    diagnostics: []
  });
  session = setPlaybackTab(session, 31);
  session = beginCastRelay(session, "relay-2");

  const stray = recordMedia(session, "MEDIA_PLAYING", { playerKind: "GoogleCast", mediaPlayerState: "PLAYING" });
  assert.equal(stray.session.state, SessionState.ARMING);
  assert.equal(stray.session.playbackAuthority, PlaybackAuthority.NONE);
  assert.equal(stray.session.retiringPlaybackTabId, 30);
  assert.equal(stray.session.cast.relayState, "TRANSFERRING");

  const proven = recordMedia(stray.session, "MEDIA_PLAYING", {
    playerKind: "GoogleCast",
    mediaPlayerState: "PLAYING",
    relayTransfer: true
  });
  assert.equal(proven.session.state, SessionState.RUNNING);
  assert.equal(proven.session.playbackAuthority, PlaybackAuthority.CAST);
});

test("remote Cast authority ignores unrelated local JW playback failures until Cast becomes idle", () => {
  let session = runningSession();
  session = recordCastStatus(session, {
    connected: true,
    sessionId: "cast-123",
    mediaPlayerState: "PLAYING"
  });
  assert.equal(session.playbackAuthority, PlaybackAuthority.CAST);

  session = recordMedia(session, "MEDIA_PLAYING", { playerKind: "JWPlayer" }).session;
  assert.equal(session.playbackAuthority, PlaybackAuthority.CAST);
  assert.equal(session.state, SessionState.RUNNING);

  session = recordMedia(session, "MEDIA_ERROR", { playerKind: "JWPlayer", error: "local sender error" }).session;
  assert.equal(session.playbackAuthority, PlaybackAuthority.CAST);
  assert.equal(session.state, SessionState.RUNNING);
  assert.equal(session.blockedReason, null);

  session = recordCastStatus(session, {
    connected: true,
    sessionId: "cast-123",
    mediaPlayerState: "IDLE"
  });
  assert.equal(session.playbackAuthority, PlaybackAuthority.NONE);
});

test("local JW completion cannot advance an episode while Chromecast owns playback", () => {
  let session = runningSession();
  session = recordCastStatus(session, {
    available: true, connected: true, sessionId: "cast-123", mediaPlayerState: "PLAYING"
  });
  const localEnd = recordMedia(session, "MEDIA_ENDED", { playerKind: "JWPlayer" });
  assert.equal(localEnd.action, null);
  assert.equal(localEnd.session.state, SessionState.RUNNING);
  assert.equal(localEnd.session.playbackAuthority, PlaybackAuthority.CAST);
  assert.equal(localEnd.session.transitionToken, null);

  const castEnd = recordMedia(localEnd.session, "MEDIA_ENDED", { playerKind: "GoogleCast" });
  assert.equal(castEnd.action?.type, "NAVIGATE_NEXT");
  assert.equal(castEnd.session.state, SessionState.NAVIGATING);
});

test("local helper playback cannot steal authority while a retained Cast sender is pending", () => {
  let session = runningSession();
  session = recordCastStatus(session, {
    connected: true,
    sessionId: "cast-123",
    deviceName: "Seb",
    receiverApplicationId: "CC1AD845",
    mediaPlayerState: "PLAYING"
  });
  session = retirePlaybackSurface(session);
  session = beginEpisode(session, {
    supported: true,
    episodeIdentity: { site: "aniworld", seriesSlug: "black-torch", season: 1, episode: 2, url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-2" },
    nextEpisode: { site: "aniworld", seriesSlug: "black-torch", season: 1, episode: 3, url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-3" },
    diagnostics: []
  });
  session = setPlaybackTab(session, 31);

  const local = recordMedia(session, "MEDIA_PLAYING", { playerKind: "HTML5", paused: false }).session;
  assert.equal(local.lifecycle, SessionLifecycle.ACTIVE);
  assert.equal(local.state, SessionState.ARMING);
  assert.equal(local.playbackAuthority, PlaybackAuthority.NONE);
  assert.equal(local.retiringPlaybackTabId, 30);
  assert.equal(local.lastMedia.payload.playerKind, "HTML5");

  const remote = recordMedia(local, "MEDIA_PLAYING", { playerKind: "GoogleCast", mediaPlayerState: "PLAYING" }).session;
  assert.equal(remote.state, SessionState.RUNNING);
  assert.equal(remote.playbackAuthority, PlaybackAuthority.CAST);
});

test("stop and natural completion end the global lifecycle", () => {
  let stopped = runningSession();
  stopped = stop(stopped);
  assert.equal(stopped.lifecycle, SessionLifecycle.ENDED);
  assert.equal(isSessionActive(stopped), false);
  assert.equal(stopped.playbackAuthority, PlaybackAuthority.NONE);

  let completed = runningSession();
  completed = { ...completed, nextEpisode: null };
  completed = recordMedia(completed, "MEDIA_ENDED", { playerKind: "JWPlayer" }).session;
  assert.equal(completed.state, SessionState.COMPLETED);
  assert.equal(completed.lifecycle, SessionLifecycle.ENDED);
  assert.equal(isSessionActive(completed), false);
});

test("clearing a retained Cast identity leaves the input session untouched", () => {
  let session = createSession({ sessionId: "s1", tabId: 10, windowId: 20 });
  session = recordCastStatus(session, {
    available: true,
    connected: true,
    sessionId: "cast-123",
    deviceName: "Seb",
    receiverApplicationId: "CC1AD845",
    mediaPlayerState: "PLAYING"
  });
  session = beginCastRelay(session, "relay-token");

  const cleared = clearRetainedCast(session);
  assert.equal(session.cast.sticky, true);
  assert.equal(session.cast.sessionId, "cast-123");
  assert.equal(session.cast.relayToken, "relay-token");

  assert.notEqual(cleared, session);
  assert.equal(cleared.cast.connected, false);
  assert.equal(cleared.cast.sticky, false);
  assert.equal(cleared.cast.sessionId, null);
  assert.equal(cleared.cast.deviceName, null);
  assert.equal(cleared.cast.receiverApplicationId, null);
  assert.equal(cleared.cast.relayToken, null);
  assert.equal(cleared.cast.relayState, null);
});

test("permission blocks distinguish a new origin from a lost prior grant", () => {
  let session = createSession({ sessionId: "s1", tabId: 10, windowId: 20 });
  session = requireProviderPermission(session, "https://voe.sx");
  assert.equal(session.permissionBlockKind, "NEW_ORIGIN");
  assert.equal(session.lastGrantedPermissionOrigin, null);

  session = markProviderAttached(session);
  assert.equal(session.permissionBlockKind, null);
  assert.equal(session.lastGrantedPermissionOrigin, "https://voe.sx");

  session = requireProviderPermission(session, "https://voe.sx");
  assert.equal(session.permissionBlockKind, "PREVIOUSLY_GRANTED");

  session = markProviderAttached(session);
  session = requireProviderPermission(session, "https://playmogo.com");
  assert.equal(session.permissionBlockKind, "NEW_ORIGIN");
});

test("prepare stall recovery is bounded to one retry per episode", () => {
  const firstProbe = {
    supported: true,
    episodeIdentity: { site: "aniworld", seriesSlug: "black-torch", season: 1, episode: 1, url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-1" },
    nextEpisode: null,
    diagnostics: []
  };
  let session = createSession({ sessionId: "s1", tabId: 10, windowId: 20 });
  session = beginEpisode(session, firstProbe);
  session = setPlaybackTab(session, null);

  const stalled = { ...session, phaseStartedAt: Date.now() - 31000 };
  assert.equal(isPrepareStalled(stalled), true);
  assert.equal(isPrepareStalled({ ...stalled, playbackTabId: 30 }), false);
  assert.equal(isPrepareStalled({ ...stalled, state: SessionState.RUNNING }), false);
  assert.equal(isPrepareStalled({ ...stalled, lifecycle: SessionLifecycle.ENDED }), false);

  let retry = recordStallRecoveryAttempt(stalled);
  assert.equal(retry.stallRecoveryAttempts, 1);
  assert.equal(isPrepareStalled(retry), false, "the retry gets a fresh stall window");

  retry = beginEpisode(retry, firstProbe);
  assert.equal(retry.stallRecoveryAttempts, 1, "the retry's own episode entry must not reset the bound");
  assert.equal(retry.stallRecoveryPending, false);

  const nextProbe = {
    ...firstProbe,
    episodeIdentity: { ...firstProbe.episodeIdentity, episode: 2, url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-2" }
  };
  const next = beginEpisode(retry, nextProbe);
  assert.equal(next.stallRecoveryAttempts, 0, "a genuinely new episode gets a fresh bound");
});
