import { SessionState } from "./protocol.js";

function copy(session, patch) {
  return { ...session, ...patch, updatedAt: Date.now() };
}

export function createSession({ sessionId, tabId, windowId, fullscreen = true, providerPriority = [], providerFailoverEnabled = false }) {
  if (!sessionId || !Number.isInteger(tabId) || !Number.isInteger(windowId)) {
    throw new TypeError("sessionId, tabId and windowId are required");
  }
  return {
    schemaVersion: 4,
    sessionId,
    state: SessionState.ARMING,
    tabId,
    windowId,
    playbackTabId: null,
    playbackDocument: null,
    epoch: 0,
    fullscreen: Boolean(fullscreen),
    providerPriority: [...providerPriority],
    providerFailoverEnabled: Boolean(providerFailoverEnabled),
    attemptedProviders: [],
    providerFailures: [],
    currentEpisode: null,
    nextEpisode: null,
    selectedProvider: null,
    pendingPermissionOrigin: null,
    blockedReason: null,
    transitionToken: null,
    originalWindowState: null,
    changedWindowMode: false,
    playbackActivationAttempts: 0,
    lastMedia: null,
    diagnostics: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

export function isTerminal(session) {
  return [SessionState.STOPPED, SessionState.COMPLETED].includes(session?.state);
}

export function beginEpisode(session, probe) {
  if (!session || isTerminal(session)) return session;
  if (!probe?.supported || !probe?.episodeIdentity) {
    return block(session, "UNSUPPORTED_EPISODE_PAGE", probe?.diagnostics ?? []);
  }
  return copy(session, {
    state: SessionState.ARMING,
    epoch: session.epoch + 1,
    currentEpisode: probe.episodeIdentity,
    nextEpisode: probe.nextEpisode ?? null,
    selectedProvider: null,
    attemptedProviders: [],
    providerFailures: [],
    playbackTabId: null,
    playbackDocument: null,
    pendingPermissionOrigin: null,
    blockedReason: null,
    transitionToken: null,
    playbackActivationAttempts: 0,
    diagnostics: probe.diagnostics ?? []
  });
}

export function selectProvider(session, provider) {
  if (!provider) return block(session, "NO_PROVIDER_AVAILABLE");
  const providerName = String(provider.provider || "Unknown");
  const attemptedProviders = session.attemptedProviders?.includes(providerName)
    ? [...session.attemptedProviders]
    : [...(session.attemptedProviders ?? []), providerName];
  return copy(session, {
    state: SessionState.ARMING,
    selectedProvider: provider,
    attemptedProviders,
    blockedReason: null,
    pendingPermissionOrigin: null,
    playbackActivationAttempts: 0,
    lastMedia: null
  });
}

export function recordProviderFailure(session, reason, payload = null) {
  if (!session || isTerminal(session)) return session;
  const provider = session.selectedProvider?.provider ?? "Unknown";
  const failure = {
    provider,
    reason: String(reason || "PROVIDER_FAILED"),
    payload: payload ?? null,
    at: Date.now()
  };
  return copy(session, {
    state: SessionState.ARMING,
    blockedReason: null,
    pendingPermissionOrigin: null,
    playbackActivationAttempts: 0,
    providerFailures: [...(session.providerFailures ?? []), failure]
  });
}

export function setPlaybackTab(session, tabId) {
  if (tabId !== null && !Number.isInteger(tabId)) throw new TypeError("playback tab id must be an integer or null");
  return copy(session, {
    playbackTabId: tabId,
    playbackDocument: tabId === null ? null : session.playbackDocument
  });
}

export function setPlaybackDocument(session, document) {
  return copy(session, { playbackDocument: document ?? null });
}

export function clearPlaybackSurface(session) {
  return copy(session, { playbackTabId: null, playbackDocument: null });
}

export function requireProviderPermission(session, origin, document = null) {
  return copy(session, {
    state: SessionState.BLOCKED,
    blockedReason: "PROVIDER_PERMISSION_REQUIRED",
    pendingPermissionOrigin: origin,
    playbackDocument: document ?? session.playbackDocument
  });
}

export function markProviderAttached(session) {
  return copy(session, {
    state: SessionState.ARMING,
    blockedReason: null,
    pendingPermissionOrigin: null
  });
}

export function block(session, reason, diagnostics = null) {
  if (!session || isTerminal(session)) return session;
  return copy(session, {
    state: SessionState.BLOCKED,
    blockedReason: reason,
    diagnostics: diagnostics ?? session.diagnostics
  });
}

export function stop(session) {
  if (!session) return null;
  return copy(session, {
    state: SessionState.STOPPED,
    transitionToken: null,
    blockedReason: null,
    pendingPermissionOrigin: null,
    playbackTabId: null,
    playbackDocument: null
  });
}


export function recordPlaybackActivationAttempt(session) {
  if (!session || isTerminal(session)) return session;
  return copy(session, {
    playbackActivationAttempts: Number(session.playbackActivationAttempts || 0) + 1
  });
}

export function recordMedia(session, type, payload = {}) {
  if (!session || isTerminal(session)) return { session, action: null };

  if (type === "MEDIA_PLAYING") {
    return {
      session: copy(session, {
        state: SessionState.RUNNING,
        blockedReason: null,
        lastMedia: { type, payload, at: Date.now() }
      }),
      action: null
    };
  }

  if (type === "MEDIA_PLAY_BLOCKED") {
    return {
      session: block(copy(session, { lastMedia: { type, payload, at: Date.now() } }), payload.reason || "AUTOPLAY_BLOCKED"),
      action: null
    };
  }

  if (type === "MEDIA_ERROR") {
    return {
      session: block(copy(session, { lastMedia: { type, payload, at: Date.now() } }), "MEDIA_ERROR"),
      action: null
    };
  }

  if (type !== "MEDIA_ENDED") {
    return {
      session: copy(session, { lastMedia: { type, payload, at: Date.now() } }),
      action: null
    };
  }

  if (session.state !== SessionState.RUNNING || session.transitionToken) {
    return { session, action: null };
  }

  if (!session.nextEpisode) {
    return {
      session: copy(session, {
        state: SessionState.COMPLETED,
        transitionToken: null,
        lastMedia: { type, payload, at: Date.now() }
      }),
      action: { type: "COMPLETE" }
    };
  }

  const transitionToken = `${session.sessionId}:${session.epoch}:${session.nextEpisode.url}`;
  return {
    session: copy(session, {
      state: SessionState.NAVIGATING,
      transitionToken,
      lastMedia: { type, payload, at: Date.now() }
    }),
    action: {
      type: "NAVIGATE_NEXT",
      token: transitionToken,
      target: session.nextEpisode
    }
  };
}

export function acceptMessage(session, { sessionId, epoch, tabId }) {
  return Boolean(
    session &&
    !isTerminal(session) &&
    session.sessionId === sessionId &&
    session.epoch === epoch &&
    session.playbackTabId === tabId
  );
}
