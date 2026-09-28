(() => {
  if (globalThis.__QEC_CAST_MAIN_BRIDGE__) return;
  globalThis.__QEC_CAST_MAIN_BRIDGE__ = true;

  const CHANNEL = "__QEC_CAST_BRIDGE_V1__";
  const POLL_MS = 1000;
  const END_NEAR_DURATION_TOLERANCE_SECONDS = 3;
  const MAX_REJOIN_ATTEMPTS = 8;
  const WRAP_MARK = "__qecCastTraceWrapped";

  let desiredSessionId = null;
  let desiredReceiverApplicationId = null;
  let rejoinAttempts = 0;
  let rejoinInteractionRequested = false;
  let lastRejoinAttemptAt = 0;
  let configuredReceiverApplicationId = null;
  let lastStatusKey = null;
  let lastPlayingMediaSessionId = null;
  let lastFinishedMediaSessionId = null;
  let remotePlayer = null;
  let remoteController = null;
  let remoteEventBindings = [];
  let remotePlaybackObserved = false;
  let lastRemoteCurrentTime = null;
  let lastRemoteDuration = null;
  let boundCastContext = null;
  let castContextEventBindings = [];
  const instrumentedCastSessions = new WeakSet();
  const instrumentedLegacySessions = new WeakSet();

  function post(event, payload = {}) {
    window.postMessage({
      channel: CHANNEL,
      direction: "main-to-isolated",
      event,
      payload
    }, "*");
  }

  function safeCall(target, method, fallback = null) {
    try {
      if (!target || typeof target[method] !== "function") return fallback;
      return target[method]();
    } catch {
      return fallback;
    }
  }

  function castObjects() {
    try {
      const framework = globalThis.cast?.framework;
      const base = globalThis.chrome?.cast;
      const context = framework?.CastContext?.getInstance?.() || null;
      return { framework, base, context };
    } catch {
      return { framework: null, base: null, context: null };
    }
  }

  function sessionIdFor(target) {
    return safeCall(target, "getSessionId", target?.sessionId || null);
  }

  function loadTracePayload(target, request, api, state) {
    const hasMetadataTitle = Boolean(request?.media?.metadata?.title);
    return {
      sessionId: sessionIdFor(target),
      autoplay: typeof request?.autoplay === "boolean" ? request.autoplay : null,
      loadApi: api,
      hasMetadataTitle,
      traceEvent: `LOAD_MEDIA_${state}:${api}${hasMetadataTitle ? ":title" : ""}`
    };
  }

  function traceLoadFailure(target, request, api, error) {
    post("LOAD_MEDIA_FAILED", {
      ...loadTracePayload(target, request, api, "FAILED"),
      error: String(error?.message || error || "loadMedia failed")
    });
  }

  function wrapFrameworkLoadMedia(target, api = "framework") {
    if (!target || typeof target.loadMedia !== "function") return false;
    const original = target.loadMedia;
    if (original?.[WRAP_MARK]) return true;
    try {
      const wrapped = function(...args) {
        const request = args[0] || null;
        post("LOAD_MEDIA_CALLED", loadTracePayload(this, request, api, "CALLED"));
        let result;
        try {
          result = original.apply(this, args);
        } catch (error) {
          traceLoadFailure(this, request, api, error);
          throw error;
        }
        Promise.resolve(result).then(
          () => post("LOAD_MEDIA_SUCCEEDED", loadTracePayload(this, request, api, "SUCCEEDED")),
          (error) => traceLoadFailure(this, request, api, error)
        );
        return result;
      };
      Object.defineProperty(wrapped, WRAP_MARK, { value: true });
      target.loadMedia = wrapped;
      return true;
    } catch {
      return false;
    }
  }

  function wrapLegacyLoadMedia(target, api = "legacy") {
    if (!target || typeof target.loadMedia !== "function") return false;
    const original = target.loadMedia;
    if (original?.[WRAP_MARK]) return true;
    try {
      const wrapped = function(request, successCallback, errorCallback) {
        post("LOAD_MEDIA_CALLED", loadTracePayload(this, request, api, "CALLED"));
        const onSuccess = (media) => {
          post("LOAD_MEDIA_SUCCEEDED", loadTracePayload(this, request, api, "SUCCEEDED"));
          if (typeof successCallback === "function") return successCallback(media);
          return undefined;
        };
        const onError = (error) => {
          traceLoadFailure(this, request, api, error);
          if (typeof errorCallback === "function") return errorCallback(error);
          return undefined;
        };
        try {
          return original.call(this, request, onSuccess, onError);
        } catch (error) {
          traceLoadFailure(this, request, api, error);
          throw error;
        }
      };
      Object.defineProperty(wrapped, WRAP_MARK, { value: true });
      target.loadMedia = wrapped;
      return true;
    } catch {
      return false;
    }
  }

  function ensureCastApiInstrumentation() {
    const { framework, base } = castObjects();
    const frameworkPrototype = framework?.CastSession?.prototype;
    if (frameworkPrototype) wrapFrameworkLoadMedia(frameworkPrototype, "framework");
    const legacyPrototype = base?.Session?.prototype;
    if (legacyPrototype) wrapLegacyLoadMedia(legacyPrototype, "legacy");
  }

  function instrumentLoadMedia(session) {
    if (!session) return;
    if (!instrumentedCastSessions.has(session)) {
      if (wrapFrameworkLoadMedia(session, "framework-instance")) instrumentedCastSessions.add(session);
    }
    const legacySession = safeCall(session, "getSessionObj", null);
    if (legacySession && !instrumentedLegacySessions.has(legacySession)) {
      if (wrapLegacyLoadMedia(legacySession, "legacy-instance")) instrumentedLegacySessions.add(legacySession);
    }
  }

  function ensureRemoteEvents() {
    const { framework } = castObjects();
    if (remoteController || !framework?.RemotePlayer || !framework?.RemotePlayerController) return;

    try {
      remotePlayer = new framework.RemotePlayer();
      remoteController = new framework.RemotePlayerController(remotePlayer);
      const types = framework.RemotePlayerEventType || {};
      const candidates = [
        types.PLAYER_STATE_CHANGED,
        types.IS_MEDIA_LOADED_CHANGED,
        types.MEDIA_INFO_CHANGED,
        types.IS_CONNECTED_CHANGED
      ].filter(Boolean);
      for (const type of new Set(candidates)) {
        const handler = () => inspect();
        remoteController.addEventListener(type, handler);
        remoteEventBindings.push([type, handler]);
      }
    } catch {
      remotePlayer = null;
      remoteController = null;
      remoteEventBindings = [];
    }
  }

  function snapshot() {
    const { framework, base, context } = castObjects();
    if (!framework || !base || !context) {
      return {
        available: false,
        connected: false,
        sessionId: null,
        deviceName: null,
        receiverApplicationId: null,
        castState: null,
        mediaPlayerState: null,
        mediaIdleReason: null,
        mediaSessionId: null
      };
    }

    ensureCastApiInstrumentation();
    const session = safeCall(context, "getCurrentSession", null);
    instrumentLoadMedia(session);
    const device = safeCall(session, "getCastDevice", null);
    const application = safeCall(session, "getApplicationMetadata", null);
    const media = safeCall(session, "getMediaSession", null);
    const remoteState = remotePlayer || {};
    const remoteCurrentTime = Number(remoteState.currentTime);
    const legacyCurrentTime = Number(safeCall(media, "getEstimatedTime", media?.currentTime));
    const remoteDuration = Number(remoteState.duration);
    const legacyDuration = Number(media?.media?.duration);
    const legacyRemoteControlAvailable = Boolean(
      media &&
      typeof media.play === "function" &&
      typeof media.pause === "function" &&
      typeof media.seek === "function" &&
      typeof media.stop === "function"
    );

    return {
      available: true,
      connected: Boolean(session),
      sessionId: sessionIdFor(session),
      deviceName: device?.friendlyName || device?.displayName || null,
      receiverApplicationId: application?.applicationId || null,
      castState: safeCall(context, "getCastState", null),
      sessionState: safeCall(session, "getSessionState", null),
      mediaPlayerState: media?.playerState || remoteState.playerState || null,
      mediaIdleReason: media?.idleReason || null,
      mediaSessionId: Number.isFinite(Number(media?.mediaSessionId)) ? Number(media.mediaSessionId) : null,
      isMediaLoaded: typeof remoteState.isMediaLoaded === "boolean" ? remoteState.isMediaLoaded : Boolean(media),
      remoteControlAvailable: Boolean((remotePlayer && remoteController) || legacyRemoteControlAvailable),
      remoteControlDriver: remotePlayer && remoteController
        ? "FRAMEWORK_REMOTE_PLAYER"
        : (legacyRemoteControlAvailable ? "LEGACY_MEDIA" : null),
      remoteCurrentTime: Number.isFinite(remoteCurrentTime)
        ? remoteCurrentTime
        : (Number.isFinite(legacyCurrentTime) ? legacyCurrentTime : null),
      remoteDuration: Number.isFinite(remoteDuration) && remoteDuration > 0
        ? remoteDuration
        : (Number.isFinite(legacyDuration) ? legacyDuration : null)
    };
  }

  function executeLegacyMediaControl(media, base, action, payload, reply) {
    if (!media) {
      reply(false, "CAST_REMOTE_CONTROLLER_UNAVAILABLE");
      return;
    }

    const onSuccess = () => reply(true);
    const onError = (error) => reply(false, String(error?.message || error?.code || error || "CAST_REMOTE_CONTROL_FAILED"));
    const state = String(media.playerState || "").toUpperCase();

    try {
      if (action === "TOGGLE_PLAY_PAUSE") {
        if (state === "PLAYING" || state === "BUFFERING") {
          media.pause(null, onSuccess, onError);
        } else {
          media.play(null, onSuccess, onError);
        }
      } else if (action === "SEEK_RELATIVE" || action === "SEEK_TO") {
        const current = Number(safeCall(media, "getEstimatedTime", media.currentTime));
        const duration = Number(media?.media?.duration);
        const requested = action === "SEEK_RELATIVE"
          ? current + Number(payload.seconds)
          : Number(payload.seconds);
        if (!Number.isFinite(requested)) throw new Error("CAST_REMOTE_SEEK_INVALID");
        const upper = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
        const target = Math.max(0, Math.min(requested, upper));
        const SeekRequest = base?.media?.SeekRequest;
        const request = typeof SeekRequest === "function" ? new SeekRequest() : {};
        request.currentTime = target;
        media.seek(request, onSuccess, onError);
      } else if (action === "STOP") {
        media.stop(null, onSuccess, onError);
      } else {
        throw new Error("CAST_REMOTE_ACTION_UNSUPPORTED");
      }
    } catch (error) {
      onError(error);
    }
  }

  function executeRemoteControl(payload = {}) {
    const commandId = String(payload.commandId || "").trim();
    const action = String(payload.action || "").trim();
    const expectedSessionId = String(payload.castSessionId || "").trim();
    const status = snapshot();

    const reply = (ok, reason = null) => {
      post("REMOTE_CONTROL_RESULT", {
        commandId,
        action,
        ok,
        reason,
        ...snapshot()
      });
      queueMicrotask(inspect);
    };

    if (!commandId || !action) {
      reply(false, "CAST_REMOTE_COMMAND_INVALID");
      return;
    }
    if (!status.connected || !status.sessionId) {
      reply(false, "CAST_REMOTE_NOT_CONNECTED");
      return;
    }
    if (expectedSessionId && status.sessionId !== expectedSessionId) {
      reply(false, "CAST_REMOTE_SESSION_MISMATCH");
      return;
    }
    const { base, context } = castObjects();
    const session = safeCall(context, "getCurrentSession", null);
    const media = safeCall(session, "getMediaSession", null);

    try {
      if (remotePlayer && remoteController) {
        if (action === "TOGGLE_PLAY_PAUSE") {
          if (typeof remoteController.playOrPause !== "function") throw new Error("CAST_REMOTE_TOGGLE_UNAVAILABLE");
          remoteController.playOrPause();
        } else if (action === "SEEK_RELATIVE" || action === "SEEK_TO") {
          if (typeof remoteController.seek !== "function") throw new Error("CAST_REMOTE_SEEK_UNAVAILABLE");
          const current = Number(remotePlayer.currentTime);
          const duration = Number(remotePlayer.duration);
          const requested = action === "SEEK_RELATIVE"
            ? current + Number(payload.seconds)
            : Number(payload.seconds);
          if (!Number.isFinite(requested)) throw new Error("CAST_REMOTE_SEEK_INVALID");
          const upper = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
          remotePlayer.currentTime = Math.max(0, Math.min(requested, upper));
          remoteController.seek();
        } else if (action === "STOP") {
          if (typeof remoteController.stop !== "function") throw new Error("CAST_REMOTE_STOP_UNAVAILABLE");
          remoteController.stop();
        } else {
          throw new Error("CAST_REMOTE_ACTION_UNSUPPORTED");
        }
        reply(true);
        return;
      }

      executeLegacyMediaControl(media, base, action, payload, reply);
    } catch (error) {
      reply(false, String(error?.message || error || "CAST_REMOTE_CONTROL_FAILED"));
    }
  }

  function clearCastContextEvents() {
    if (boundCastContext) {
      for (const [type, handler] of castContextEventBindings) {
        try { boundCastContext.removeEventListener(type, handler); } catch {}
      }
    }
    boundCastContext = null;
    castContextEventBindings = [];
  }

  function ensureCastContextEvents() {
    const { framework, context } = castObjects();
    if (!framework || !context) return;
    if (boundCastContext === context && castContextEventBindings.length) return;
    clearCastContextEvents();
    boundCastContext = context;
    const types = framework.CastContextEventType || {};
    const candidates = [
      [types.SESSION_STATE_CHANGED, "SESSION_STATE_CHANGED"],
      [types.CAST_STATE_CHANGED, "CAST_STATE_CHANGED"]
    ].filter(([type]) => Boolean(type));
    for (const [type, label] of candidates) {
      const handler = (event) => {
        const status = snapshot();
        const sessionState = event?.sessionState || status.sessionState || null;
        const castState = event?.castState || status.castState || null;
        post(label, {
          ...status,
          sessionState,
          castState,
          traceEvent: sessionState ? `SESSION:${sessionState}` : (castState ? `CAST:${castState}` : label)
        });
        queueMicrotask(inspect);
      };
      try {
        context.addEventListener(type, handler);
        castContextEventBindings.push([type, handler]);
      } catch {}
    }
  }

  function ensureCastContextConfigured() {
    if (!desiredSessionId || !desiredReceiverApplicationId) return;
    if (configuredReceiverApplicationId === desiredReceiverApplicationId) return;
    const { base, context } = castObjects();
    if (!base || !context || typeof context.setOptions !== "function") return;

    const autoJoinPolicy = base.AutoJoinPolicy?.ORIGIN_SCOPED || "origin_scoped";
    try {
      context.setOptions({
        receiverApplicationId: desiredReceiverApplicationId,
        autoJoinPolicy,
        resumeSavedSession: true
      });
      configuredReceiverApplicationId = desiredReceiverApplicationId;
      post("CAST_CONTEXT_CONFIGURED", {
        receiverApplicationId: desiredReceiverApplicationId,
        autoJoinPolicy,
        resumeSavedSession: true,
        traceEvent: "CAST_CONTEXT_CONFIGURED"
      });
    } catch (error) {
      post("CAST_CONTEXT_CONFIG_FAILED", {
        receiverApplicationId: desiredReceiverApplicationId,
        traceEvent: "CAST_CONTEXT_CONFIG_FAILED",
        error: String(error?.message || error || "CastContext.setOptions failed")
      });
    }
  }

  function maybeRejoin(status) {
    if (!desiredSessionId) return;

    // A CastContext may expose a current session object before the retained
    // session we are trying to recover has actually become the page's usable
    // session. Only the exact retained session id satisfies the rejoin. A
    // foreign/stale current session must not suppress requestSessionById().
    if (status.connected && status.sessionId === desiredSessionId) return;

    const requestInteractiveRejoin = (reason) => {
      if (rejoinInteractionRequested) return;
      rejoinInteractionRequested = true;
      post("REJOIN_INTERACTION_REQUIRED", {
        ...status,
        requestedSessionId: desiredSessionId,
        rejoinAttempt: rejoinAttempts,
        rejoinReason: reason,
        traceEvent: `REJOIN_INTERACTION_REQUIRED:${reason}`
      });
    };

    if (rejoinAttempts >= MAX_REJOIN_ATTEMPTS) {
      requestInteractiveRejoin("REQUEST_SESSION_BY_ID_EXHAUSTED");
      return;
    }
    const now = Date.now();
    if (now - lastRejoinAttemptAt < POLL_MS) return;

    const { base } = castObjects();
    if (!base || typeof base.requestSessionById !== "function") {
      requestInteractiveRejoin("REQUEST_SESSION_BY_ID_UNAVAILABLE");
      return;
    }
    lastRejoinAttemptAt = now;
    rejoinAttempts += 1;
    try {
      base.requestSessionById(desiredSessionId);
      post("REJOIN_REQUESTED", {
        ...status,
        requestedSessionId: desiredSessionId,
        rejoinAttempt: rejoinAttempts,
        traceEvent: `REJOIN_REQUESTED:${rejoinAttempts}`
      });
    } catch (error) {
      post("REJOIN_FAILED", {
        ...status,
        requestedSessionId: desiredSessionId,
        rejoinAttempt: rejoinAttempts,
        traceEvent: `REJOIN_FAILED:${rejoinAttempts}`,
        error: String(error?.message || error || "requestSessionById failed")
      });
    }
  }

  function inspect() {
    ensureCastApiInstrumentation();
    ensureCastContextEvents();
    ensureRemoteEvents();
    ensureCastContextConfigured();
    const status = snapshot();
    maybeRejoin(status);

    const key = JSON.stringify(status);
    if (key !== lastStatusKey) {
      lastStatusKey = key;
      post(status.available ? "STATUS" : "UNAVAILABLE", status);
    }

    const state = String(status.mediaPlayerState || "").toUpperCase();
    const idle = String(status.mediaIdleReason || "").toUpperCase();
    const mediaId = status.mediaSessionId ?? "unknown";

    if (status.isMediaLoaded !== false) {
      if (Number.isFinite(status.remoteCurrentTime)) lastRemoteCurrentTime = status.remoteCurrentTime;
      if (Number.isFinite(status.remoteDuration) && status.remoteDuration > 0) lastRemoteDuration = status.remoteDuration;
    }

    if (status.connected && (state === "PLAYING" || state === "BUFFERING")) {
      remotePlaybackObserved = true;
      lastFinishedMediaSessionId = null;
      if (lastPlayingMediaSessionId !== mediaId) {
        lastPlayingMediaSessionId = mediaId;
        post("REMOTE_PLAYING", { ...status, traceEvent: "REMOTE_PLAYING" });
      }
      return;
    }

    const explicitFinished = status.connected && state === "IDLE" && idle === "FINISHED";
    const unloadedNearEnd = status.connected &&
      remotePlaybackObserved &&
      status.isMediaLoaded === false &&
      (state === "IDLE" || !state) &&
      Number.isFinite(lastRemoteCurrentTime) &&
      Number.isFinite(lastRemoteDuration) &&
      lastRemoteDuration > 0 &&
      lastRemoteCurrentTime >= Math.max(0, lastRemoteDuration - END_NEAR_DURATION_TOLERANCE_SECONDS);

    if (explicitFinished || unloadedNearEnd) {
      if (lastFinishedMediaSessionId !== mediaId) {
        lastFinishedMediaSessionId = mediaId;
        lastPlayingMediaSessionId = null;
        remotePlaybackObserved = false;
        post("REMOTE_ENDED", {
          ...status,
          endDetection: explicitFinished ? "IDLE_FINISHED" : "MEDIA_UNLOADED_NEAR_END",
          senderHeldForOverlap: true,
          traceEvent: "REMOTE_ENDED"
        });
      }
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.direction !== "isolated-to-main") return;

    if (data.command === "PROBE") {
      inspect();
      return;
    }

    if (data.command === "REJOIN_SESSION") {
      const sessionId = String(data.payload?.sessionId || "").trim();
      const receiverApplicationId = String(data.payload?.receiverApplicationId || "").trim();
      if (sessionId !== desiredSessionId || receiverApplicationId !== desiredReceiverApplicationId) {
        desiredSessionId = sessionId || null;
        desiredReceiverApplicationId = receiverApplicationId || null;
        rejoinAttempts = 0;
        rejoinInteractionRequested = false;
        lastRejoinAttemptAt = 0;
        configuredReceiverApplicationId = null;
      }
      inspect();
      return;
    }

    if (data.command === "REMOTE_CONTROL") {
      executeRemoteControl(data.payload || {});
    }
  });

  // Called only through the extension's bounded trusted-activation transport.
  // The Cast bridge remains the sole owner of page-level Cast API access; the
  // transport supplies transient user activation without discovering devices,
  // selecting a receiver, or constructing/loading media on QEC's behalf.
  globalThis.__QEC_CAST_TRUSTED_REQUEST_SESSION__ = () => {
    const { context } = castObjects();
    if (!context || typeof context.requestSession !== "function") {
      return { ok: false, reason: "CAST_CONTEXT_REQUEST_SESSION_UNAVAILABLE" };
    }

    try {
      const pending = context.requestSession();
      post("REQUEST_SESSION_CALLED", {
        requestedSessionId: desiredSessionId,
        traceEvent: "REQUEST_SESSION_CALLED"
      });
      Promise.resolve(pending).then(
        () => post("REQUEST_SESSION_RESOLVED", {
          requestedSessionId: desiredSessionId,
          traceEvent: "REQUEST_SESSION_RESOLVED"
        }),
        (error) => post("REQUEST_SESSION_FAILED", {
          requestedSessionId: desiredSessionId,
          traceEvent: "REQUEST_SESSION_FAILED",
          error: String(error?.message || error || "CastContext.requestSession failed")
        })
      );
      return { ok: true };
    } catch (error) {
      post("REQUEST_SESSION_FAILED", {
        requestedSessionId: desiredSessionId,
        traceEvent: "REQUEST_SESSION_FAILED",
        error: String(error?.message || error || "CastContext.requestSession failed")
      });
      return {
        ok: false,
        reason: String(error?.message || error || "CAST_CONTEXT_REQUEST_SESSION_FAILED")
      };
    }
  };

  const timer = setInterval(inspect, POLL_MS);
  window.addEventListener("pagehide", () => {
    clearInterval(timer);
    if (remoteController) {
      for (const [type, handler] of remoteEventBindings) {
        try { remoteController.removeEventListener(type, handler); } catch {}
      }
    }
    remoteEventBindings = [];
    remoteController = null;
    remotePlayer = null;
    clearCastContextEvents();
    try { delete globalThis.__QEC_CAST_TRUSTED_REQUEST_SESSION__; } catch {}
  }, { once: true });
  ensureCastApiInstrumentation();
  ensureRemoteEvents();
  inspect();
})();
