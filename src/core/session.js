import { PlaybackAuthority, SessionLifecycle, SessionState } from "./protocol.js";

export const SESSION_SCHEMA_VERSION = 8;
export const PREPARE_STALL_TIMEOUT_MS = 30000;
export const PREPARE_STALL_RECOVERY_LIMIT = 1;

function copy(session, patch) {
  const next = { ...session, ...patch, updatedAt: Date.now() };
  if (patch.state !== undefined && patch.state !== session.state) next.phaseStartedAt = next.updatedAt;
  return next;
}

export function createSession({ sessionId, tabId, windowId, fullscreen = true, providerPriority = [], providerFailoverEnabled = false }) {
  if (!sessionId || !Number.isInteger(tabId) || !Number.isInteger(windowId)) {
    throw new TypeError("sessionId, tabId and windowId are required");
  }
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
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
    permissionBlockKind: null,
    permissionResumeKey: null,
    lastGrantedPermissionOrigin: null,
    blockedReason: null,
    transitionToken: null,
    phaseStartedAt: Date.now(),
    stallRecoveryAttempts: 0,
    stallRecoveryPending: false,
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

function isTerminal(session) {
  if (!session) return true;
  if (session.lifecycle === SessionLifecycle.ENDED) return true;
  return [SessionState.STOPPED, SessionState.COMPLETED].includes(session.state);
}

// A prepare is stalled only when the global session still owns the browser, no
// playback surface is registered, and the episode phase has not advanced for a
// full stall window. The timestamp is persisted with the session, so worker
// suspension does not erase the evidence.
export function isPrepareStalled(session, now = Date.now()) {
  if (!isSessionActive(session)) return false;
  if (![SessionState.NAVIGATING, SessionState.ARMING].includes(session.state)) return false;
  if (Number.isInteger(session.playbackTabId)) return false;
  const since = Number(session.phaseStartedAt ?? session.updatedAt ?? 0);
  return now - since > PREPARE_STALL_TIMEOUT_MS;
}

// The retry gets a fresh stall window and marks itself as the pending recovery.
// beginEpisode consumes that marker so its own re-entry cannot reset the bound.
export function recordStallRecoveryAttempt(session) {
  if (!session || isTerminal(session)) return session;
  return copy(session, {
    stallRecoveryAttempts: Number(session.stallRecoveryAttempts || 0) + 1,
    stallRecoveryPending: true,
    phaseStartedAt: Date.now()
  });
}

export function beginEpisode(session, probe) {
  if (!session || isTerminal(session)) return session;
  if (!probe?.supported || !probe?.episodeIdentity) {
    return block(session, "UNSUPPORTED_EPISODE_PAGE", probe?.diagnostics ?? []);
  }
  const recoveringPrepare = Boolean(session.stallRecoveryPending);
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
    permissionBlockKind: null,
    permissionResumeKey: null,
    blockedReason: null,
    transitionToken: null,
    playbackActivationAttempts: 0,
    stallRecoveryAttempts: recoveringPrepare ? Number(session.stallRecoveryAttempts || 0) : 0,
    stallRecoveryPending: false,
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
    permissionBlockKind: null,
    permissionResumeKey: null,
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
    permissionBlockKind: null,
    permissionResumeKey: null,
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
    permissionResumeKey: null,
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

// True only while the D-028 opaque relay is actually transferring. In that
// window the retiring sender is the sole transfer surface: a helper observing
// the same receiver must not become a second success producer.
export function isRetainedCastRelayInFlight(session) {
  return Boolean(
    session &&
    session.cast?.relayState === "TRANSFERRING" &&
    Number.isInteger(session.retiringPlaybackTabId)
  );
}

// A terminal Cast failure means the retained receiver identity is dead. Clear it
// so the next episode starts from local playback instead of retrying the same
// session forever. Successful relay/promote paths never call this.
export function clearRetainedCast(session) {
  if (!session) return session;
  return copy(session, {
    cast: {
      ...(session.cast ?? {}),
      connected: false,
      sticky: false,
      sessionId: null,
      deviceName: null,
      receiverApplicationId: null,
      mediaPlayerState: null,
      mediaIdleReason: null,
      relayToken: null,
      relayState: null,
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
  const previouslyGranted = Boolean(
    session.lastGrantedPermissionOrigin &&
    session.lastGrantedPermissionOrigin === origin
  );
  return copy(session, {
    state: SessionState.BLOCKED,
    blockedReason: "PROVIDER_PERMISSION_REQUIRED",
    pendingPermissionOrigin: origin,
    permissionBlockKind: previouslyGranted ? "PREVIOUSLY_GRANTED" : "NEW_ORIGIN",
    playbackDocument: document ?? session.playbackDocument
  });
}

export function markProviderAttached(session, origin = null) {
  return copy(session, {
    state: SessionState.ARMING,
    blockedReason: null,
    pendingPermissionOrigin: null,
    permissionBlockKind: null,
    permissionResumeKey: null,
    // Record the attached document's origin even when it was already granted
    // (for example a manifest host), so a later denial is diagnosed as a lost
    // grant rather than a brand-new origin.
    lastGrantedPermissionOrigin: origin ?? session.pendingPermissionOrigin ?? session.lastGrantedPermissionOrigin ?? null
  });
}

export function block(session, reason, diagnostics = null) {
  if (!session || isTerminal(session)) return session;
  return copy(session, {
    state: SessionState.BLOCKED,
    blockedReason: reason,
    // A different block reason starts a new block transition; the permission
    // auto-resume bound must not leak into it.
    permissionResumeKey: reason === "PROVIDER_PERMISSION_REQUIRED"
      ? (session.permissionResumeKey ?? null)
      : null,
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
    permissionBlockKind: null,
    permissionResumeKey: null,
    stallRecoveryPending: false,
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

  // During the D-028 retained-sender relay, only CAST_RELAY_PLAYING from the
  // retiring sender may prove the new remote episode. A helper page can observe
  // the same Cast session and emit GoogleCast MEDIA_PLAYING, but accepting that
  // as a second success path races the canonical relay/promotion transaction.
  if (
    type === "MEDIA_PLAYING" &&
    payload.playerKind === "GoogleCast" &&
    !payload.relayTransfer &&
    isRetainedCastRelayInFlight(session)
  ) {
    return {
      session: copy(session, { lastMedia: { type, payload, at: Date.now() } }),
      action: null
    };
  }

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

  // Local JW/HTML5 ended events must not advance the episode while the
  // receiver is the proven playback authority. Only remote Cast completion
  // may end a Cast-owned episode.
  if (remoteCastOwnsPlayback) return { session, action: null };

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
