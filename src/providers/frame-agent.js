(() => {
  if (globalThis.__QEC_PROVIDER_FRAME_AGENT__) return;
  globalThis.__QEC_PROVIDER_FRAME_AGENT__ = true;

  const VERSION = 1;
  const PLAYER_DISCOVERY_TIMEOUT_MS = 15000;
  const PLAY_START_TIMEOUT_MS = 12000;
  const PLAY_RETRY_INTERVAL_MS = 500;
  const PLAY_ATTEMPT_TIMEOUT_MS = 1800;
  const CONTROL_ROOT_ID = "__qec_controls_root__";
  const START_BUTTON_ID = "__qec_start_button__";
  const CANONICAL_MEDIA_ATTR = "data-qec-canonical-media";
  const JW_CHANNEL = "__QEC_JW_BRIDGE_V1__";
  const CAST_CHANNEL = "__QEC_CAST_BRIDGE_V1__";
  const JW_PLAY_RETRY_INTERVAL_MS = 700;
  const JW_PLAY_START_TIMEOUT_MS = 12000;
  const JW_TRUSTED_ESCALATION_MS = 1200;
  const STICKY_CAST_RESUME_TIMEOUT_MS = 6000;
  const CAST_REMOTE_COMMAND_TIMEOUT_MS = 1500;

  let config = null;
  let observer = null;
  let currentVideo = null;
  let discoveryTimeoutId = null;
  let startupTimerId = null;
  let startupGeneration = 0;
  let startupDeadline = 0;
  let startupAttempt = 0;
  let startupInFlight = false;
  let startupEscalationEmitted = false;
  let lastPlayError = null;
  let playingObserved = false;
  let controlsRoot = null;
  let controls = null;
  let currentPlayerKind = null;
  let currentHtml5Surface = null;
  let currentHtml5UsesProviderControls = false;
  let currentJwContainer = null;
  let jwStartupTimerId = null;
  let jwStartupDeadline = 0;
  let jwStartupAttempt = 0;
  let jwPlayingObserved = false;
  let jwEscalationTimerId = null;
  let jwEscalationEmitted = false;
  let jwFoundEmitted = false;
  let lastJwStatus = null;
  let stickyCastResumeState = "idle";
  let stickyCastConnected = false;
  let stickyCastTransferRequested = false;
  let stickyCastResumeTimerId = null;
  let stickyCastInteractiveRejoinReason = null;
  let castRelayItemRequested = false;
  let activeCastRelayTransferId = null;
  let castRemoteCommandSequence = 0;
  const pendingCastRemoteCommands = new Map();
  const listeners = new Map();

  function emit(type, payload = {}) {
    if (!config) return;
    chrome.runtime.sendMessage({
      version: VERSION,
      sessionId: config.sessionId,
      epoch: config.epoch,
      type,
      payload: {
        provider: config.provider,
        href: location.href,
        ...payload
      }
    }).catch(() => {});
  }

  function snapshot(video) {
    return {
      playerKind: "HTML5",
      playerUi: currentHtml5UsesProviderControls ? "provider" : "qec",
      paused: Boolean(video.paused),
      ended: Boolean(video.ended),
      readyState: Number(video.readyState || 0),
      networkState: Number(video.networkState || 0),
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      muted: Boolean(video.muted),
      volume: Number.isFinite(video.volume) ? video.volume : null,
      autoplay: Boolean(video.autoplay),
      currentSrc: video.currentSrc || video.src || null,
      playAttempt: startupAttempt,
      playingObserved
    };
  }

  function setImportant(style, property, value) {
    style.setProperty(property, value, "important");
  }

  function setPagePresentationBase() {
    const root = document.documentElement;
    const body = document.body;
    if (root) {
      setImportant(root.style, "width", "100%");
      setImportant(root.style, "height", "100%");
      setImportant(root.style, "background", "black");
      setImportant(root.style, "overflow", "hidden");
    }
    if (body) {
      setImportant(body.style, "width", "100%");
      setImportant(body.style, "height", "100%");
      setImportant(body.style, "margin", "0");
      setImportant(body.style, "padding", "0");
      setImportant(body.style, "background", "black");
      setImportant(body.style, "overflow", "hidden");
    }
  }

  function jwContainerScore(element) {
    if (!element?.isConnected) return -1;
    const style = getComputedStyle(element);
    const visible = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
    if (!visible) return -1;
    const rect = element.getBoundingClientRect?.();
    return rect ? Math.max(0, rect.width) * Math.max(0, rect.height) : 0;
  }

  function bestJwContainer() {
    const players = Array.from(document.querySelectorAll(".jwplayer"));
    if (!players.length) return null;
    return players
      .map((element) => ({ element, score: jwContainerScore(element) }))
      .sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function enterJwPresentationMode(container) {
    setPagePresentationBase();

    // A transformed/contained ancestor changes the containing block of fixed
    // descendants. Some provider skins wrap JW in
    // such containers, so neutralize only layout properties that can clip the
    // canonical playback surface.
    for (let ancestor = container.parentElement; ancestor && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
      setImportant(ancestor.style, "overflow", "visible");
      setImportant(ancestor.style, "transform", "none");
      setImportant(ancestor.style, "perspective", "none");
      setImportant(ancestor.style, "filter", "none");
      setImportant(ancestor.style, "contain", "none");
    }

    setImportant(container.style, "position", "fixed");
    setImportant(container.style, "inset", "0");
    setImportant(container.style, "width", "100vw");
    setImportant(container.style, "height", "100vh");
    setImportant(container.style, "max-width", "none");
    setImportant(container.style, "max-height", "none");
    setImportant(container.style, "margin", "0");
    setImportant(container.style, "padding", "0");
    setImportant(container.style, "z-index", "2147483646");
    setImportant(container.style, "visibility", "visible");
    setImportant(container.style, "opacity", "1");
  }

  function syncJwViewport() {
    if (currentPlayerKind !== "jw" || !currentJwContainer?.isConnected) return;
    enterJwPresentationMode(currentJwContainer);
    const height = Math.max(1, Math.round(Number(window.innerHeight || document.documentElement?.clientHeight || 720)));
    sendJwCommand("PRESENT_VIEWPORT", { height });
  }

  function sendJwCommand(command, payload = {}) {
    window.postMessage({
      channel: JW_CHANNEL,
      direction: "isolated-to-main",
      command,
      payload
    }, "*");
  }

  function normalizeJwStatus(payload = {}) {
    return {
      playerKind: "JWPlayer",
      state: payload.state || "unknown",
      currentTime: Number.isFinite(payload.currentTime) ? payload.currentTime : null,
      duration: Number.isFinite(payload.duration) ? payload.duration : null,
      volume: Number.isFinite(payload.volume) ? payload.volume : null,
      muted: Boolean(payload.muted),
      fullscreen: Boolean(payload.fullscreen),
      playAttempt: jwStartupAttempt,
      playingObserved: jwPlayingObserved
    };
  }

  function clearStickyCastResumeTimer() {
    if (stickyCastResumeTimerId) clearTimeout(stickyCastResumeTimerId);
    stickyCastResumeTimerId = null;
  }

  function stickyCastRequested() {
    return Boolean(config?.castSessionId);
  }

  function shouldDeferLocalPlayback() {
    return stickyCastRequested() && ["pending", "html5_native_trigger", "context_trigger", "transferring", "awaiting_remote", "remote", "relay_pending", "relay_exporting", "relay_transfer"].includes(stickyCastResumeState);
  }

  function maybeOfferCastRelay() {
    if (!config?.castRelayMode || !stickyCastRequested()) return false;
    if (castRelayItemRequested || stickyCastResumeState === "remote" || stickyCastResumeState === "failed") return false;
    if (currentPlayerKind !== "jw" || !currentJwContainer) return false;
    castRelayItemRequested = true;
    stickyCastResumeState = "relay_exporting";
    sendJwCommand("EXPORT_CAST_ITEM");
    return true;
  }

  function switchHtml5StickyCastToRejoin() {
    if (!config?.castRelayMode || !stickyCastRequested() || currentPlayerKind !== "html5") return false;

    // D-028's opaque playlist-item relay is a JW-only capability. A provider
    // backed by plain HTML5 must not attempt to export/inspect media. Keep the
    // retiring sender alive, rejoin the retained Cast session through the
    // provider-owned Cast framework, and wait for real REMOTE_PLAYING before
    // allowing the old sender to be retired. If that bounded rejoin fails, the
    // existing sticky-cast timeout releases local playback as the fallback.
    config.castRelayMode = false;
    stickyCastResumeState = "pending";
    emit("CAST_STATUS", {
      playerKind: "GoogleCast",
      traceEvent: "HTML5_CAST_REJOIN"
    });
    sendCastCommand("REJOIN_SESSION", {
      sessionId: config.castSessionId,
      receiverApplicationId: config.castReceiverApplicationId || null
    });
    return true;
  }

  function requestTrustedHtml5CastContext(reason) {
    if (!stickyCastRequested() || currentPlayerKind !== "html5" || config?.castRelayMode) return false;
    if (["context_trigger", "remote", "failed"].includes(stickyCastResumeState)) return false;

    stickyCastInteractiveRejoinReason = reason || "CAST_REJOIN_INTERACTION_REQUIRED";
    stickyCastResumeState = "context_trigger";
    emit("CAST_STATUS", {
      playerKind: "GoogleCast",
      traceEvent: "HTML5_CAST_CONTEXT_REQUEST"
    });
    emit("CAST_HANDOFF_REQUIRED", {
      playerKind: "HTML5",
      handoffMethod: "TRUSTED_CAST_CONTEXT_REQUEST",
      rejoinReason: stickyCastInteractiveRejoinReason
    });
    return true;
  }

  function requestTrustedHtml5CastControl(reason) {
    if (!stickyCastRequested() || currentPlayerKind !== "html5" || config?.castRelayMode) return false;
    if (stickyCastResumeState !== "pending") return false;

    stickyCastInteractiveRejoinReason = reason || "HTML5_CAST_CONTROL_REQUIRED";
    stickyCastResumeState = "html5_native_trigger";
    emit("CAST_STATUS", {
      playerKind: "GoogleCast",
      traceEvent: "HTML5_CAST_CONTROL_REQUEST"
    });
    emit("CAST_HANDOFF_REQUIRED", {
      playerKind: "HTML5",
      handoffMethod: "TRUSTED_HTML5_CAST_CONTROL",
      rejoinReason: stickyCastInteractiveRejoinReason
    });
    return true;
  }

  function fallBackFromStickyCast(reason) {
    if (!stickyCastRequested() || stickyCastResumeState === "remote" || stickyCastResumeState === "failed") return;
    clearStickyCastResumeTimer();
    stickyCastResumeState = "failed";
    emit("CAST_STATUS", {
      playerKind: "GoogleCast",
      connected: false,
      stickyResumeFailed: true,
      stickyResumeReason: reason
    });
    if (currentPlayerKind === "jw" && currentJwContainer && !jwPlayingObserved) startJwPlaybackStartup();
    else if (currentPlayerKind === "html5" && currentVideo && !playingObserved) startPlaybackStartup(currentVideo);
  }

  function armStickyCastResumeTimeout() {
    clearStickyCastResumeTimer();
    if (!stickyCastRequested()) return;
    stickyCastResumeTimerId = setTimeout(() => {
      stickyCastResumeTimerId = null;
      fallBackFromStickyCast("CAST_RESUME_TIMEOUT");
    }, STICKY_CAST_RESUME_TIMEOUT_MS);
  }

  function maybeTransferStickyCast() {
    if (!stickyCastRequested()) return false;
    if (stickyCastTransferRequested || stickyCastResumeState === "remote" || stickyCastResumeState === "failed") return false;
    if (!stickyCastConnected) return false;
    if (currentPlayerKind !== "jw" || !currentJwContainer) return false;
    stickyCastTransferRequested = true;
    stickyCastResumeState = "native_trigger";
    emit("CAST_HANDOFF_REQUIRED", {
      playerKind: "JWPlayer",
      handoffMethod: "TRUSTED_JW_CAST_CONTROL"
    });
    return true;
  }

  function clearJwStartup() {
    if (jwStartupTimerId) clearTimeout(jwStartupTimerId);
    if (jwEscalationTimerId) clearTimeout(jwEscalationTimerId);
    jwStartupTimerId = null;
    jwEscalationTimerId = null;
    jwStartupDeadline = 0;
    jwStartupAttempt = 0;
    jwEscalationEmitted = false;
  }

  function scheduleJwStart(delay = JW_PLAY_RETRY_INTERVAL_MS) {
    if (currentPlayerKind !== "jw" || jwPlayingObserved || !currentJwContainer) return;
    if (jwStartupTimerId) clearTimeout(jwStartupTimerId);
    jwStartupTimerId = setTimeout(() => {
      jwStartupTimerId = null;
      if (Date.now() >= jwStartupDeadline) {
        emit("MEDIA_PLAY_BLOCKED", {
          reason: "PLAY_START_TIMEOUT",
          ...normalizeJwStatus(lastJwStatus || {})
        });
        return;
      }
      jwStartupAttempt += 1;
      sendJwCommand("PLAY");
      scheduleJwStart();
    }, delay);
  }

  function startJwPlaybackStartup() {
    clearJwStartup();
    jwPlayingObserved = false;
    jwStartupDeadline = Date.now() + JW_PLAY_START_TIMEOUT_MS;

    // Try ordinary JW play immediately. Hidden-page timers are throttled in
    // Chromium, so do not put attempt #1 behind setTimeout(0).
    jwStartupAttempt += 1;
    sendJwCommand("PLAY");

    // Escalate early to the already-bounded trusted activation path if ordinary
    // provider play has not produced a real PLAY/FIRST_FRAME event. Keep the
    // long deadline only as a final verification/failover bound.
    jwEscalationTimerId = setTimeout(() => {
      jwEscalationTimerId = null;
      if (currentPlayerKind !== "jw" || jwPlayingObserved || jwEscalationEmitted) return;
      jwEscalationEmitted = true;
      emit("MEDIA_PLAY_BLOCKED", {
        reason: "PLAY_START_TIMEOUT",
        startupPhase: "EARLY_TRUSTED_ESCALATION",
        ...normalizeJwStatus(lastJwStatus || {})
      });
    }, JW_TRUSTED_ESCALATION_MS);

    scheduleJwStart(JW_PLAY_RETRY_INTERVAL_MS);
  }

  function detachJw() {
    clearJwStartup();
    currentJwContainer = null;
    jwPlayingObserved = false;
    jwFoundEmitted = false;
    lastJwStatus = null;
  }

  function attachJw(container, replacement = false) {
    if (!container) return;
    if (currentPlayerKind === "jw" && currentJwContainer === container) return;
    detachVideo();
    detachJw();
    currentPlayerKind = "jw";
    currentJwContainer = container;
    removeControls();
    enterJwPresentationMode(container);
    jwFoundEmitted = true;
    emit(replacement ? "MEDIA_REPLACED" : "MEDIA_FOUND", normalizeJwStatus({ state: "discovering" }));
    sendJwCommand("PRESENT_VIEWPORT", {
      height: Math.max(1, Math.round(Number(window.innerHeight || document.documentElement?.clientHeight || 720)))
    });
    sendJwCommand("PROBE");
    if (!shouldDeferLocalPlayback()) startJwPlaybackStartup();
    else if (config?.castRelayMode) maybeOfferCastRelay();
    else maybeTransferStickyCast();
  }

  function handleJwBridgeMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== JW_CHANNEL || data.direction !== "main-to-isolated") return;

    if (currentPlayerKind !== "jw") {
      const container = bestJwContainer();
      if (container && data.event === "AVAILABLE") attachJw(container, false);
      else return;
    }

    const status = normalizeJwStatus(data.payload || {});
    lastJwStatus = data.payload || {};

    switch (data.event) {
      case "AVAILABLE":
      case "READY":
      case "STATUS":
        syncJwViewport();
        if (!jwFoundEmitted) {
          jwFoundEmitted = true;
          emit("MEDIA_FOUND", status);
        }
        if (shouldDeferLocalPlayback()) {
          if (config?.castRelayMode) maybeOfferCastRelay();
          else maybeTransferStickyCast();
        } else if (!jwPlayingObserved && !jwStartupTimerId) startJwPlaybackStartup();
        break;
      case "PLAY":
      case "FIRST_FRAME":
        if (shouldDeferLocalPlayback()) {
          // A provider may autostart locally before the retained Cast session
          // has accepted the new item. Keep local media silent/paused until
          // the Cast handoff succeeds or the bounded resume attempt fails.
          sendJwCommand("PAUSE");
          break;
        }
        if (!jwPlayingObserved) {
          jwPlayingObserved = true;
          clearJwStartup();
          emit("MEDIA_PLAYING", status);
        }
        break;
      case "COMPLETE":
        clearJwStartup();
        emit("MEDIA_ENDED", status);
        break;
      case "CAST": {
        const castEvent = data.payload?.eventData || {};
        emit("CAST_STATUS", {
          playerKind: "GoogleCast",
          jwCastEvent: true,
          jwCastActive: Boolean(castEvent.active),
          jwCastAvailable: Boolean(castEvent.available),
          jwCastDeviceName: castEvent.deviceName || null,
          // JW's player-level active flag is diagnostic only. A usable Cast
          // connection/session identity is owned by the Cast framework bridge.
          traceEvent: castEvent.active ? "JW_CAST_ACTIVE" : "JW_CAST_INACTIVE"
        });
        if (stickyCastRequested() && castEvent.active && !config?.castRelayMode) {
          stickyCastResumeState = "awaiting_remote";
        }
        break;
      }
      case "CAST_ITEM_EXPORT": {
        if (!config?.castRelayMode || !stickyCastRequested()) break;
        const item = data.payload?.item;
        if (!item || typeof item !== "object") {
          fallBackFromStickyCast("JW_CAST_RELAY_ITEM_INVALID");
          break;
        }
        stickyCastResumeState = "relay_transfer";
        emit("CAST_RELAY_ITEM", { item });
        break;
      }
      case "CAST_ITEM_EXPORT_FAILED":
        if (config?.castRelayMode) fallBackFromStickyCast(data.payload?.reason || "JW_CAST_RELAY_ITEM_UNAVAILABLE");
        break;
      case "CAST_RELAY_REQUESTED":
        if (activeCastRelayTransferId && data.payload?.transferId === activeCastRelayTransferId) {
          emit("CAST_STATUS", {
            playerKind: "GoogleCast",
            traceEvent: "CAST_RELAY_REQUESTED"
          });
        }
        break;
      case "CAST_RELAY_REQUEST_FAILED":
        if (activeCastRelayTransferId && data.payload?.transferId === activeCastRelayTransferId) {
          emit("CAST_RELAY_FAILED", {
            transferId: activeCastRelayTransferId,
            reason: data.payload?.reason || "JW_CAST_RELAY_FAILED"
          });
          activeCastRelayTransferId = null;
        }
        break;
      case "CAST_REQUESTED":
        if (stickyCastRequested() && stickyCastResumeState === "api_fallback") {
          stickyCastResumeState = "awaiting_remote";
          emit("CAST_STATUS", {
            playerKind: "GoogleCast",
            stickyTransferRequested: true,
            stickyTransferMethod: "JW_REQUEST_CAST_FALLBACK",
            traceEvent: "JW_REQUEST_CAST_FALLBACK"
          });
        }
        break;
      case "CAST_REQUEST_FAILED":
        fallBackFromStickyCast(data.payload?.reason || "JW_CAST_REQUEST_FAILED");
        break;
      case "ERROR":
        emit("MEDIA_ERROR", { ...status, error: data.payload?.error || data.payload?.eventData?.message || null });
        break;
      case "AUTOSTART_NOT_ALLOWED":
        clearJwStartup();
        emit("MEDIA_PLAY_BLOCKED", { reason: "AUTOPLAY_BLOCKED", ...status });
        break;
      case "PLAY_FAILED":
        // JW can emit this for a transient aborted play attempt while its source is
        // still settling. Keep the bounded startup retry alive; native JW controls
        // remain visible and a real user click can recover at any time.
        if (!jwStartupTimerId && !jwPlayingObserved) scheduleJwStart();
        break;
      default:
        break;
    }
  }

  window.addEventListener("message", handleJwBridgeMessage);

  function sendCastCommand(command, payload = {}) {
    window.postMessage({
      channel: CAST_CHANNEL,
      direction: "isolated-to-main",
      command,
      payload
    }, "*");
  }

  function requestCastRemoteControl(payload, sendResponse) {
    const commandId = `${Date.now()}:${++castRemoteCommandSequence}`;
    const timeoutId = setTimeout(() => {
      if (!pendingCastRemoteCommands.has(commandId)) return;
      pendingCastRemoteCommands.delete(commandId);
      sendResponse({ ok: false, reason: "CAST_REMOTE_COMMAND_TIMEOUT" });
    }, CAST_REMOTE_COMMAND_TIMEOUT_MS);

    pendingCastRemoteCommands.set(commandId, { sendResponse, timeoutId });
    sendCastCommand("REMOTE_CONTROL", {
      commandId,
      action: payload?.action,
      seconds: payload?.seconds,
      castSessionId: payload?.castSessionId || null
    });
  }

  function handleCastBridgeMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CAST_CHANNEL || data.direction !== "main-to-isolated") return;

    const payload = {
      playerKind: "GoogleCast",
      ...(data.payload || {})
    };

    if (data.event === "REMOTE_CONTROL_RESULT") {
      const commandId = String(payload.commandId || "");
      const pending = pendingCastRemoteCommands.get(commandId);
      if (!pending) return;
      pendingCastRemoteCommands.delete(commandId);
      clearTimeout(pending.timeoutId);
      pending.sendResponse({
        ok: Boolean(payload.ok),
        reason: payload.reason || null,
        status: payload
      });
      return;
    }

    if (data.event === "REJOIN_INTERACTION_REQUIRED") {
      emit("CAST_STATUS", payload);
      stickyCastInteractiveRejoinReason = payload.rejoinReason || "CAST_REJOIN_INTERACTION_REQUIRED";
      requestTrustedHtml5CastControl(stickyCastInteractiveRejoinReason);
      return;
    }

    if ([
      "STATUS",
      "UNAVAILABLE",
      "REJOIN_REQUESTED",
      "REJOIN_FAILED",
      "REQUEST_SESSION_CALLED",
      "REQUEST_SESSION_RESOLVED",
      "REQUEST_SESSION_FAILED",
      "SESSION_STATE_CHANGED",
      "CAST_STATE_CHANGED",
      "CAST_CONTEXT_CONFIGURED",
      "CAST_CONTEXT_CONFIG_FAILED",
      "LOAD_MEDIA_CALLED",
      "LOAD_MEDIA_SUCCEEDED",
      "LOAD_MEDIA_FAILED"
    ].includes(data.event)) {
      emit("CAST_STATUS", payload);
      const rejoined = data.event === "SESSION_STATE_CHANGED" &&
        ["SESSION_RESUMED", "SESSION_STARTED"].includes(String(payload.sessionState || "").toUpperCase());
      if (stickyCastRequested() && (data.event === "STATUS" || rejoined) && payload.connected && payload.sessionId === config.castSessionId) {
        stickyCastConnected = true;
        if (currentPlayerKind === "html5" && !config?.castRelayMode) {
          // Rejoining the Cast session only restores sender/session ownership;
          // unlike JW's requestCast relay it does not transfer the new HTML5
          // episode. Trigger the provider-owned visible Cast control once so
          // the provider remains responsible for its own media load.
          requestTrustedHtml5CastControl("HTML5_CAST_SESSION_REJOINED");
        } else {
          maybeTransferStickyCast();
        }
      }
      return;
    }

    if (data.event === "REMOTE_PLAYING") {
      payload.traceEvent = payload.traceEvent || "REMOTE_PLAYING";
      emit("CAST_STATUS", payload);
      if (activeCastRelayTransferId) {
        emit("CAST_RELAY_PLAYING", {
          ...payload,
          transferId: activeCastRelayTransferId
        });
        activeCastRelayTransferId = null;
        return;
      }
      if (stickyCastRequested()) {
        if (!["transferring", "awaiting_remote", "remote"].includes(stickyCastResumeState)) return;
        stickyCastResumeState = "remote";
        clearStickyCastResumeTimer();
        clearJwStartup();
        if (currentPlayerKind === "jw" && jwPlayingObserved) sendJwCommand("PAUSE");
      }
      emit("MEDIA_PLAYING", payload);
      return;
    }

    if (data.event === "REMOTE_ENDED") {
      payload.traceEvent = payload.traceEvent || "REMOTE_ENDED";
      emit("CAST_STATUS", payload);
      emit("MEDIA_ENDED", payload);
    }
  }

  window.addEventListener("message", handleCastBridgeMessage);

  function shortcutTargetConsumesSpace(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    return path.some((node) => {
      if (!(node instanceof Element)) return false;
      return node.matches?.("input, textarea, select, button, a[href], [role='button'], [contenteditable='true'], [contenteditable='']");
    });
  }

  function handleJwKeyboardShortcut(event) {
    if (currentPlayerKind !== "jw" || event.defaultPrevented) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    if (!(event.code === "Space" || event.key === " ")) return;
    if (shortcutTargetConsumesSpace(event)) return;

    // JW documents Space as Play/Pause, but some provider wrappers consume it
    // before the player receives it. Preserve the user's real key press and
    // translate only this missing semantic into the native JW API.
    event.preventDefault();
    event.stopImmediatePropagation();
    sendJwCommand("TOGGLE_PLAYBACK");
  }

  window.addEventListener("keydown", handleJwKeyboardShortcut, true);
  window.addEventListener("resize", () => syncJwViewport());

  function knownHtml5PlayerSurface(video) {
    if (!video?.closest) return null;
    return video.closest([
      ".plyr",
      ".video-js",
      ".dplayer",
      "media-player",
      "video-player"
    ].join(", "));
  }

  function html5ProviderControlsVisible(video, surface) {
    const scope = surface || video?.parentElement || document;
    if (!scope?.querySelectorAll) return false;
    const selectors = [
      ".plyr__controls",
      ".plyr__control--overlaid",
      ".vjs-control-bar",
      ".vjs-big-play-button",
      ".dplayer-controller",
      ".dplayer-play-icon",
      "media-controls",
      "media-play-button"
    ];
    return selectors.some((selector) => Array.from(scope.querySelectorAll(selector)).some(visibleElement));
  }

  function enterPresentationMode(video) {
    setPagePresentationBase();

    const surface = knownHtml5PlayerSurface(video);
    const providerControls = html5ProviderControlsVisible(video, surface);
    currentHtml5Surface = surface;
    currentHtml5UsesProviderControls = providerControls;

    video.autoplay = true;
    if (!video.preload || video.preload === "none") video.preload = "auto";
    // Exactly one visible control owner: preserve an existing provider UI when
    // detected; otherwise QEC supplies the fallback controls. Native browser
    // controls are therefore not layered underneath either surface.
    video.controls = false;

    if (surface) {
      for (let ancestor = surface.parentElement; ancestor && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
        setImportant(ancestor.style, "overflow", "visible");
        setImportant(ancestor.style, "transform", "none");
        setImportant(ancestor.style, "perspective", "none");
        setImportant(ancestor.style, "filter", "none");
        setImportant(ancestor.style, "contain", "none");
      }
      setImportant(surface.style, "position", "fixed");
      setImportant(surface.style, "inset", "0");
      setImportant(surface.style, "width", "100vw");
      setImportant(surface.style, "height", "100vh");
      setImportant(surface.style, "max-width", "none");
      setImportant(surface.style, "max-height", "none");
      setImportant(surface.style, "margin", "0");
      setImportant(surface.style, "padding", "0");
      setImportant(surface.style, "z-index", "2147483646");
      setImportant(surface.style, "visibility", "visible");
      setImportant(surface.style, "opacity", "1");
      setImportant(video.style, "width", "100%");
      setImportant(video.style, "height", "100%");
      setImportant(video.style, "max-width", "none");
      setImportant(video.style, "max-height", "none");
      setImportant(video.style, "object-fit", "contain");
      setImportant(video.style, "background", "black");
      return { surface, providerControls };
    }

    setImportant(video.style, "position", "fixed");
    setImportant(video.style, "inset", "0");
    setImportant(video.style, "width", "100vw");
    setImportant(video.style, "height", "100vh");
    setImportant(video.style, "max-width", "none");
    setImportant(video.style, "max-height", "none");
    setImportant(video.style, "object-fit", "contain");
    setImportant(video.style, "background", "black");
    setImportant(video.style, "z-index", "2147483646");
    setImportant(video.style, "visibility", "visible");
    setImportant(video.style, "opacity", "1");
    return { surface: null, providerControls: false };
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
      : `${minutes}:${String(secs).padStart(2, "0")}`;
  }

  function controlButton(label, title, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.dataset.qecAction = action;
    Object.assign(button.style, {
      border: "1px solid rgba(255,255,255,.35)",
      borderRadius: "8px",
      background: "rgba(20,20,20,.88)",
      color: "white",
      padding: "8px 12px",
      font: "600 14px system-ui, sans-serif",
      cursor: "pointer"
    });
    return button;
  }

  function setRangeStyle(input, width) {
    input.type = "range";
    input.style.width = width;
    input.style.cursor = "pointer";
    input.style.accentColor = "white";
  }

  function removeControls() {
    controlsRoot?.remove();
    controlsRoot = null;
    controls = null;
  }

  function visibleElement(element) {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) <= 0) return false;
    const rect = element.getBoundingClientRect?.();
    return Boolean(rect && rect.width >= 8 && rect.height >= 8);
  }

  function findSemanticStartupControl() {
    const selectors = [
      "button[aria-label*='play' i]",
      "[role='button'][aria-label*='play' i]",
      "button[title*='play' i]",
      "[data-plyr='play']",
      ".vjs-big-play-button",
      ".plyr__control--overlaid",
      ".jw-display-icon-container",
      ".jw-icon-playback"
    ];
    for (const selector of selectors) {
      const match = Array.from(document.querySelectorAll(selector)).find(visibleElement);
      if (match) return match;
    }
    return null;
  }

  function ensurePreVideoActivationGate() {
    if (currentPlayerKind === "jw" || bestJwContainer()) return;
    if (currentVideo || controlsRoot || !findSemanticStartupControl()) return;
    const root = document.createElement("div");
    root.id = CONTROL_ROOT_ID;
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      display: "grid",
      placeItems: "center",
      pointerEvents: "none",
      fontFamily: "system-ui, sans-serif"
    });
    const panel = document.createElement("div");
    Object.assign(panel.style, {
      display: "grid",
      gap: "10px",
      justifyItems: "center",
      padding: "16px",
      borderRadius: "14px",
      background: "rgba(0,0,0,.72)",
      color: "white",
      pointerEvents: "auto"
    });
    const start = controlButton("▶ Player aktivieren", "Provider-Player aktivieren", "activate-player");
    start.id = START_BUTTON_ID;
    start.style.fontSize = "18px";
    start.style.padding = "12px 22px";
    const status = document.createElement("div");
    status.textContent = "Einmaliger Start-Klick für diesen Player";
    status.style.fontSize = "13px";
    status.style.opacity = ".9";
    panel.append(start, status);
    root.append(panel);
    (document.body || document.documentElement).append(root);
    controlsRoot = root;
    controls = { startPanel: panel, start, startStatus: status };

    start.addEventListener("click", () => {
      const trigger = findSemanticStartupControl();
      if (!trigger) {
        status.textContent = "Play-Control nicht mehr gefunden";
        return;
      }
      status.textContent = "Player wird aktiviert …";
      trigger.click();
      for (const delay of [0, 100, 300, 700, 1500]) {
        setTimeout(() => {
          if (currentVideo) return;
          if (discover(false)) clearDiscoveryTimeout();
        }, delay);
      }
    });
  }

  function updateControls(video) {
    if (!controls || video !== currentVideo) return;
    controls.toggle.textContent = video.paused ? "▶" : "⏸";
    controls.toggle.title = video.paused ? "Abspielen" : "Pause";
    controls.mute.textContent = video.muted || video.volume === 0 ? "🔇" : "🔊";
    controls.volume.value = String(video.muted ? 0 : Math.max(0, Math.min(1, Number(video.volume) || 0)));
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const current = Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0;
    controls.progress.disabled = duration <= 0;
    controls.progress.value = duration > 0 ? String(Math.min(1000, Math.round((current / duration) * 1000))) : "0";
    controls.time.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  }

  function hideActivationGate() {
    if (!controls) return;
    controls.startPanel.hidden = true;
    controls.start.hidden = true;
    controls.startStatus.hidden = true;
  }

  function showActivationGate(reason = "Zum Starten einmal klicken") {
    if (!controls) return;
    controls.startPanel.hidden = false;
    controls.startStatus.textContent = reason;
    controls.startStatus.hidden = false;
    controls.start.hidden = false;
  }

  async function userStart(video) {
    if (!video || video !== currentVideo) return;
    try {
      await video.play();
      hideActivationGate();
    } catch (error) {
      lastPlayError = playAttemptError(error);
      showActivationGate(error?.name === "NotAllowedError" ? "Edge benötigt einen Start-Klick" : "Start fehlgeschlagen – erneut versuchen");
      emitStartupBlocked(video, "USER_ACTIVATION_REQUIRED", lastPlayError);
    }
  }

  function ensureControls(video) {
    removeControls();

    const root = document.createElement("div");
    root.id = CONTROL_ROOT_ID;
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      fontFamily: "system-ui, sans-serif"
    });

    const startWrap = document.createElement("div");
    Object.assign(startWrap.style, {
      position: "absolute",
      inset: "0",
      display: "grid",
      placeItems: "center",
      pointerEvents: "none"
    });

    const startPanel = document.createElement("div");
    Object.assign(startPanel.style, {
      display: "grid",
      gap: "10px",
      justifyItems: "center",
      padding: "16px",
      borderRadius: "14px",
      background: "rgba(0,0,0,.72)",
      color: "white",
      pointerEvents: "auto"
    });
    startPanel.hidden = true;

    const startButton = controlButton("▶ Start", "Video starten", "start");
    startButton.id = START_BUTTON_ID;
    startButton.hidden = true;
    startButton.style.fontSize = "18px";
    startButton.style.padding = "12px 22px";
    const startStatus = document.createElement("div");
    startStatus.hidden = true;
    startStatus.style.fontSize = "13px";
    startStatus.style.opacity = ".9";
    startPanel.append(startButton, startStatus);
    startWrap.append(startPanel);

    const bar = document.createElement("div");
    Object.assign(bar.style, {
      position: "absolute",
      left: "12px",
      right: "12px",
      bottom: "12px",
      minHeight: "48px",
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "8px 10px",
      borderRadius: "12px",
      background: "rgba(0,0,0,.72)",
      color: "white",
      pointerEvents: "auto",
      boxSizing: "border-box"
    });

    const toggle = controlButton("▶", "Abspielen", "toggle");
    const back = controlButton("−10s", "10 Sekunden zurück", "back");
    const forward = controlButton("+10s", "10 Sekunden vor", "forward");
    const progress = document.createElement("input");
    setRangeStyle(progress, "min(42vw, 520px)");
    progress.min = "0";
    progress.max = "1000";
    progress.step = "1";
    progress.value = "0";
    progress.dataset.qecAction = "seek";
    const time = document.createElement("span");
    time.style.minWidth = "105px";
    time.style.font = "500 13px ui-monospace, SFMono-Regular, Consolas, monospace";
    const mute = controlButton("🔊", "Stumm", "mute");
    const volume = document.createElement("input");
    setRangeStyle(volume, "110px");
    volume.min = "0";
    volume.max = "1";
    volume.step = "0.05";
    volume.value = String(video.volume ?? 1);
    volume.dataset.qecAction = "volume";

    bar.append(toggle, back, forward, progress, time, mute, volume);
    root.append(startWrap, bar);
    (document.body || document.documentElement).append(root);

    controlsRoot = root;
    controls = { startPanel, start: startButton, startStatus, toggle, back, forward, progress, time, mute, volume };

    startButton.addEventListener("click", () => { void userStart(video); });
    toggle.addEventListener("click", () => {
      if (video.paused || video.ended) void userStart(video);
      else video.pause();
    });
    back.addEventListener("click", () => {
      const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      video.currentTime = Math.max(0, current - 10);
      updateControls(video);
    });
    forward.addEventListener("click", () => {
      const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
      video.currentTime = Math.min(duration, current + 10);
      updateControls(video);
    });
    progress.addEventListener("input", () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0) return;
      video.currentTime = (Number(progress.value) / 1000) * video.duration;
      updateControls(video);
    });
    mute.addEventListener("click", () => {
      video.muted = !video.muted;
      updateControls(video);
    });
    volume.addEventListener("input", () => {
      video.volume = Math.max(0, Math.min(1, Number(volume.value)));
      video.muted = video.volume === 0;
      updateControls(video);
    });

    updateControls(video);
  }

  function clearDiscoveryTimeout() {
    if (discoveryTimeoutId) clearTimeout(discoveryTimeoutId);
    discoveryTimeoutId = null;
  }

  function clearStartup() {
    startupGeneration += 1;
    if (startupTimerId) clearTimeout(startupTimerId);
    startupTimerId = null;
    startupDeadline = 0;
    startupAttempt = 0;
    startupInFlight = false;
    startupEscalationEmitted = false;
    lastPlayError = null;
    playingObserved = false;
  }

  function detachVideo() {
    clearStartup();
    if (currentVideo) {
      currentVideo.removeAttribute(CANONICAL_MEDIA_ATTR);
      for (const [type, handler] of listeners) currentVideo.removeEventListener(type, handler);
      listeners.clear();
      currentVideo = null;
    }
    currentHtml5Surface = null;
    currentHtml5UsesProviderControls = false;
    removeControls();
  }

  function visibleArea(video) {
    const rect = video.getBoundingClientRect?.();
    if (!rect) return 0;
    return Math.max(0, rect.width) * Math.max(0, rect.height);
  }

  function candidateScore(video) {
    if (!video?.isConnected || video.ended) return -1;
    const style = getComputedStyle(video);
    const visible = style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
    const area = visible ? visibleArea(video) : 0;
    const source = video.currentSrc || video.src || video.querySelector?.("source[src]")?.src || "";
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? 1 : 0;
    return area + (source ? 1_000_000 : 0) + duration * 250_000 + Number(video.readyState || 0) * 10_000;
  }

  function bestVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (!videos.length) return null;
    return videos
      .map((video) => ({ video, score: candidateScore(video) }))
      .sort((a, b) => b.score - a.score)[0]?.video || null;
  }

  function playAttemptError(error) {
    const name = String(error?.name || "Error");
    const message = String(error?.message || error || "unknown play error");
    return { name, message };
  }

  function terminalPlayReason(error) {
    if (!error) return null;
    if (error.name === "NotAllowedError") return "AUTOPLAY_BLOCKED";
    if (error.name === "NotSupportedError") return null;
    if (error.name === "AbortError") return null;
    return null;
  }

  function emitStartupBlocked(video, reason, error = null) {
    if (reason === "AUTOPLAY_BLOCKED" || reason === "PLAY_START_TIMEOUT" || reason === "USER_ACTIVATION_REQUIRED") {
      showActivationGate(reason === "AUTOPLAY_BLOCKED" ? "Browser benötigt einen Start-Klick" : "Zum Starten einmal klicken");
    }
    emit("MEDIA_PLAY_BLOCKED", {
      reason,
      error: error?.message || null,
      errorName: error?.name || null,
      attempts: startupAttempt,
      ...snapshot(video)
    });
  }

  function scheduleStartupAttempt(video, generation, delay = PLAY_RETRY_INTERVAL_MS) {
    if (generation !== startupGeneration || video !== currentVideo || playingObserved) return;
    if (startupTimerId) clearTimeout(startupTimerId);
    startupTimerId = setTimeout(() => {
      startupTimerId = null;
      void attemptStart(video, generation);
    }, delay);
  }

  async function playWithTimeout(video) {
    const result = video.play();
    if (!result || typeof result.then !== "function") return;
    let timer;
    try {
      await Promise.race([
        result,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new DOMException("play() did not settle", "TimeoutError")), PLAY_ATTEMPT_TIMEOUT_MS);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function attemptStart(video, generation) {
    if (generation !== startupGeneration || video !== currentVideo || playingObserved || startupInFlight) return;
    if (Date.now() >= startupDeadline) {
      emitStartupBlocked(video, "PLAY_START_TIMEOUT", lastPlayError);
      clearStartup();
      return;
    }

    startupInFlight = true;
    startupAttempt += 1;
    video.autoplay = true;
    if (!video.preload || video.preload === "none") video.preload = "auto";

    try {
      await playWithTimeout(video);
      lastPlayError = null;
      if (generation !== startupGeneration || video !== currentVideo || playingObserved) return;
      if (!video.paused && !video.ended) {
        // Some players do not dispatch `playing` immediately. Give the native event
        // a short opportunity; a subsequent retry verifies that playback actually stuck.
        scheduleStartupAttempt(video, generation, 350);
      } else {
        if (!startupEscalationEmitted) {
          startupEscalationEmitted = true;
          emitStartupBlocked(video, "USER_ACTIVATION_REQUIRED");
        }
        scheduleStartupAttempt(video, generation);
      }
    } catch (error) {
      lastPlayError = playAttemptError(error);
      const terminal = terminalPlayReason(error);
      if (terminal && !startupEscalationEmitted) {
        startupEscalationEmitted = true;
        emitStartupBlocked(video, terminal, lastPlayError);
      } else if (error?.name === "TimeoutError" && !startupEscalationEmitted) {
        startupEscalationEmitted = true;
        emitStartupBlocked(video, "PLAY_START_TIMEOUT", lastPlayError);
      }
      // Keep the bounded startup loop alive after early escalation so a failed
      // trusted activation still reaches the final timeout/failover path.
      scheduleStartupAttempt(video, generation);
    } finally {
      startupInFlight = false;
    }
  }

  function startPlaybackStartup(video) {
    clearStartup();
    const generation = startupGeneration;
    startupDeadline = Date.now() + PLAY_START_TIMEOUT_MS;
    // The first attempt must not depend on background-tab timer scheduling. A
    // throttled setTimeout(0) could otherwise consume the entire startup window
    // before attempt #1, producing the observed try=0 timeout.
    void attemptStart(video, generation);
  }

  function attachVideo(video, replacement = false) {
    if (!video || (currentPlayerKind === "html5" && video === currentVideo)) return;
    detachJw();
    detachVideo();
    currentPlayerKind = "html5";
    currentVideo = video;
    switchHtml5StickyCastToRejoin();
    currentVideo.setAttribute(CANONICAL_MEDIA_ATTR, "true");
    const presentation = enterPresentationMode(video);
    if (presentation.providerControls) removeControls();
    else ensureControls(video);

    const onPlaying = () => {
      if (shouldDeferLocalPlayback()) {
        // Provider HTML5 players may autostart independently of QEC. While a
        // retained Cast session is being rejoined, do not let that transient
        // local start become the canonical playback signal or prematurely
        // release the retiring Cast sender.
        try { video.pause(); } catch {}
        playingObserved = false;
        updateControls(video);
        return;
      }
      playingObserved = true;
      if (startupTimerId) clearTimeout(startupTimerId);
      startupTimerId = null;
      hideActivationGate();
      updateControls(video);
      emit("MEDIA_PLAYING", snapshot(video));
    };
    const onEnded = () => {
      updateControls(video);
      emit("MEDIA_ENDED", snapshot(video));
    };
    const onError = () => emit("MEDIA_ERROR", { ...snapshot(video), mediaErrorCode: video.error?.code ?? null });
    const onStalled = () => emit("MEDIA_STALLED", snapshot(video));
    const onStateChange = () => updateControls(video);
    const onReady = () => {
      updateControls(video);
      if (!playingObserved && !shouldDeferLocalPlayback()) scheduleStartupAttempt(video, startupGeneration, 0);
    };

    for (const [type, handler] of [
      ["playing", onPlaying],
      ["ended", onEnded],
      ["error", onError],
      ["stalled", onStalled],
      ["pause", onStateChange],
      ["timeupdate", onStateChange],
      ["durationchange", onStateChange],
      ["volumechange", onStateChange],
      ["loadedmetadata", onReady],
      ["canplay", onReady],
      ["loadeddata", onReady]
    ]) {
      listeners.set(type, handler);
      video.addEventListener(type, handler);
    }

    emit(replacement ? "MEDIA_REPLACED" : "MEDIA_FOUND", snapshot(video));
    if (!shouldDeferLocalPlayback()) startPlaybackStartup(video);
  }

  function discover(replacement = false) {
    const jw = bestJwContainer();
    if (jw) {
      attachJw(jw, replacement && Boolean(currentJwContainer || currentVideo));
      return true;
    }

    const candidate = bestVideo();
    if (!candidate) return false;
    attachVideo(candidate, replacement && Boolean(currentVideo || currentJwContainer));
    return true;
  }

  function observeDom() {
    observer = new MutationObserver(() => {
      if (currentPlayerKind === "jw") {
        if (!currentJwContainer?.isConnected) {
          if (!discover(true)) ensurePreVideoActivationGate();
          return;
        }
        enterJwPresentationMode(currentJwContainer);
        return;
      }

      const jw = bestJwContainer();
      if (jw) {
        attachJw(jw, true);
        return;
      }

      if (!currentVideo?.isConnected) {
        if (!discover(true)) ensurePreVideoActivationGate();
        return;
      }
      const candidate = bestVideo();
      if (candidate && candidate !== currentVideo && candidateScore(candidate) > candidateScore(currentVideo)) {
        attachVideo(candidate, true);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function startObservation(nextConfig) {
    stopObservation(false);
    config = nextConfig;
    stickyCastConnected = false;
    stickyCastTransferRequested = false;
    stickyCastInteractiveRejoinReason = null;
    castRelayItemRequested = false;
    activeCastRelayTransferId = null;
    stickyCastResumeState = nextConfig.castRelayMode
      ? "relay_pending"
      : (nextConfig.castSessionId ? "pending" : "idle");
    if (nextConfig.castSessionId) armStickyCastResumeTimeout();
    observeDom();
    sendCastCommand("PROBE");
    if (nextConfig.castSessionId && !nextConfig.castRelayMode) {
      sendCastCommand("REJOIN_SESSION", {
        sessionId: nextConfig.castSessionId,
        receiverApplicationId: nextConfig.castReceiverApplicationId || null
      });
    }

    if (discover(false)) return;
    ensurePreVideoActivationGate();

    discoveryTimeoutId = setTimeout(() => {
      if (!currentVideo) {
        ensurePreVideoActivationGate();
        emit("MEDIA_PLAY_BLOCKED", { reason: "PLAYER_NOT_FOUND", href: location.href });
      }
      discoveryTimeoutId = null;
    }, PLAYER_DISCOVERY_TIMEOUT_MS);
  }

  function stopObservation(clearConfig = true) {
    observer?.disconnect();
    observer = null;
    clearDiscoveryTimeout();
    clearStickyCastResumeTimer();
    stickyCastConnected = false;
    stickyCastTransferRequested = false;
    stickyCastInteractiveRejoinReason = null;
    castRelayItemRequested = false;
    activeCastRelayTransferId = null;
    for (const pending of pendingCastRemoteCommands.values()) {
      clearTimeout(pending.timeoutId);
      pending.sendResponse({ ok: false, reason: "CAST_REMOTE_SURFACE_STOPPED" });
    }
    pendingCastRemoteCommands.clear();
    stickyCastResumeState = "idle";
    detachVideo();
    detachJw();
    currentPlayerKind = null;
    if (clearConfig) config = null;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.version !== VERSION) return;

    if (message.type === "PROVIDER_ATTACH") {
      startObservation({
        sessionId: message.sessionId,
        epoch: message.epoch,
        provider: message.payload?.provider || "Unknown",
        castSessionId: message.payload?.castSessionId || null,
        castReceiverApplicationId: message.payload?.castReceiverApplicationId || null,
        castRelayMode: Boolean(message.payload?.castRelayMode)
      });
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "PROVIDER_STOP") {
      stopObservation(true);
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "POPUP_CAST_REMOTE_CONTROL") {
      if (!config || message.sessionId !== config.sessionId || message.epoch !== config.epoch) {
        sendResponse({ ok: false, reason: "CAST_REMOTE_SESSION_MISMATCH" });
        return true;
      }
      requestCastRemoteControl(message.payload || {}, sendResponse);
      return true;
    }

    if (message.type === "CAST_HANDOFF_RESULT") {
      const handoffMethod = String(message.payload?.handoffMethod || "");

      if (handoffMethod === "TRUSTED_HTML5_CAST_CONTROL") {
        if (!stickyCastRequested() || stickyCastResumeState !== "html5_native_trigger") {
          sendResponse({ ok: true, ignored: true });
          return true;
        }

        if (message.payload?.ok) {
          stickyCastResumeState = "awaiting_remote";
          emit("CAST_STATUS", {
            playerKind: "GoogleCast",
            stickyTransferRequested: true,
            stickyTransferMethod: "TRUSTED_HTML5_CAST_CONTROL",
            traceEvent: "TRUSTED_HTML5_CAST_CONTROL"
          });
        } else {
          // Not every HTML5 player exposes a semantic Cast control. Preserve
          // the existing Google-owned CastContext UI request as the bounded
          // fallback rather than guessing provider-specific DOM behavior.
          emit("CAST_STATUS", {
            playerKind: "GoogleCast",
            traceEvent: `HTML5_CAST_CONTROL_FAILED:${message.payload?.reason || "UNKNOWN"}`
          });
          stickyCastResumeState = "pending";
          requestTrustedHtml5CastContext(message.payload?.reason || "HTML5_CAST_CONTROL_NOT_FOUND");
        }
        sendResponse({ ok: true });
        return true;
      }

      if (handoffMethod === "TRUSTED_CAST_CONTEXT_REQUEST") {
        if (!stickyCastRequested() || stickyCastResumeState !== "context_trigger") {
          sendResponse({ ok: true, ignored: true });
          return true;
        }

        if (message.payload?.ok) {
          stickyCastResumeState = "awaiting_remote";
          emit("CAST_STATUS", {
            playerKind: "GoogleCast",
            stickyTransferRequested: true,
            stickyTransferMethod: "TRUSTED_CAST_CONTEXT_REQUEST",
            traceEvent: "TRUSTED_CAST_CONTEXT_REQUEST"
          });
        } else {
          fallBackFromStickyCast(message.payload?.reason || "CAST_CONTEXT_REQUEST_FAILED");
        }
        sendResponse({ ok: true });
        return true;
      }

      if (!stickyCastRequested() || stickyCastResumeState !== "native_trigger") {
        sendResponse({ ok: true, ignored: true });
        return true;
      }

      if (message.payload?.ok) {
        stickyCastResumeState = "awaiting_remote";
        emit("CAST_STATUS", {
          playerKind: "GoogleCast",
          stickyTransferRequested: true,
          stickyTransferMethod: "TRUSTED_JW_CAST_CONTROL",
          traceEvent: "TRUSTED_JW_CAST_CONTROL"
        });
      } else {
        // If the provider's native cast control is not present, keep the
        // public JW API as a bounded fallback. The trusted control is preferred
        // because it follows the exact player-owned path used by the viewer.
        stickyCastResumeState = "api_fallback";
        sendJwCommand("CAST_CURRENT");
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "CAST_RELAY_APPLY") {
      const transferId = String(message.payload?.transferId || "").trim();
      const item = message.payload?.item;
      if (!transferId || !item || typeof item !== "object" || currentPlayerKind !== "jw") {
        sendResponse({ ok: false, reason: "CAST_RELAY_APPLY_INVALID" });
        return true;
      }
      activeCastRelayTransferId = transferId;
      sendJwCommand("CAST_RELAY_ITEM", { transferId, item });
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "CAST_RELAY_FAILED") {
      if (config?.castRelayMode) fallBackFromStickyCast(message.payload?.reason || "CAST_RELAY_FAILED");
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "CAST_RELAY_PROMOTE") {
      config = {
        ...(config || {}),
        sessionId: message.sessionId,
        epoch: message.epoch,
        provider: message.payload?.provider || config?.provider || "Unknown",
        castSessionId: message.payload?.castSessionId || config?.castSessionId || null,
        castReceiverApplicationId: message.payload?.castReceiverApplicationId || config?.castReceiverApplicationId || null,
        castRelayMode: false
      };
      stickyCastConnected = true;
      stickyCastResumeState = "remote";
      castRelayItemRequested = false;
      activeCastRelayTransferId = null;
      clearStickyCastResumeTimer();
      clearJwStartup();
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "PROVIDER_PROBE") {
      if (currentPlayerKind === "jw" || bestJwContainer()) {
        sendJwCommand("PROBE");
        sendResponse({
          ok: true,
          href: location.href,
          playerFound: true,
          playerKind: "JWPlayer",
          state: normalizeJwStatus(lastJwStatus || {}),
          lastPlayError: null
        });
        return true;
      }
      const video = currentVideo || bestVideo();
      sendResponse({
        ok: true,
        href: location.href,
        playerFound: Boolean(video),
        playerKind: video ? "HTML5" : null,
        videoFound: Boolean(video),
        state: video ? { playerKind: "HTML5", ...snapshot(video) } : null,
        lastPlayError
      });
      return true;
    }
  });
})();
