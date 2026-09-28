import { CastRemoteAction, envelope, isEnvelope, MessageType, PlaybackAuthority, PROTOCOL_VERSION, SessionLifecycle, SessionState } from "./core/protocol.js";
import {
  acceptMessage,
  beginCastRelay,
  beginEpisode,
  block,
  clearCastRelay,
  clearPlaybackSurface,
  clearRetiringPlaybackSurface,
  createSession,
  isSessionActive,
  markPlaybackSurfaceLost,
  markProviderAttached,
  recordCastStatus,
  recordMedia,
  recordPlaybackActivationAttempt,
  recordProviderFailure,
  requireProviderPermission,
  promoteRetiringPlaybackSurface,
  retirePlaybackSurface,
  selectProvider,
  setPlaybackDocument,
  setPlaybackTab,
  stop
} from "./core/session.js";
import { loadSession, saveSession } from "./core/session-store.js";
import { chooseProvider, DEFAULT_PROVIDER_PRIORITY } from "./providers/registry.js";
import {
  invokeTrustedCastSessionRequest,
  invokeTrustedHtml5Cast,
  invokeTrustedHtml5Playback,
  invokeTrustedJwCast,
  invokeTrustedJwPlayback
} from "./providers/gesture-activation.js";
import {
  activatePlaybackSurface,
  closePlaybackSurface,
  currentPlaybackDocument,
  openPlaybackSurface
} from "./providers/playback-surface.js";
import { getPermissionState } from "./permissions/permission-broker.js";
import { enterPlaybackMode, restorePlaybackMode } from "./window/window-controller.js";

const TOP_AGENT_FILES = ["src/sites/episode-site-adapter.js", "src/sites/episode-site-content.js"];
const PROVIDER_AGENT_FILE = "src/providers/frame-agent.js";
const CAST_MAIN_BRIDGE_FILE = "src/providers/cast-main-bridge.js";
const JW_MAIN_BRIDGE_FILE = "src/providers/jw-main-bridge.js";
const PROVIDER_ATTACH_ATTEMPTS = 20;
const PROVIDER_ATTACH_INTERVAL_MS = 150;
const PROVIDER_ORIGIN_HOP_LIMIT = 6;
const PLAYBACK_NAVIGATION_TIMEOUT_MS = 10000;
const PLAYBACK_NAVIGATION_INTERVAL_MS = 150;
const SESSION_SCHEMA_VERSION = 8;
const CAST_REMOTE_ACTIONS = new Set(Object.values(CastRemoteAction));

function newSessionId() {
  return crypto.randomUUID();
}

async function loadCurrentSession() {
  const session = await loadSession();
  if (!session || session.schemaVersion === SESSION_SCHEMA_VERSION) return session;

  try {
    await restorePlaybackMode(session.windowId, session.originalWindowState, session.changedWindowMode);
  } catch {}
  await saveSession(null);
  return null;
}

function publicStatus(session) {
  if (!session) {
    return {
      lifecycle: SessionLifecycle.NONE,
      state: SessionState.IDLE,
      playbackAuthority: PlaybackAuthority.NONE,
      sessionId: null,
      currentEpisode: null,
      nextEpisode: null,
      selectedProvider: null,
      playbackTabId: null,
      retiringPlaybackTabId: null,
      retiringPlaybackProvider: null,
      playbackDocument: null,
      pendingPermissionOrigin: null,
      blockedReason: null,
      providerFailoverEnabled: false,
      attemptedProviders: [],
      providerFailures: [],
      cast: { available: false, connected: false, sticky: false, sessionId: null, deviceName: null },
      diagnostics: []
    };
  }
  return {
    lifecycle: session.lifecycle,
    state: session.state,
    playbackAuthority: session.playbackAuthority ?? PlaybackAuthority.NONE,
    sessionId: session.sessionId,
    epoch: session.epoch,
    tabId: session.tabId,
    windowId: session.windowId,
    playbackTabId: session.playbackTabId,
    retiringPlaybackTabId: session.retiringPlaybackTabId ?? null,
    retiringPlaybackProvider: session.retiringPlaybackProvider ?? null,
    currentEpisode: session.currentEpisode,
    nextEpisode: session.nextEpisode,
    selectedProvider: session.selectedProvider,
    providerFailoverEnabled: Boolean(session.providerFailoverEnabled),
    attemptedProviders: session.attemptedProviders ?? [],
    providerFailures: session.providerFailures ?? [],
    cast: session.cast ?? { available: false, connected: false, sticky: false, sessionId: null, deviceName: null },
    playbackDocument: session.playbackDocument,
    playbackActivationAttempts: session.playbackActivationAttempts ?? 0,
    pendingPermissionOrigin: session.pendingPermissionOrigin,
    blockedReason: session.blockedReason,
    lastMedia: session.lastMedia,
    diagnostics: session.diagnostics ?? []
  };
}

async function injectTopAgent(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: TOP_AGENT_FILES
  });
}

async function probeEpisode(tabId) {
  await injectTopAgent(tabId);
  const response = await chrome.tabs.sendMessage(tabId, envelope(MessageType.SITE_PROBE), { frameId: 0 });
  if (!response?.ok || !response.probe) throw new Error(response?.error || "SITE_PROBE_FAILED");
  return response.probe;
}

function isTransientProviderAttachError(error) {
  const message = String(error?.message || error).toLowerCase();
  return (
    message.includes("receiving end does not exist") ||
    message.includes("could not establish connection") ||
    message.includes("no frame with id") ||
    message.includes("frame was removed") ||
    message.includes("playback_document_not_ready")
  );
}

async function injectAndHandshakeProvider(session, initialDocument) {
  let lastError = null;
  let document = initialDocument;

  for (let attempt = 1; attempt <= PROVIDER_ATTACH_ATTEMPTS; attempt += 1) {
    try {
      const current = await currentPlaybackDocument(session.playbackTabId);
      if (current.origin !== document.origin) {
        return { attached: false, document: current, reason: "PROVIDER_ORIGIN_CHANGED" };
      }
      document = current;

      await chrome.scripting.executeScript({
        target: { tabId: session.playbackTabId, frameIds: [0] },
        files: [CAST_MAIN_BRIDGE_FILE],
        world: "MAIN"
      });
      await chrome.scripting.executeScript({
        target: { tabId: session.playbackTabId, frameIds: [0] },
        files: [JW_MAIN_BRIDGE_FILE],
        world: "MAIN"
      });
      await chrome.scripting.executeScript({
        target: { tabId: session.playbackTabId, frameIds: [0] },
        files: [PROVIDER_AGENT_FILE]
      });

      const response = await chrome.tabs.sendMessage(
        session.playbackTabId,
        envelope(MessageType.PROVIDER_ATTACH, {
          provider: session.selectedProvider?.provider,
          castSessionId: session.cast?.sticky ? session.cast?.sessionId : null,
          castReceiverApplicationId: session.cast?.sticky ? session.cast?.receiverApplicationId : null,
          castRelayMode: Boolean(
            session.cast?.sticky &&
            Number.isInteger(session.retiringPlaybackTabId) &&
            session.retiringPlaybackProvider &&
            session.retiringPlaybackProvider === session.selectedProvider?.provider
          )
        }, session),
        { frameId: 0 }
      );
      if (!response?.ok) throw new Error("PROVIDER_ATTACH_FAILED");
      return { attached: true, document };
    } catch (error) {
      lastError = error;
      try {
        const current = await currentPlaybackDocument(session.playbackTabId);
        if (current.origin !== document.origin) {
          return { attached: false, document: current, reason: "PROVIDER_ORIGIN_CHANGED" };
        }
        document = current;
      } catch {}

      if (!isTransientProviderAttachError(error) || attempt === PROVIDER_ATTACH_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, PROVIDER_ATTACH_INTERVAL_MS));
    }
  }

  const detail = String(lastError?.message || lastError || "unknown provider error");
  throw new Error(`PROVIDER_AGENT_UNREACHABLE: ${detail}`);
}

async function attachPlaybackSurface(session) {
  if (!Number.isInteger(session.playbackTabId)) throw new Error("PLAYBACK_TAB_MISSING");
  let document = await currentPlaybackDocument(session.playbackTabId);

  for (let hop = 0; hop < PROVIDER_ORIGIN_HOP_LIMIT; hop += 1) {
    session = setPlaybackDocument(session, document);
    await saveSession(session);

    const permission = await getPermissionState(document.origin);
    if (permission.state !== "GRANTED") {
      const blocked = requireProviderPermission(session, document.origin, document);
      await saveSession(blocked);
      return blocked;
    }

    await activatePlaybackSurface(session.playbackTabId);

    const result = await injectAndHandshakeProvider(session, document);
    if (result.attached) {
      const attachedSession = setPlaybackDocument(session, result.document);
      const running = markProviderAttached(attachedSession);
      await saveSession(running);
      return running;
    }

    if (result.reason !== "PROVIDER_ORIGIN_CHANGED" || !result.document?.origin) {
      throw new Error(result.reason || "PROVIDER_ATTACH_FAILED");
    }
    document = result.document;
  }

  throw new Error("PROVIDER_REDIRECT_CHAIN_TOO_DEEP");
}

async function openSelectedPlayback(session) {
  const opened = await openPlaybackSurface({
    windowId: session.windowId,
    candidate: session.selectedProvider,
    baseUrl: session.currentEpisode?.url,
    timeoutMs: PLAYBACK_NAVIGATION_TIMEOUT_MS,
    intervalMs: PLAYBACK_NAVIGATION_INTERVAL_MS
  });

  session = setPlaybackTab(session, opened.tabId);
  session = setPlaybackDocument(session, opened.document);
  await saveSession(session);
  return await attachPlaybackSurface(session);
}

async function enterInitialWindowMode(session) {
  if (!session.fullscreen || session.originalWindowState !== null) return session;

  try {
    const windowResult = await enterPlaybackMode(session.windowId);
    const updated = {
      ...session,
      originalWindowState: windowResult.originalState,
      changedWindowMode: windowResult.changed,
      updatedAt: Date.now()
    };
    await saveSession(updated);
    return updated;
  } catch (error) {
    const blocked = block(session, "WINDOW_FULLSCREEN_FAILED", [String(error?.message || error)]);
    await saveSession(blocked);
    return blocked;
  }
}

function sameEpisodeIdentity(left, right) {
  if (!left || !right) return false;
  return left.site === right.site &&
    left.seriesSlug === right.seriesSlug &&
    Number(left.season) === Number(right.season) &&
    Number(left.episode) === Number(right.episode);
}

function providerFailureDiagnostics(session) {
  return (session.providerFailures ?? []).map((failure) =>
    `${failure.provider}: ${failure.reason}`
  );
}

async function blockNoWorkingProvider(session) {
  session = await finishRetiringPlaybackTab(session);
  const reason = (session.attemptedProviders ?? []).length ? "NO_WORKING_PROVIDER" : "NO_PROVIDER_AVAILABLE";
  const blocked = block(session, reason, providerFailureDiagnostics(session));
  await saveSession(blocked);
  return blocked;
}

async function openProviderCandidateLoop(session, probe) {
  while (true) {
    const candidate = chooseProvider(
      probe.providers,
      session.providerPriority?.length ? session.providerPriority : DEFAULT_PROVIDER_PRIORITY,
      { excludeProviders: session.attemptedProviders ?? [] }
    );
    if (!candidate) return await blockNoWorkingProvider(session);

    session = selectProvider(session, candidate);
    await saveSession(session);

    try {
      const opened = await openSelectedPlayback(session);
      return opened;
    } catch (error) {
      const reason = String(error?.message || error);
      const persisted = await loadCurrentSession();
      if (persisted?.sessionId === session.sessionId) session = persisted;

      if (!session.providerFailoverEnabled) {
        if (Number.isInteger(session.playbackTabId)) session = await finishPlaybackTab(session);
        session = block(session, reason, [reason]);
        await saveSession(session);
        return session;
      }

      session = recordProviderFailure(session, reason, { phase: "provider-setup" });
      await saveSession(session);
      if (Number.isInteger(session.playbackTabId)) session = await finishPlaybackTab(session);
    }
  }
}

async function probeCurrentEpisodeForFailover(session) {
  try {
    const probe = await probeEpisode(session.tabId);
    if (!probe?.supported || !sameEpisodeIdentity(probe.episodeIdentity, session.currentEpisode)) {
      const blocked = block(session, "CONTROLLER_EPISODE_CHANGED_DURING_FAILOVER", probe?.diagnostics ?? []);
      await saveSession(blocked);
      return { session: blocked, probe: null };
    }
    return { session, probe };
  } catch (error) {
    const reason = String(error?.message || error);
    const blocked = block(session, reason, [reason]);
    await saveSession(blocked);
    return { session: blocked, probe: null };
  }
}

async function failoverToNextProvider(session, reason, payload = null) {
  if (!session?.providerFailoverEnabled) return session;

  session = recordProviderFailure(session, reason, payload);
  await saveSession(session);
  if (Number.isInteger(session.playbackTabId)) session = await finishPlaybackTab(session);

  const reprobe = await probeCurrentEpisodeForFailover(session);
  session = reprobe.session;
  if (!reprobe.probe || session.state === SessionState.BLOCKED) return session;
  return await openProviderCandidateLoop(session, reprobe.probe);
}

async function prepareEpisode(session, { enterWindow = false } = {}) {
  try {
    if (Number.isInteger(session.playbackTabId)) {
      const staleTabId = session.playbackTabId;
      session = clearPlaybackSurface(session);
      await saveSession(session);
      await closePlaybackSurface(staleTabId);
    }

    const probe = await probeEpisode(session.tabId);
    session = beginEpisode(session, probe);
    await saveSession(session);
    if (session.state === SessionState.BLOCKED) return session;

    session = await openProviderCandidateLoop(session, probe);
    if (enterWindow && ![SessionState.BLOCKED, SessionState.STOPPED, SessionState.COMPLETED].includes(session.state)) {
      session = await enterInitialWindowMode(session);
    }
    return session;
  } catch (error) {
    const reason = String(error?.message || error);
    session = block(session, reason, [reason]);
    await saveSession(session);
    return session;
  }
}

let startOperation = null;

function existingActiveSessionResult(existing, tabId) {
  if (!isSessionActive(existing)) return null;
  if (existing.tabId === tabId) return publicStatus(existing);
  throw new Error("SESSION_ALREADY_ACTIVE");
}

async function startSession(payload) {
  const {
    tabId,
    windowId,
    fullscreen = true,
    providerPriority = DEFAULT_PROVIDER_PRIORITY,
    providerFailoverEnabled = false
  } = payload ?? {};
  if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) throw new Error("ACTIVE_TAB_REQUIRED");

  const existing = await loadCurrentSession();
  const existingResult = existingActiveSessionResult(existing, tabId);
  if (existingResult) return existingResult;

  let session = createSession({
    sessionId: newSessionId(),
    tabId,
    windowId,
    fullscreen,
    providerPriority,
    providerFailoverEnabled
  });
  await saveSession(session);
  session = await prepareEpisode(session, { enterWindow: true });
  return publicStatus(session);
}

async function handleStart(payload) {
  if (startOperation) {
    try { await startOperation; } catch {}
    const tabId = payload?.tabId;
    const existing = await loadCurrentSession();
    const existingResult = existingActiveSessionResult(existing, tabId);
    if (existingResult) return existingResult;
  }

  const operation = startSession(payload);
  startOperation = operation;
  try {
    return await operation;
  } finally {
    if (startOperation === operation) startOperation = null;
  }
}

async function sendCastRemoteControl(session, payload = {}, { requireAuthority = true } = {}) {
  const action = String(payload.action || "");
  if (!CAST_REMOTE_ACTIONS.has(action)) throw new Error("CAST_REMOTE_ACTION_UNSUPPORTED");
  if (!isSessionActive(session)) throw new Error("CAST_REMOTE_SESSION_INACTIVE");
  if (requireAuthority && session.playbackAuthority !== PlaybackAuthority.CAST) {
    throw new Error("CAST_REMOTE_NOT_AUTHORITATIVE");
  }
  if (!session.cast?.connected || !session.cast?.sessionId) throw new Error("CAST_REMOTE_NOT_CONNECTED");
  if (!session.cast?.remoteControlAvailable) throw new Error("CAST_REMOTE_CONTROLLER_UNAVAILABLE");
  if (!Number.isInteger(session.playbackTabId)) throw new Error("CAST_REMOTE_PLAYBACK_TAB_MISSING");

  const seconds = Number(payload.seconds);
  if ([CastRemoteAction.SEEK_RELATIVE, CastRemoteAction.SEEK_TO].includes(action) && !Number.isFinite(seconds)) {
    throw new Error("CAST_REMOTE_SEEK_INVALID");
  }

  const response = await chrome.tabs.sendMessage(
    session.playbackTabId,
    envelope(MessageType.CAST_REMOTE_CONTROL, {
      action,
      seconds: Number.isFinite(seconds) ? seconds : null,
      castSessionId: session.cast.sessionId
    }, session),
    { frameId: 0 }
  );
  if (!response?.ok) throw new Error(response?.reason || "CAST_REMOTE_CONTROL_FAILED");
  return response;
}

async function handleCastRemoteControl(payload) {
  let session = await loadCurrentSession();
  const response = await sendCastRemoteControl(session, payload);
  if (response?.status) {
    session = recordCastStatus(session, response.status);
    await saveSession(session);
  }
  return publicStatus(session);
}

async function handleStop() {
  let session = await loadCurrentSession();
  if (!session) return publicStatus(null);

  const playbackTabId = session.playbackTabId;
  const retiringPlaybackTabId = session.retiringPlaybackTabId;
  if (
    isSessionActive(session) &&
    session.playbackAuthority === PlaybackAuthority.CAST &&
    session.cast?.connected &&
    session.cast?.remoteControlAvailable &&
    Number.isInteger(playbackTabId)
  ) {
    try {
      await sendCastRemoteControl(session, { action: CastRemoteAction.STOP });
    } catch {}
  }
  session = stop(session);
  await saveSession(session);

  if (Number.isInteger(playbackTabId)) {
    try {
      await chrome.tabs.sendMessage(playbackTabId, envelope(MessageType.PROVIDER_STOP, {}, session), { frameId: 0 });
    } catch {}
    await closePlaybackSurface(playbackTabId);
  }

  if (Number.isInteger(retiringPlaybackTabId) && retiringPlaybackTabId !== playbackTabId) {
    await closePlaybackSurface(retiringPlaybackTabId);
  }

  await restorePlaybackMode(session.windowId, session.originalWindowState, session.changedWindowMode);
  return publicStatus(session);
}

async function handlePermissionGranted() {
  let session = await loadCurrentSession();
  if (!session || session.blockedReason !== "PROVIDER_PERMISSION_REQUIRED") return publicStatus(session);

  try {
    session = await attachPlaybackSurface(session);
    if (![SessionState.BLOCKED, SessionState.STOPPED, SessionState.COMPLETED].includes(session.state)) {
      session = await enterInitialWindowMode(session);
    }
  } catch (error) {
    const reason = String(error?.message || error);
    if (session.providerFailoverEnabled) {
      session = await failoverToNextProvider(session, reason, { phase: "post-permission-attach" });
    } else {
      if (Number.isInteger(session.playbackTabId)) session = await finishPlaybackTab(session);
      session = block(session, reason, [reason]);
      await saveSession(session);
    }
  }
  return publicStatus(session);
}

async function finishPlaybackTab(session) {
  const playbackTabId = session.playbackTabId;
  session = clearPlaybackSurface(session);
  await saveSession(session);
  if (Number.isInteger(playbackTabId)) await closePlaybackSurface(playbackTabId);
  return session;
}

async function retireCurrentPlaybackTab(session) {
  session = retirePlaybackSurface(session);
  await saveSession(session);
  return session;
}

async function finishRetiringPlaybackTab(session) {
  const retiringPlaybackTabId = session?.retiringPlaybackTabId;
  if (!Number.isInteger(retiringPlaybackTabId)) return clearCastRelay(session);
  session = clearCastRelay(session);
  session = clearRetiringPlaybackSurface(session);
  await saveSession(session);
  await closePlaybackSurface(retiringPlaybackTabId);
  return session;
}

async function notifyCastRelayFailure(session, reason) {
  const playbackTabId = session?.playbackTabId;
  if (!Number.isInteger(playbackTabId)) return;
  try {
    await chrome.tabs.sendMessage(
      playbackTabId,
      envelope(MessageType.CAST_RELAY_FAILED, { reason }, session),
      { frameId: 0 }
    );
  } catch {}
}

async function handleCastRelayItem(message, sender) {
  let session = await loadCurrentSession();
  const tabId = sender.tab?.id;
  if (!acceptMessage(session, { sessionId: message.sessionId, epoch: message.epoch, tabId })) return;
  if (sender.frameId !== 0) return;
  const item = message.payload?.item;
  const retiringTabId = session.retiringPlaybackTabId;
  const sameProvider = Boolean(
    session.retiringPlaybackProvider &&
    session.retiringPlaybackProvider === session.selectedProvider?.provider
  );
  if (!item || typeof item !== "object" || !session.cast?.sticky || !Number.isInteger(retiringTabId) || !sameProvider) {
    await notifyCastRelayFailure(session, "CAST_RELAY_NOT_AVAILABLE");
    return;
  }

  const relayToken = `${session.sessionId}:${session.epoch}:cast-relay`;
  session = beginCastRelay(session, relayToken);
  session = recordCastStatus(session, { traceEvent: "CAST_RELAY_ITEM_READY" });
  await saveSession(session);

  try {
    const response = await chrome.tabs.sendMessage(
      retiringTabId,
      envelope(MessageType.CAST_RELAY_APPLY, { transferId: relayToken, item }, session),
      { frameId: 0 }
    );
    if (!response?.ok) throw new Error(response?.reason || "CAST_RELAY_APPLY_FAILED");
    session = await loadCurrentSession();
    if (session?.cast?.relayToken === relayToken) {
      session = recordCastStatus(session, { traceEvent: "CAST_RELAY_DELIVERED" });
      await saveSession(session);
    }
  } catch (error) {
    session = await loadCurrentSession();
    if (session?.cast?.relayToken === relayToken) {
      session = clearCastRelay(session, "FAILED");
      session = recordCastStatus(session, { traceEvent: "CAST_RELAY_DELIVERY_FAILED" });
      await saveSession(session);
      await notifyCastRelayFailure(session, String(error?.message || error || "CAST_RELAY_DELIVERY_FAILED"));
    }
  }
}

async function handleCastRelayPlaying(message, sender) {
  let session = await loadCurrentSession();
  const tabId = sender.tab?.id;
  const transferId = String(message.payload?.transferId || "");
  if (!session || sender.frameId !== 0 || tabId !== session.retiringPlaybackTabId) return;
  if (!transferId || transferId !== session.cast?.relayToken) return;

  const sourceTabId = session.playbackTabId;
  const senderDocument = await currentPlaybackDocument(tabId).catch(() => null);
  session = recordCastStatus(session, {
    ...message.payload,
    connected: true,
    sessionId: message.payload?.sessionId || session.cast?.sessionId,
    deviceName: message.payload?.deviceName || session.cast?.deviceName,
    receiverApplicationId: message.payload?.receiverApplicationId || session.cast?.receiverApplicationId,
    traceEvent: "CAST_RELAY_REMOTE_PLAYING"
  });
  session = recordMedia(session, MessageType.MEDIA_PLAYING, {
    ...message.payload,
    playerKind: "GoogleCast",
    relayTransfer: true
  }).session;
  session = promoteRetiringPlaybackSurface(session, senderDocument);
  await saveSession(session);

  try {
    await chrome.tabs.sendMessage(
      session.playbackTabId,
      envelope(MessageType.CAST_RELAY_PROMOTE, {
        provider: session.selectedProvider?.provider,
        castSessionId: session.cast?.sessionId,
        castReceiverApplicationId: session.cast?.receiverApplicationId
      }, session),
      { frameId: 0 }
    );
  } catch {}

  if (Number.isInteger(sourceTabId) && sourceTabId !== session.playbackTabId) {
    await closePlaybackSurface(sourceTabId);
  }
}

async function handleCastRelayFailed(message, sender) {
  let session = await loadCurrentSession();
  const tabId = sender.tab?.id;
  const transferId = String(message.payload?.transferId || "");
  if (!session || sender.frameId !== 0 || tabId !== session.retiringPlaybackTabId) return;
  if (!transferId || transferId !== session.cast?.relayToken) return;
  session = clearCastRelay(session, "FAILED");
  session = recordCastStatus(session, { traceEvent: "CAST_RELAY_FAILED" });
  await saveSession(session);
  await notifyCastRelayFailure(session, message.payload?.reason || "CAST_RELAY_FAILED");
}

async function handleMediaMessage(message, sender) {
  let session = await loadCurrentSession();
  const tabId = sender.tab?.id;
  if (!acceptMessage(session, { sessionId: message.sessionId, epoch: message.epoch, tabId })) return;
  if (sender.frameId !== 0) return;

  if (message.type === MessageType.CAST_STATUS) {
    session = recordCastStatus(session, message.payload);
    await saveSession(session);
    if (message.payload?.stickyResumeFailed && Number.isInteger(session.retiringPlaybackTabId)) {
      session = await finishRetiringPlaybackTab(session);
    }
    return;
  }

  if (message.type === MessageType.CAST_HANDOFF_REQUIRED) {
    const handoffMethod = String(message.payload?.handoffMethod || "");
    let activation;
    let successDiagnostic;
    let failureReason;

    if (message.payload?.playerKind === "JWPlayer" && handoffMethod === "TRUSTED_JW_CAST_CONTROL") {
      activation = await invokeTrustedJwCast(tabId);
      successDiagnostic = `cast-handoff: trusted JW cast control triggered (${activation.target || "jw"})`;
      failureReason = "JW_CAST_TRIGGER_FAILED";
    } else if (message.payload?.playerKind === "HTML5" && handoffMethod === "TRUSTED_HTML5_CAST_CONTROL") {
      activation = await invokeTrustedHtml5Cast(tabId);
      successDiagnostic = `cast-handoff: trusted HTML5 cast control triggered (${activation.target || "html5"})`;
      failureReason = "HTML5_CAST_TRIGGER_FAILED";
    } else if (message.payload?.playerKind === "HTML5" && handoffMethod === "TRUSTED_CAST_CONTEXT_REQUEST") {
      activation = await invokeTrustedCastSessionRequest(tabId);
      successDiagnostic = "cast-handoff: trusted Google Cast session UI requested";
      failureReason = "CAST_CONTEXT_REQUEST_FAILED";
    } else {
      return;
    }

    session = {
      ...session,
      diagnostics: [
        ...(session.diagnostics || []),
        activation.ok
          ? successDiagnostic
          : `cast-handoff: ${activation.reason || failureReason}`
      ],
      updatedAt: Date.now()
    };
    await saveSession(session);
    try {
      await chrome.tabs.sendMessage(
        tabId,
        envelope(MessageType.CAST_HANDOFF_RESULT, { ...activation, handoffMethod }, session),
        { frameId: 0 }
      );
    } catch {}
    return;
  }

  const result = recordMedia(session, message.type, message.payload);
  session = result.session;
  await saveSession(session);

  if (message.type === MessageType.MEDIA_PLAYING && Number.isInteger(session.retiringPlaybackTabId)) {
    if (message.payload?.playerKind === "GoogleCast") {
      session = clearCastRelay(session, "REMOTE");
      await saveSession(session);
      session = await finishRetiringPlaybackTab(session);
    } else if (!session.cast?.sticky) {
      session = clearCastRelay(session, "LOCAL_FALLBACK");
      await saveSession(session);
      session = await finishRetiringPlaybackTab(session);
    }
  }

  const blockedReason = message.payload?.reason;
  const activationEligible =
    message.type === MessageType.MEDIA_PLAY_BLOCKED &&
    ["AUTOPLAY_BLOCKED", "PLAY_START_TIMEOUT"].includes(blockedReason);

  if (activationEligible && Number(session.playbackActivationAttempts || 0) < 1) {
    session = recordPlaybackActivationAttempt(session);
    await saveSession(session);
    const activation = message.payload?.playerKind === "JWPlayer"
      ? await invokeTrustedJwPlayback(tabId)
      : await invokeTrustedHtml5Playback(tabId);

    if (activation.ok) return;

    session = {
      ...session,
      diagnostics: [...(session.diagnostics || []), `trusted-playback: ${activation.reason}`],
      updatedAt: Date.now()
    };
    await saveSession(session);

    if (session.providerFailoverEnabled) {
      await failoverToNextProvider(
        session,
        `${blockedReason}: TRUSTED_ACTIVATION_FAILED`,
        { ...message.payload, activationReason: activation.reason }
      );
    }
    return;
  }

  const runtimeProviderFailure =
    message.type === MessageType.MEDIA_ERROR ||
    (
      message.type === MessageType.MEDIA_PLAY_BLOCKED &&
      ["AUTOPLAY_BLOCKED", "PLAY_START_TIMEOUT", "PLAYER_NOT_FOUND", "USER_ACTIVATION_REQUIRED"].includes(blockedReason)
    );

  if (runtimeProviderFailure && session.providerFailoverEnabled) {
    await failoverToNextProvider(
      session,
      message.type === MessageType.MEDIA_ERROR ? "MEDIA_ERROR" : blockedReason,
      message.payload
    );
    return;
  }

  if (result.action?.type === "NAVIGATE_NEXT") {
    const isStickyCastEnd = Boolean(
      message.payload?.playerKind === "GoogleCast" &&
      session.cast?.sticky &&
      Number.isInteger(session.playbackTabId)
    );
    session = isStickyCastEnd
      ? await retireCurrentPlaybackTab(session)
      : await finishPlaybackTab(session);
    await chrome.tabs.update(session.tabId, { url: result.action.target.url });
    return;
  }

  if (result.action?.type === "COMPLETE") {
    session = await finishPlaybackTab(session);
    session = await finishRetiringPlaybackTab(session);
    await restorePlaybackMode(session.windowId, session.originalWindowState, session.changedWindowMode);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isEnvelope(message)) return;

  (async () => {
    switch (message.type) {
      case MessageType.GET_STATUS:
        return { ok: true, version: PROTOCOL_VERSION, status: publicStatus(await loadCurrentSession()) };
      case MessageType.START:
        return { ok: true, version: PROTOCOL_VERSION, status: await handleStart(message.payload) };
      case MessageType.STOP:
        return { ok: true, version: PROTOCOL_VERSION, status: await handleStop() };
      case MessageType.CAST_REMOTE_CONTROL:
        return { ok: true, version: PROTOCOL_VERSION, status: await handleCastRemoteControl(message.payload) };
      case MessageType.PERMISSION_GRANTED:
        return { ok: true, version: PROTOCOL_VERSION, status: await handlePermissionGranted() };
      case MessageType.CAST_RELAY_ITEM:
        await handleCastRelayItem(message, sender);
        return { ok: true, version: PROTOCOL_VERSION };
      case MessageType.CAST_RELAY_PLAYING:
        await handleCastRelayPlaying(message, sender);
        return { ok: true, version: PROTOCOL_VERSION };
      case MessageType.CAST_RELAY_FAILED:
        await handleCastRelayFailed(message, sender);
        return { ok: true, version: PROTOCOL_VERSION };
      case MessageType.MEDIA_FOUND:
      case MessageType.MEDIA_PLAYING:
      case MessageType.MEDIA_ENDED:
      case MessageType.MEDIA_ERROR:
      case MessageType.MEDIA_STALLED:
      case MessageType.MEDIA_PLAY_BLOCKED:
      case MessageType.MEDIA_REPLACED:
      case MessageType.CAST_STATUS:
      case MessageType.CAST_HANDOFF_REQUIRED:
        await handleMediaMessage(message, sender);
        return { ok: true, version: PROTOCOL_VERSION };
      default:
        return { ok: false, version: PROTOCOL_VERSION, error: "UNKNOWN_MESSAGE_TYPE" };
    }
  })().then(sendResponse).catch((error) => {
    sendResponse({ ok: false, version: PROTOCOL_VERSION, error: String(error?.message || error) });
  });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  (async () => {
    let session = await loadCurrentSession();
    if (!session || session.tabId !== tabId || session.state !== SessionState.NAVIGATING) return;
    session = await prepareEpisode(session, { enterWindow: false });
    await saveSession(session);
  })().catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    let session = await loadCurrentSession();
    if (!isSessionActive(session)) return;

    if (session.tabId === tabId) {
      const playbackTabId = session.playbackTabId;
      const retiringPlaybackTabId = session.retiringPlaybackTabId;
      session = stop(session);
      await saveSession(session);
      if (Number.isInteger(playbackTabId)) await closePlaybackSurface(playbackTabId);
      if (Number.isInteger(retiringPlaybackTabId) && retiringPlaybackTabId !== playbackTabId) {
        await closePlaybackSurface(retiringPlaybackTabId);
      }
      await restorePlaybackMode(session.windowId, session.originalWindowState, session.changedWindowMode);
      return;
    }

    if (session.playbackTabId === tabId) {
      const hasRetiringSender = Number.isInteger(session.retiringPlaybackTabId);
      session = markPlaybackSurfaceLost(session);
      await saveSession(session);
      if (!hasRetiringSender) {
        await restorePlaybackMode(session.windowId, session.originalWindowState, session.changedWindowMode);
      }
      return;
    }

    if (session.retiringPlaybackTabId === tabId) {
      const hadRelay = Boolean(session.cast?.relayToken);
      session = clearCastRelay(session, hadRelay ? "FAILED" : session.cast?.relayState ?? null);
      session = clearRetiringPlaybackSurface(session);
      await saveSession(session);
      if (hadRelay) await notifyCastRelayFailure(session, "CAST_RELAY_SENDER_CLOSED");
    }
  })().catch(() => {});
});
