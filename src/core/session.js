import { PlaybackAuthority, SessionLifecycle, SessionState } from "./protocol.js";

function copy(session, patch) {
  return { ...session, ...patch, updatedAt: Date.now() };
}

export function createSession({ sessionId, tabId, windowId, fullscreen = true, providerPriority = [], providerFailoverEnabled = false }) {
  if (!sessionId || !Number.isInteger(tabId) || !Number.isInteger(windowId)) {
    throw new TypeError("sessionId, tabId and windowId are required");
  }
  return {
    schemaVersion: 8,
    sessionId,
    lifecycle: SessionLifecycle.ACTIVE,
    state: SessionState.ARMING,
    playbackAuthority: PlaybackAuthority.NONE,
    tabId,
    windowId,
    playbackTabId: null,
    retiringPlaybackTabId: null,
    retiringPlaybackProvider: null,
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
    cast: {
      available: false,
      connected: false,
      sticky: false,
      sessionId: null,
      deviceName: null,
      receiverApplicationId: null,
      mediaPlayerState: null,
      mediaIdleReason: null,
      relayToken: null,
      relayState: null,
      updatedAt: null
    },
    diagnostics: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

export function isSessionActive(session) {
  return Boolean(session && session.lifecycle === SessionLifecycle.ACTIVE);
}

export function isTerminal(session) {
  if (!session) return true;
  if (session.lifecycle === SessionLifecycle.ENDED) return true;
  return [SessionState.STOPPED, SessionState.COMPLETED].includes(session.state);
}

export function beginEpisode(session, probe) {
  if (!session || isTerminal(session)) return session;
  if (!probe?.supported || !probe?.episodeIdentity) {
    return block(session, "UNSUPPORTED_EPISODE_PAGE", probe?.diagnostics ?? []);
  }
  return copy(session, {
    state: SessionState.ARMING,
    playbackAuthority: PlaybackAuthority.NONE,
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

export function markPlaybackSurfaceLost(session, reason = "PLAYBACK_SURFACE_CLOSED") {
  if (!session || isTerminal(session)) return session;
  return copy(session, {
    state: SessionState.BLOCKED,
    playbackTabId: null,
    playbackDocument: null,
    playbackAuthority: session.playbackAuthority === PlaybackAuthority.CAST
      ? PlaybackAuthority.CAST
      : PlaybackAuthority.NONE,
    blockedReason: String(reason || "PLAYBACK_SURFACE_CLOSED")
  });
}

export function retirePlaybackSurface(session) {
  if (!session || !Number.isInteger(session.playbackTabId)) return session;
  return copy(session, {
    retiringPlaybackTabId: session.playbackTabId,
    retiringPlaybackProvider: session.selectedProvider?.provider ?? null,
    playbackTabId: null,
    playbackDocument: null
  });
}

export function clearRetiringPlaybackSurface(session) {
  if (!session) return session;
  return copy(session, { retiringPlaybackTabId: null, retiringPlaybackProvider: null });
}

export function beginCastRelay(session, relayToken) {
  if (!session || !relayToken) return session;
  return copy(session, {
    cast: {
      ...(session.cast ?? {}),
      relayToken: String(relayToken),
      relayState: "TRANSFERRING",
      updatedAt: Date.now()
    }
  });
}

export function clearCastRelay(session, relayState = null) {
  if (!session) return session;
  return copy(session, {
    cast: {
      ...(session.cast ?? {}),
      relayToken: null,
      relayState,
      updatedAt: Date.now()
    }
  });
}

export function promoteRetiringPlaybackSurface(session, playbackDocument = null) {
  if (!session || !Number.isInteger(session.retiringPlaybackTabId)) return session;
  return copy(session, {
    playbackTabId: session.retiringPlaybackTabId,
    retiringPlaybackTabId: null,
    retiringPlaybackProvider: null,
    playbackDocument: playbackDocument ?? session.playbackDocument,
    cast: {
      ...(session.cast ?? {}),
      relayToken: null,
      relayState: "REMOTE",
      updatedAt: Date.now()
    }
  });
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
    lifecycle: SessionLifecycle.ENDED,
    state: SessionState.STOPPED,
    playbackAuthority: PlaybackAuthority.NONE,
    transitionToken: null,
    blockedReason: null,
    pendingPermissionOrigin: null,
    playbackTabId: null,
    retiringPlaybackTabId: null,
    retiringPlaybackProvider: null,
    playbackDocument: null
  });
}



export function recordCastStatus(session, payload = {}) {
  if (!session || isTerminal(session)) return session;
  const previous = session.cast ?? {};
  const hasConnectionSignal = typeof payload.connected === "boolean";
  const nextConnected = hasConnectionSignal
    ? Boolean(payload.connected && payload.sessionId)
    : Boolean(previous.connected && previous.sessionId);
  const sticky = Boolean(previous.sticky || nextConnected);
  const trace = [...(previous.trace ?? [])];
  if (payload.traceEvent) {
    const next = String(payload.traceEvent);
    if (trace[trace.length - 1] !== next) trace.push(next);
    while (trace.length > 12) trace.shift();
  }
  const nextSessionId = hasConnectionSignal
    ? (nextConnected ? String(payload.sessionId) : (previous.sessionId ?? null))
    : (previous.sessionId ?? null);
  const reportedRemoteState = typeof payload.mediaPlayerState === "string"
    ? payload.mediaPlayerState.toUpperCase()
    : null;
  let playbackAuthority = session.playbackAuthority ?? PlaybackAuthority.NONE;
  if (nextConnected && ["PLAYING", "PAUSED", "BUFFERING"].includes(reportedRemoteState)) {
    playbackAuthority = PlaybackAuthority.CAST;
  } else if (
    playbackAuthority === PlaybackAuthority.CAST &&
    ((hasConnectionSignal && !nextConnected) || reportedRemoteState === "IDLE")
  ) {
    playbackAuthority = PlaybackAuthority.NONE;
  }
  return copy(session, {
    playbackAuthority,
    cast: {
      available: Boolean(payload.available ?? previous.available),
      connected: nextConnected,
      sticky,
      sessionId: nextSessionId,
      deviceName: nextConnected
        ? (payload.deviceName ? String(payload.deviceName) : previous.deviceName ?? null)
        : (previous.deviceName ?? null),
      receiverApplicationId: nextConnected
        ? (payload.receiverApplicationId ? String(payload.receiverApplicationId) : previous.receiverApplicationId ?? null)
        : (previous.receiverApplicationId ?? null),
      mediaPlayerState: payload.mediaPlayerState ?? previous.mediaPlayerState ?? null,
      mediaIdleReason: payload.mediaIdleReason ?? previous.mediaIdleReason ?? null,
      jwCastActive: typeof payload.jwCastActive === "boolean" ? payload.jwCastActive : (previous.jwCastActive ?? null),
      jwCastAvailable: typeof payload.jwCastAvailable === "boolean" ? payload.jwCastAvailable : (previous.jwCastAvailable ?? null),
      jwCastDeviceName: payload.jwCastDeviceName ?? previous.jwCastDeviceName ?? null,
      stickyTransferMethod: payload.stickyTransferMethod ?? previous.stickyTransferMethod ?? null,
      sessionState: payload.sessionState ?? previous.sessionState ?? null,
      castState: payload.castState ?? previous.castState ?? null,
      remoteControlAvailable: typeof payload.remoteControlAvailable === "boolean"
        ? payload.remoteControlAvailable
        : Boolean(previous.remoteControlAvailable),
      remoteControlDriver: payload.remoteControlDriver ?? previous.remoteControlDriver ?? null,
      isMediaLoaded: typeof payload.isMediaLoaded === "boolean"
        ? payload.isMediaLoaded
        : (previous.isMediaLoaded ?? null),
      remoteCurrentTime: Number.isFinite(payload.remoteCurrentTime)
        ? Number(payload.remoteCurrentTime)
        : (previous.remoteCurrentTime ?? null),
      remoteDuration: Number.isFinite(payload.remoteDuration)
        ? Number(payload.remoteDuration)
        : (previous.remoteDuration ?? null),
      relayToken: previous.relayToken ?? null,
      relayState: previous.relayState ?? null,
      trace,
      updatedAt: Date.now()
    }
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

  const remoteCastOwnsPlayback =
    session.playbackAuthority === PlaybackAuthority.CAST &&
    payload.playerKind !== "GoogleCast";
  const retainedCastTransition =
    Boolean(session.cast?.sticky) &&
    Number.isInteger(session.retiringPlaybackTabId) &&
    payload.playerKind !== "GoogleCast";

  if (type === "MEDIA_PLAYING") {
    if (retainedCastTransition) {
      return {
        session: copy(session, { lastMedia: { type, payload, at: Date.now() } }),
        action: null
      };
    }
    return {
      session: copy(session, {
        state: SessionState.RUNNING,
        playbackAuthority: remoteCastOwnsPlayback
          ? PlaybackAuthority.CAST
          : (payload.playerKind === "GoogleCast" ? PlaybackAuthority.CAST : PlaybackAuthority.LOCAL),
        blockedReason: null,
        lastMedia: { type, payload, at: Date.now() }
      }),
      action: null
    };
  }

  if (type === "MEDIA_PLAY_BLOCKED") {
    if (remoteCastOwnsPlayback) {
      return {
        session: copy(session, { lastMedia: { type, payload, at: Date.now() } }),
        action: null
      };
    }
    return {
      session: block(copy(session, {
        playbackAuthority: PlaybackAuthority.NONE,
        lastMedia: { type, payload, at: Date.now() }
      }), payload.reason || "AUTOPLAY_BLOCKED"),
      action: null
    };
  }

  if (type === "MEDIA_ERROR") {
    if (remoteCastOwnsPlayback) {
      return {
        session: copy(session, { lastMedia: { type, payload, at: Date.now() } }),
        action: null
      };
    }
    return {
      session: block(copy(session, {
        playbackAuthority: PlaybackAuthority.NONE,
        lastMedia: { type, payload, at: Date.now() }
      }), "MEDIA_ERROR"),
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
        lifecycle: SessionLifecycle.ENDED,
        state: SessionState.COMPLETED,
        playbackAuthority: PlaybackAuthority.NONE,
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
      playbackAuthority: PlaybackAuthority.NONE,
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
