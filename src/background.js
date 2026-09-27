import { envelope, isEnvelope, MessageType, PROTOCOL_VERSION, SessionState } from "./core/protocol.js";
import {
  acceptMessage,
  beginEpisode,
  block,
  clearPlaybackSurface,
  createSession,
  markProviderAttached,
  recordMedia,
  recordPlaybackActivationAttempt,
  recordProviderFailure,
  requireProviderPermission,
  selectProvider,
  setPlaybackDocument,
  setPlaybackTab,
  stop
} from "./core/session.js";
import { loadSession, saveSession } from "./core/session-store.js";
import { chooseProvider, DEFAULT_PROVIDER_PRIORITY } from "./providers/registry.js";
import { invokeTrustedHtml5Playback, invokeTrustedJwPlayback } from "./providers/gesture-activation.js";
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
const JW_MAIN_BRIDGE_FILE = "src/providers/jw-main-bridge.js";
const PROVIDER_ATTACH_ATTEMPTS = 20;
const PROVIDER_ATTACH_INTERVAL_MS = 150;
const PROVIDER_ORIGIN_HOP_LIMIT = 6;
const PLAYBACK_NAVIGATION_TIMEOUT_MS = 10000;
const PLAYBACK_NAVIGATION_INTERVAL_MS = 150;
const SESSION_SCHEMA_VERSION = 4;

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
      state: SessionState.IDLE,
      sessionId: null,
      currentEpisode: null,
      nextEpisode: null,
      selectedProvider: null,
      playbackTabId: null,
      playbackDocument: null,
      pendingPermissionOrigin: null,
      blockedReason: null,
      providerFailoverEnabled: false,
      attemptedProviders: [],
      providerFailures: [],
      diagnostics: []
    };
  }
  return {
    state: session.state,
    sessionId: session.sessionId,
    epoch: session.epoch,
    tabId: session.tabId,
    windowId: session.windowId,
    playbackTabId: session.playbackTabId,
    currentEpisode: session.currentEpisode,
    nextEpisode: session.nextEpisode,
    selectedProvider: session.selectedProvider,
    providerFailoverEnabled: Boolean(session.providerFailoverEnabled),
    attemptedProviders: session.attemptedProviders ?? [],
    providerFailures: session.providerFailures ?? [],
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
        files: [JW_MAIN_BRIDGE_FILE],
        world: "MAIN"
      });
      await chrome.scripting.executeScript({
        target: { tabId: session.playbackTabId, frameIds: [0] },
        files: [PROVIDER_AGENT_FILE]
      });

      const response = await chrome.tabs.sendMessage(
        session.playbackTabId,
        envelope(MessageType.PROVIDER_ATTACH, { provider: session.selectedProvider?.provider }, session),
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

async function handleStart(payload) {
  const {
    tabId,
    windowId,
    fullscreen = true,
    providerPriority = DEFAULT_PROVIDER_PRIORITY,
    providerFailoverEnabled = false
  } = payload ?? {};
  if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) throw new Error("ACTIVE_TAB_REQUIRED");

  const existing = await loadCurrentSession();
  if (existing && ![SessionState.STOPPED, SessionState.COMPLETED].includes(existing.state)) {
    if (existing.tabId === tabId) return publicStatus(existing);
    throw new Error("SESSION_ALREADY_ACTIVE");
  }

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

async function handleStop() {
  let session = await loadCurrentSession();
  if (!session) return publicStatus(null);

  const playbackTabId = session.playbackTabId;
  session = stop(session);
  await saveSession(session);

  if (Number.isInteger(playbackTabId)) {
    try {
      await chrome.tabs.sendMessage(playbackTabId, envelope(MessageType.PROVIDER_STOP, {}, session), { frameId: 0 });
    } catch {}
    await closePlaybackSurface(playbackTabId);
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

async function handleMediaMessage(message, sender) {
  let session = await loadCurrentSession();
  const tabId = sender.tab?.id;
  if (!acceptMessage(session, { sessionId: message.sessionId, epoch: message.epoch, tabId })) return;
  if (sender.frameId !== 0) return;

  const result = recordMedia(session, message.type, message.payload);
  session = result.session;
  await saveSession(session);

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
    session = await finishPlaybackTab(session);
    await chrome.tabs.update(session.tabId, { url: result.action.target.url });
    return;
  }

  if (result.action?.type === "COMPLETE") {
    session = await finishPlaybackTab(session);
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
      case MessageType.PERMISSION_GRANTED:
        return { ok: true, version: PROTOCOL_VERSION, status: await handlePermissionGranted() };
      case MessageType.MEDIA_FOUND:
      case MessageType.MEDIA_PLAYING:
      case MessageType.MEDIA_ENDED:
      case MessageType.MEDIA_ERROR:
      case MessageType.MEDIA_STALLED:
      case MessageType.MEDIA_PLAY_BLOCKED:
      case MessageType.MEDIA_REPLACED:
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
    if (!session || [SessionState.STOPPED, SessionState.COMPLETED].includes(session.state)) return;

    if (session.tabId === tabId) {
      const playbackTabId = session.playbackTabId;
      session = stop(session);
      await saveSession(session);
      if (Number.isInteger(playbackTabId)) await closePlaybackSurface(playbackTabId);
      await restorePlaybackMode(session.windowId, session.originalWindowState, session.changedWindowMode);
      return;
    }

    if (session.playbackTabId === tabId) {
      session = stop(session);
      await saveSession(session);
      await restorePlaybackMode(session.windowId, session.originalWindowState, session.changedWindowMode);
    }
  })().catch(() => {});
});
