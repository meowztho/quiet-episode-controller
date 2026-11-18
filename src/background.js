import { CastRemoteAction, envelope, isEnvelope, MessageType, PlaybackAuthority, PROTOCOL_VERSION, SessionLifecycle, SessionState } from "./core/protocol.js";
import {
  acceptMessage,
  beginCastRelay,
  beginEpisode,
  block,
  clearCastRelay,
  clearPlaybackSurface,
  clearRetainedCast,
  clearRetiringPlaybackSurface,
  createSession,
  isPrepareStalled,
  isRetainedCastRelayInFlight,
  isSessionActive,
  markPlaybackSurfaceLost,
  markProviderAttached,
  PREPARE_STALL_RECOVERY_LIMIT,
  recordCastStatus,
  recordMedia,
  recordPlaybackActivationAttempt,
  recordProviderFailure,
  recordStallRecoveryAttempt,
  requireProviderPermission,
  promoteRetiringPlaybackSurface,
  retirePlaybackSurface,
  selectProvider,
  SESSION_SCHEMA_VERSION,
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
  // This runs inside loadCurrentSession, which is itself called from inside the
  // write queue. It discards an incompatible session before any valid queued
  // read-modify-save can exist for it, so it must not acquire the queue again.
  await saveSession(null);
  return null;
}

function sessionIsCurrent(current, expected, { requireActive = true } = {}) {
  return Boolean(
    current &&
    expected &&
    (!requireActive || isSessionActive(current)) &&
    current.sessionId === expected.sessionId &&
    current.epoch === expected.epoch
  );
}

// Stop and the short guarded writes below share this mutex. Holding it only for
// the load/modify/save keeps the long provider navigation and attach waits out of
// the critical section while preventing a Stop that lands during the save from
// being overwritten by an older snapshot.
let sessionWriteTail = Promise.resolve();
function withSessionWrite(operation) {
  const result = sessionWriteTail.then(operation);
  sessionWriteTail = result.catch(() => {});
  return result;
}

// Long-running attach/permission work must not write a snapshot captured before
// its awaits. Re-load first, then apply the intended patch to the live session so
// a concurrent Stop, Cast status or tab transition is never overwritten.
// Cleanup writes that may legitimately run after COMPLETE (surface/tab removal)
// pass requireActive:false; the session id and epoch still fence a restarted
// episode, so an old cleanup can never touch the new session.
async function updateCurrentSession(expected, update, options = {}) {
  return await withSessionWrite(async () => {
    const current = await loadCurrentSession();
    if (!sessionIsCurrent(current, expected, options)) return { session: current, stale: true };
    const next = update(current);
    if (!next) return { session: current, stale: true };
    await saveSession(next);
    return { session: next, stale: false };
  });
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
      permissionBlockKind: null,
      lastGrantedPermissionOrigin: null,
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
    permissionBlockKind: session.permissionBlockKind ?? null,
    lastGrantedPermissionOrigin: session.lastGrantedPermissionOrigin ?? null,
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

// Chrome reports a missing/revoked host permission as a scripting failure, not as
// a provider defect. Treat it as a new exact-origin permission boundary so Auto
// does not fail over to a different provider.
function isAccessDeniedError(error) {
  const message = String(error?.message || error).toLowerCase();
  return (
    message.includes("cannot access contents of the page") ||
    message.includes("extension manifest must request permission") ||
    message.includes("missing host permission") ||
    message.includes("cannot be scripted")
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

      if (isAccessDeniedError(error)) {
        return { attached: false, document, reason: "PROVIDER_PERMISSION_REQUIRED" };
      }
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
    const documentUpdate = await updateCurrentSession(session, (current) =>
      setPlaybackDocument(current, document));
    if (documentUpdate.stale) return documentUpdate.session;
    session = documentUpdate.session;

    const permission = await getPermissionState(document.origin);
    if (permission.state !== "GRANTED") {
      const blockedUpdate = await updateCurrentSession(session, (current) =>
        requireProviderPermission(current, document.origin, document));
      return blockedUpdate.session;
    }

    // The retiring Cast sender remains visible while a temporary helper
    // loads the next provider-owned JW item. Only activate the helper if
    // remote continuation fails and local fallback is needed.
    const retainedCastHelper = Boolean(
      session.cast?.sticky &&
      Number.isInteger(session.retiringPlaybackTabId) &&
      session.retiringPlaybackProvider === session.selectedProvider?.provider
    );
    if (!retainedCastHelper) await activatePlaybackSurface(session.playbackTabId);

    const result = await injectAndHandshakeProvider(session, document);
    if (result.attached) {
      const attachedOrigin = result.document?.origin ?? document.origin;
      const attachedUpdate = await updateCurrentSession(session, (current) =>
        markProviderAttached(setPlaybackDocument(current, result.document), attachedOrigin));
      return attachedUpdate.session;
    }

    if (result.reason === "PROVIDER_PERMISSION_REQUIRED") {
      const permissionUpdate = await updateCurrentSession(session, (current) =>
        requireProviderPermission(current, result.document.origin, result.document));
      return permissionUpdate.session;
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
    intervalMs: PLAYBACK_NAVIGATION_INTERVAL_MS,
    // Register the tab as soon as it exists, not after redirect settlement:
    // Stop/controller-close must be able to find and close an in-flight tab.
    onCreated: async (tabId) => {
      const update = await updateCurrentSession(session, (current) => setPlaybackTab(current, tabId));
      if (update.stale) throw new Error("PLAYBACK_OPEN_CANCELLED");
      session = update.session;
    }
  });

  const update = await updateCurrentSession(session, (current) =>
    current.playbackTabId === opened.tabId ? setPlaybackDocument(current, opened.document) : null);
  if (update.stale) {
    await closePlaybackSurface(opened.tabId);
    throw new Error("PLAYBACK_OPEN_CANCELLED");
  }
  session = update.session;
  return await attachPlaybackSurface(session);
}

async function enterInitialWindowMode(session) {
  if (!session.fullscreen || session.originalWindowState !== null) return session;

  try {
    const windowResult = await enterPlaybackMode(session.windowId);
    const update = await updateCurrentSession(session, (current) => ({
      ...current,
      originalWindowState: windowResult.originalState,
      changedWindowMode: windowResult.changed,
      updatedAt: Date.now()
    }));
    return update.session;
  } catch (error) {
    const update = await updateCurrentSession(session, (current) =>
      block(current, "WINDOW_FULLSCREEN_FAILED", [String(error?.message || error)]));
    return update.session;
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
  const update = await updateCurrentSession(session, (current) => {
    const reason = (current.attemptedProviders ?? []).length ? "NO_WORKING_PROVIDER" : "NO_PROVIDER_AVAILABLE";
    return block(current, reason, providerFailureDiagnostics(current));
  });
  return update.session;
}

async function openProviderCandidateLoop(session, probe) {
  while (true) {
    const candidate = chooseProvider(
      probe.providers,
      session.providerPriority?.length ? session.providerPriority : DEFAULT_PROVIDER_PRIORITY,
      { excludeProviders: session.attemptedProviders ?? [] }
    );
    if (!candidate) return await blockNoWorkingProvider(session);

    const selected = await updateCurrentSession(session, (current) => selectProvider(current, candidate));
    if (selected.stale) return selected.session;
    session = selected.session;

    try {
      const opened = await openSelectedPlayback(session);
      return opened;
    } catch (error) {
      const reason = String(error?.message || error);
      const persisted = await loadCurrentSession();
      if (!isSessionActive(persisted) || persisted.sessionId !== session.sessionId) return persisted;
      session = persisted;

      if (!session.providerFailoverEnabled) {
        if (Number.isInteger(session.playbackTabId)) session = await finishPlaybackTab(session);
        const blocked = await updateCurrentSession(session, (current) => block(current, reason, [reason]));
        return blocked.session;
      }

      const failed = await updateCurrentSession(session, (current) =>
        recordProviderFailure(current, reason, { phase: "provider-setup" }));
      if (failed.stale) return failed.session;
      session = failed.session;
      if (Number.isInteger(session.playbackTabId)) session = await finishPlaybackTab(session);
    }
  }
}

async function probeCurrentEpisodeForFailover(session) {
  try {
    const probe = await probeEpisode(session.tabId);
    if (!probe?.supported || !sameEpisodeIdentity(probe.episodeIdentity, session.currentEpisode)) {
      const update = await updateCurrentSession(session, (current) =>
        block(current, "CONTROLLER_EPISODE_CHANGED_DURING_FAILOVER", probe?.diagnostics ?? []));
      return { session: update.session, probe: null };
    }
    return { session, probe };
  } catch (error) {
    const reason = String(error?.message || error);
    const update = await updateCurrentSession(session, (current) => block(current, reason, [reason]));
    return { session: update.session, probe: null };
  }
}

async function failoverToNextProvider(session, reason, payload = null) {
  if (!session?.providerFailoverEnabled || !isSessionActive(session)) return session;

  const failed = await updateCurrentSession(session, (current) => recordProviderFailure(current, reason, payload));
  if (failed.stale) return failed.session;
  session = failed.session;
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
      const cleared = await updateCurrentSession(session, clearPlaybackSurface);
      if (cleared.stale) return cleared.session;
      session = cleared.session;
      await closePlaybackSurface(staleTabId);
    }

    const probe = await probeEpisode(session.tabId);
    const begun = await updateCurrentSession(session, (current) => beginEpisode(current, probe));
    if (begun.stale) return begun.session;
    session = begun.session;
    if (session.state === SessionState.BLOCKED) return session;

    session = await openProviderCandidateLoop(session, probe);
    if (!session) return await loadCurrentSession();
    if (enterWindow && ![SessionState.BLOCKED, SessionState.STOPPED, SessionState.COMPLETED].includes(session.state)) {
      session = await enterInitialWindowMode(session);
    }
    return session;
  } catch (error) {
    const reason = String(error?.message || error);
    const update = await updateCurrentSession(session, (current) => block(current, reason, [reason]));
    return update.session;
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
  // A brand-new session has no prior snapshot to re-load. Route the write
  // through the same queue anyway so it cannot interleave with an in-flight
  // read-modify-save on the previous session.
  await withSessionWrite(() => saveSession(session));
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

async function handleCastConnect() {
  const session = await loadCurrentSession();
  if (!isSessionActive(session) || !Number.isInteger(session.playbackTabId)) {
    throw new Error("CAST_CONNECT_PLAYBACK_UNAVAILABLE");
  }
  if (session.cast?.connected || session.playbackAuthority === PlaybackAuthority.CAST) {
    throw new Error("CAST_ALREADY_CONNECTED");
  }
  const playerKind = session.lastMedia?.payload?.playerKind;
  if (!session.cast?.available || !["JWPlayer", "HTML5"].includes(playerKind)) {
    throw new Error("CAST_PLAYER_NOT_READY");
  }
  // This is only a shortcut to the provider's visible native Cast control.
  // The provider/Google UI remains the sole device selector and media owner.
  const result = playerKind === "JWPlayer"
    ? await invokeTrustedJwCast(session.playbackTabId)
    : await invokeTrustedHtml5Cast(session.playbackTabId);
  if (!result.ok) throw new Error(result.reason || "CAST_NATIVE_CONTROL_UNAVAILABLE");
  return publicStatus(session);
}

async function handleCastRemoteControl(payload) {
  let session = await loadCurrentSession();
  const response = await sendCastRemoteControl(session, payload);
  if (response?.status) {
    const update = await updateCurrentSession(session, (current) =>
      recordCastStatus(current, response.status));
    session = update.session;
  }
  return publicStatus(session);
}

async function handleStop() {
  const observed = await loadCurrentSession();
  if (!observed) return publicStatus(null);

  if (
    isSessionActive(observed) &&
    observed.playbackAuthority === PlaybackAuthority.CAST &&
    observed.cast?.connected &&
    observed.cast?.remoteControlAvailable &&
    Number.isInteger(observed.playbackTabId)
  ) {
    try {
      await sendCastRemoteControl(observed, { action: CastRemoteAction.STOP });
    } catch {}
  }

  // Re-load inside the shared short-write mutex: an attach save that started
  // before Stop must not land after the ENDED write and resurrect the session.
  let playbackTabId = null;
  let retiringPlaybackTabId = null;
  const stopped = await withSessionWrite(async () => {
    const current = await loadCurrentSession();
    if (!current) return null;
    playbackTabId = current.playbackTabId;
    retiringPlaybackTabId = current.retiringPlaybackTabId;
    if (!isSessionActive(current)) return current;
    const next = stop(current);
    await saveSession(next);
    return next;
  });
  const session = stopped ?? observed;

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

let permissionGrantOperation = null;

async function handlePermissionGranted(payload = {}) {
  let session = await loadCurrentSession();
  if (!session || session.blockedReason !== "PROVIDER_PERMISSION_REQUIRED") return publicStatus(session);

  const origin = String(session.pendingPermissionOrigin || payload?.origin || "");
  if (origin) {
    const update = await updateCurrentSession(session, (current) => ({
      ...current,
      lastGrantedPermissionOrigin: origin,
      permissionBlockKind: null,
      updatedAt: Date.now()
    }));
    if (update.stale) return publicStatus(update.session);
    session = update.session;
  }

  try {
    session = await attachPlaybackSurface(session);
    if (!session) return publicStatus(await loadCurrentSession());
    if (![SessionState.BLOCKED, SessionState.STOPPED, SessionState.COMPLETED].includes(session.state)) {
      session = await enterInitialWindowMode(session);
    }
  } catch (error) {
    const current = await loadCurrentSession();
    if (!sessionIsCurrent(current, session)) return publicStatus(current);
    session = current;
    const reason = String(error?.message || error);
    if (session.providerFailoverEnabled) {
      session = await failoverToNextProvider(session, reason, { phase: "post-permission-attach" });
    } else {
      if (Number.isInteger(session.playbackTabId)) session = await finishPlaybackTab(session);
      const update = await updateCurrentSession(session, (latest) => block(latest, reason, [reason]));
      session = update.session;
    }
  }
  return publicStatus(session);
}

// The popup button and the GET_STATUS auto-resume share one resume operation so
// a granted permission can never attach twice.
function runPermissionGranted(payload = {}) {
  if (permissionGrantOperation) return permissionGrantOperation;
  const operation = handlePermissionGranted(payload).finally(() => {
    if (permissionGrantOperation === operation) permissionGrantOperation = null;
  });
  permissionGrantOperation = operation;
  return operation;
}

async function finishPlaybackTab(session) {
  let playbackTabId = null;
  const update = await updateCurrentSession(session, (current) => {
    playbackTabId = current.playbackTabId;
    return clearPlaybackSurface(current);
  }, { requireActive: false });
  if (!update.stale && Number.isInteger(playbackTabId)) await closePlaybackSurface(playbackTabId);
  return update.session;
}

async function retireCurrentPlaybackTab(session) {
  const update = await updateCurrentSession(session, retirePlaybackSurface);
  return update.session;
}

async function finishRetiringPlaybackTab(session) {
  if (!Number.isInteger(session?.retiringPlaybackTabId)) return clearCastRelay(session);
  let retiringPlaybackTabId = null;
  const update = await updateCurrentSession(session, (current) => {
    retiringPlaybackTabId = current.retiringPlaybackTabId;
    return clearRetiringPlaybackSurface(clearCastRelay(current));
  }, { requireActive: false });
  if (!update.stale && Number.isInteger(retiringPlaybackTabId)) {
    await closePlaybackSurface(retiringPlaybackTabId);
  }
  return update.session;
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
  const started = await updateCurrentSession(session, (current) => {
    if (current.retiringPlaybackTabId !== retiringTabId || !current.cast?.sticky) return null;
    if (current.retiringPlaybackProvider !== current.selectedProvider?.provider) return null;
    return recordCastStatus(beginCastRelay(current, relayToken), { traceEvent: "CAST_RELAY_ITEM_READY" });
  });
  if (started.stale) return;
  session = started.session;

  try {
    const response = await chrome.tabs.sendMessage(
      retiringTabId,
      envelope(MessageType.CAST_RELAY_APPLY, { transferId: relayToken, item }, session),
      { frameId: 0 }
    );
    if (!response?.ok) throw new Error(response?.reason || "CAST_RELAY_APPLY_FAILED");
    const delivered = await updateCurrentSession(session, (current) =>
      current.cast?.relayToken === relayToken
        ? recordCastStatus(current, { traceEvent: "CAST_RELAY_DELIVERED" })
        : null);
    session = delivered.session;
  } catch (error) {
    let relayFailed = false;
    const failed = await updateCurrentSession(session, (current) => {
      if (current.cast?.relayToken !== relayToken) return null;
      relayFailed = true;
      return recordCastStatus(clearRetainedCast(clearCastRelay(current, "FAILED")), {
        traceEvent: "CAST_RELAY_DELIVERY_FAILED"
      });
    });
    session = failed.session;
    if (relayFailed) {
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

  const senderDocument = await currentPlaybackDocument(tabId).catch(() => null);
  let sourceTabId = null;
  const update = await updateCurrentSession(session, (current) => {
    if (current.retiringPlaybackTabId !== tabId || current.cast?.relayToken !== transferId) return null;
    sourceTabId = current.playbackTabId;
    const status = recordCastStatus(current, {
      ...message.payload,
      connected: true,
      sessionId: message.payload?.sessionId || current.cast?.sessionId,
      deviceName: message.payload?.deviceName || current.cast?.deviceName,
      receiverApplicationId: message.payload?.receiverApplicationId || current.cast?.receiverApplicationId,
      traceEvent: "CAST_RELAY_REMOTE_PLAYING"
    });
    const media = recordMedia(status, MessageType.MEDIA_PLAYING, {
      ...message.payload,
      playerKind: "GoogleCast",
      relayTransfer: true
    }).session;
    return promoteRetiringPlaybackSurface(media, senderDocument);
  });
  if (update.stale) return;
  session = update.session;

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
  const update = await updateCurrentSession(session, (current) => {
    if (current.retiringPlaybackTabId !== tabId || current.cast?.relayToken !== transferId) return null;
    return recordCastStatus(clearRetainedCast(clearCastRelay(current, "FAILED")), {
      traceEvent: "CAST_RELAY_FAILED"
    });
  });
  if (update.stale) return;
  session = update.session;
  await notifyCastRelayFailure(session, message.payload?.reason || "CAST_RELAY_FAILED");
}

async function handleMediaMessage(message, sender) {
  let session = await loadCurrentSession();
  const tabId = sender.tab?.id;
  if (!acceptMessage(session, { sessionId: message.sessionId, epoch: message.epoch, tabId })) return;
  if (sender.frameId !== 0) return;

  if (message.type === MessageType.CAST_STATUS) {
    // Load, patch and save in one queue turn. An attach save that loaded just
    // before this status must not be able to overwrite it with a stale snapshot.
    const update = await updateCurrentSession(session, (current) => {
      const status = recordCastStatus(current, message.payload);
      return message.payload?.stickyResumeFailed ? clearRetainedCast(status) : status;
    });
    if (update.stale) return;
    session = update.session;
    if (message.payload?.stickyResumeFailed && Number.isInteger(session.retiringPlaybackTabId)) {
      // The retained receiver identity is dead regardless of whether a
      // retiring sender is still registered. The sender-close path may already
      // have cleared that tab before this status arrives.
      session = await finishRetiringPlaybackTab(session);
      if (Number.isInteger(session.playbackTabId)) {
        await activatePlaybackSurface(session.playbackTabId);
      }
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

    const update = await updateCurrentSession(session, (current) => ({
      ...current,
      diagnostics: [
        ...(current.diagnostics || []),
        activation.ok
          ? successDiagnostic
          : `cast-handoff: ${activation.reason || failureReason}`
      ],
      updatedAt: Date.now()
    }));
    if (update.stale) return;
    session = update.session;
    try {
      await chrome.tabs.sendMessage(
        tabId,
        envelope(MessageType.CAST_HANDOFF_RESULT, { ...activation, handoffMethod }, session),
        { frameId: 0 }
      );
    } catch {}
    return;
  }

  let action = null;
  const mediaUpdate = await updateCurrentSession(session, (current) => {
    const recorded = recordMedia(current, message.type, message.payload);
    action = recorded.action;
    return recorded.session;
  });
  if (mediaUpdate.stale) return;
  session = mediaUpdate.session;

  if (message.type === MessageType.MEDIA_PLAYING && Number.isInteger(session.retiringPlaybackTabId)) {
    // D-028 relay mode has exactly one remote-success producer: CAST_RELAY_PLAYING
    // from the retiring sender. A helper observing the same receiver must not
    // close that sender or promote itself in parallel.
    if ((message.payload?.playerKind === "GoogleCast" || !session.cast?.sticky) && !isRetainedCastRelayInFlight(session)) {
      session = await finishRetiringPlaybackTab(session);
    }
  }

  const blockedReason = message.payload?.reason;
  const activationEligible =
    message.type === MessageType.MEDIA_PLAY_BLOCKED &&
    ["AUTOPLAY_BLOCKED", "PLAY_START_TIMEOUT"].includes(blockedReason);

  if (activationEligible && Number(session.playbackActivationAttempts || 0) < 1) {
    const attempt = await updateCurrentSession(session, recordPlaybackActivationAttempt);
    if (attempt.stale) return;
    session = attempt.session;
    const activation = message.payload?.playerKind === "JWPlayer"
      ? await invokeTrustedJwPlayback(tabId)
      : await invokeTrustedHtml5Playback(tabId);

    if (activation.ok) return;

    const failed = await updateCurrentSession(session, (current) => ({
      ...current,
      diagnostics: [...(current.diagnostics || []), `trusted-playback: ${activation.reason}`],
      updatedAt: Date.now()
    }));
    if (failed.stale) return;
    session = failed.session;

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

  if (action?.type === "NAVIGATE_NEXT") {
    const isStickyCastEnd = Boolean(
      message.payload?.playerKind === "GoogleCast" &&
      session.cast?.sticky &&
      Number.isInteger(session.playbackTabId)
    );
    session = isStickyCastEnd
      ? await retireCurrentPlaybackTab(session)
      : await finishPlaybackTab(session);
    await chrome.tabs.update(session.tabId, { url: action.target.url });
    return;
  }

  if (action?.type === "COMPLETE") {
    session = await finishPlaybackTab(session);
    session = await finishRetiringPlaybackTab(session);
    await restorePlaybackMode(session.windowId, session.originalWindowState, session.changedWindowMode);
  }
}

// Chrome delivers Cast status, relay confirmation and tab removal independently.
// Serialize their read/modify/write transactions: an older STATUS write must
// not restore a helper as canonical after CAST_RELAY_PLAYING promotes its sender.
let sessionTransitionTail = Promise.resolve();
function serializeSessionTransition(operation) {
  const result = sessionTransitionTail.then(operation);
  sessionTransitionTail = result.catch(() => {});
  return result;
}

// One episode preparation at a time. A controller navigation can emit multiple
// completion events before the first asynchronous provider tab is registered.
let navigationOperation = null;

function prepareInFlight() {
  return Boolean(startOperation || navigationOperation || permissionGrantOperation);
}

async function reissueControllerNavigation(session) {
  try {
    const current = await loadCurrentSession();
    if (!sessionIsCurrent(current, session)) return;
    await chrome.tabs.update(session.tabId, { url: session.nextEpisode.url });
  } catch (error) {
    await updateCurrentSession(session, (current) =>
      block(current, "PREPARE_STALLED", [
        `navigation recovery failed: ${String(error?.message || error)}`
      ]));
  }
}

// Popup polling is the only trigger. A stalled prepare gets one bounded retry;
// the second stall becomes an explicit BLOCKED state instead of a retry loop.
// The retry itself runs outside the transition serializer so media/Cast
// messages are not blocked by its navigation wait.
async function recoverStalledPrepare(session) {
  if (!isPrepareStalled(session) || prepareInFlight()) return session;

  return await serializeSessionTransition(async () => {
    const current = await loadCurrentSession();
    if (!isPrepareStalled(current) || prepareInFlight()) return current;

    if (Number(current.stallRecoveryAttempts || 0) >= PREPARE_STALL_RECOVERY_LIMIT) {
      const update = await updateCurrentSession(current, (latest) =>
        block(latest, "PREPARE_STALLED", [
          "automatic preparation recovery also stalled"
        ]));
      return update.session;
    }

    const retry = await updateCurrentSession(current, recordStallRecoveryAttempt);
    if (retry.stale) return retry.session;
    const retrySession = retry.session;

    if (retrySession.state === SessionState.NAVIGATING && retrySession.nextEpisode) {
      // The controller navigation is the missing step. onUpdated owns the
      // actual prepare; the fresh phaseStartedAt bounds the next check.
      void reissueControllerNavigation(retrySession).catch(() => {});
      return retrySession;
    }

    const operation = prepareEpisode(retrySession, { enterWindow: true });
    navigationOperation = operation;
    void operation.catch(() => {}).finally(() => {
      if (navigationOperation === operation) navigationOperation = null;
    });
    return retrySession;
  });
}

function permissionResumeKeyFor(session) {
  if (session?.blockedReason !== "PROVIDER_PERMISSION_REQUIRED" || !session.pendingPermissionOrigin) return null;
  return `${session.pendingPermissionOrigin}|${session.permissionBlockKind ?? ""}`;
}

async function markPermissionResume(session, resumeKey) {
  return await updateCurrentSession(session, (current) => {
    if (permissionResumeKeyFor(current) !== resumeKey || current.permissionResumeKey === resumeKey) return null;
    return { ...current, permissionResumeKey: resumeKey };
  });
}

async function markPermissionResumeResult(resumeKey) {
  const current = await loadCurrentSession();
  if (!current) return null;
  // A failed attempt can reclassify the same block (NEW_ORIGIN ->
  // PREVIOUSLY_GRANTED). Mark the resulting key too, otherwise the next poll
  // would start another full attach against a persistent denial.
  const afterKey = permissionResumeKeyFor(current);
  if (!afterKey || afterKey === resumeKey) return current;
  const update = await updateCurrentSession(current, (latest) =>
    permissionResumeKeyFor(latest) === afterKey && latest.permissionResumeKey !== afterKey
      ? { ...latest, permissionResumeKey: afterKey }
      : null);
  return update.session;
}

// One auto-resume at a time. The persisted marker bounds settled failures;
// this promise only collapses concurrent popup polls onto the same attempt.
let permissionAutoResumeOperation = null;

function autoResumePermission() {
  if (permissionAutoResumeOperation) return permissionAutoResumeOperation;
  const operation = (async () => {
    // Claim the block inside the shared transition queue: re-load after any
    // popup grant that was already running, then skip a consumed key or an
    // attach that is already in flight. The claim is a short write; the long
    // attach runs after the queue is released so media/Cast transitions are not
    // blocked by provider injection.
    const claim = await serializeSessionTransition(async () => {
      const current = await loadCurrentSession();
      if (!current) return { session: null, claimed: false };
      const resumeKey = permissionResumeKeyFor(current);
      if (!resumeKey || current.permissionResumeKey === resumeKey) {
        return { session: current, claimed: false };
      }
      if (permissionGrantOperation) return { session: current, claimed: false };

      // Mark before the attempt so a worker suspension cannot repeat it and a
      // concurrent popup grant sees the key as consumed.
      const marked = await markPermissionResume(current, resumeKey);
      if (marked.stale) return { session: marked.session, claimed: false };
      return { session: marked.session, claimed: true, resumeKey };
    });

    if (!claim.claimed) return claim.session;
    await runPermissionGranted();
    return await markPermissionResumeResult(claim.resumeKey);
  })();
  const tracked = operation.finally(() => {
    if (permissionAutoResumeOperation === tracked) permissionAutoResumeOperation = null;
  });
  permissionAutoResumeOperation = tracked;
  return tracked;
}

async function handlePermissionGrantedRequest(payload = {}) {
  const session = await loadCurrentSession();
  if (!session || session.blockedReason !== "PROVIDER_PERMISSION_REQUIRED") return publicStatus(session);

  // The explicit popup grant consumes the same persisted key before attaching.
  // A concurrent GET_STATUS auto-resume therefore either sees the key already
  // consumed or joins the same single-flight attach operation.
  const resumeKey = permissionResumeKeyFor(session);
  if (resumeKey) await markPermissionResume(session, resumeKey);
  await runPermissionGranted(payload);
  const result = resumeKey ? await markPermissionResumeResult(resumeKey) : await loadCurrentSession();
  return publicStatus(result);
}

async function handleGetStatus() {
  let session = await loadCurrentSession();
  if (!session) return publicStatus(null);

  if (
    session.blockedReason === "PROVIDER_PERMISSION_REQUIRED" &&
    session.pendingPermissionOrigin &&
    !startOperation &&
    !navigationOperation
  ) {
    let permission = null;
    try {
      permission = await getPermissionState(session.pendingPermissionOrigin);
    } catch {}
    if (permission?.state === "GRANTED") {
      session = await autoResumePermission();
      if (!session) return publicStatus(null);
    }
  }

  session = await recoverStalledPrepare(session);
  return publicStatus(session);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isEnvelope(message)) return;

  (async () => {
    switch (message.type) {
      case MessageType.GET_STATUS:
        return { ok: true, version: PROTOCOL_VERSION, status: await handleGetStatus() };
      case MessageType.START:
        return { ok: true, version: PROTOCOL_VERSION, status: await handleStart(message.payload) };
      case MessageType.STOP:
        return { ok: true, version: PROTOCOL_VERSION, status: await serializeSessionTransition(() => handleStop()) };
      case MessageType.CAST_REMOTE_CONTROL:
        return { ok: true, version: PROTOCOL_VERSION, status: await handleCastRemoteControl(message.payload) };
      case MessageType.CAST_CONNECT:
        return { ok: true, version: PROTOCOL_VERSION, status: await handleCastConnect() };
      case MessageType.PERMISSION_GRANTED:
        return { ok: true, version: PROTOCOL_VERSION, status: await handlePermissionGrantedRequest(message.payload) };
      case MessageType.CAST_RELAY_ITEM:
        await serializeSessionTransition(() => handleCastRelayItem(message, sender));
        return { ok: true, version: PROTOCOL_VERSION };
      case MessageType.CAST_RELAY_PLAYING:
        await serializeSessionTransition(() => handleCastRelayPlaying(message, sender));
        return { ok: true, version: PROTOCOL_VERSION };
      case MessageType.CAST_RELAY_FAILED:
        await serializeSessionTransition(() => handleCastRelayFailed(message, sender));
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
        await serializeSessionTransition(() => handleMediaMessage(message, sender));
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
  if (changeInfo.status !== "complete" || navigationOperation) return;
  const operation = (async () => {
    const session = await loadCurrentSession();
    if (!session || session.tabId !== tabId || session.state !== SessionState.NAVIGATING) return;
    await prepareEpisode(session, { enterWindow: false });
  })();
  navigationOperation = operation;
  void operation.catch(() => {}).finally(() => {
    if (navigationOperation === operation) navigationOperation = null;
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void serializeSessionTransition(async () => {
    let session = await loadCurrentSession();
    if (!isSessionActive(session)) return;

    if (session.tabId === tabId) {
      const playbackTabId = session.playbackTabId;
      const retiringPlaybackTabId = session.retiringPlaybackTabId;
      const update = await updateCurrentSession(session, (current) =>
        current.tabId === tabId ? stop(current) : null);
      if (update.stale) return;
      session = update.session;
      if (Number.isInteger(playbackTabId)) await closePlaybackSurface(playbackTabId);
      if (Number.isInteger(retiringPlaybackTabId) && retiringPlaybackTabId !== playbackTabId) {
        await closePlaybackSurface(retiringPlaybackTabId);
      }
      await restorePlaybackMode(session.windowId, session.originalWindowState, session.changedWindowMode);
      return;
    }

    if (session.playbackTabId === tabId) {
      const update = await updateCurrentSession(session, (current) =>
        current.playbackTabId === tabId ? markPlaybackSurfaceLost(current) : null);
      if (update.stale) return;
      session = update.session;
      if (!Number.isInteger(session.retiringPlaybackTabId)) {
        await restorePlaybackMode(session.windowId, session.originalWindowState, session.changedWindowMode);
      }
      return;
    }

    if (session.retiringPlaybackTabId === tabId) {
      // A relay that was in flight or already delivered can no longer complete
      // once its sender closes. Clear the retained identity here as well, so a
      // later stickyResumeFailed (which may arrive after this branch cleared the
      // retiring tab) cannot leave the dead latch behind.
      let relayPending = false;
      const update = await updateCurrentSession(session, (current) => {
        if (current.retiringPlaybackTabId !== tabId) return null;
        relayPending = Boolean(current.cast?.relayToken) ||
          current.cast?.relayState === "TRANSFERRING";
        let next = clearCastRelay(current, relayPending ? "FAILED" : current.cast?.relayState ?? null);
        if (relayPending) next = clearRetainedCast(next);
        return clearRetiringPlaybackSurface(next);
      });
      if (update.stale) return;
      session = update.session;
      if (relayPending) await notifyCastRelayFailure(session, "CAST_RELAY_SENDER_CLOSED");
    }
  }).catch(() => {});
});
