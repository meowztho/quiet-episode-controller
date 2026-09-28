import { CastRemoteAction, envelope, MessageType, PlaybackAuthority, SessionLifecycle, SessionState } from "../core/protocol.js";
import { permissionPatternForOrigin } from "../permissions/permission-broker.js";
import { DEFAULT_PROVIDER_PRIORITY } from "../providers/registry.js";

const els = {
  state: document.querySelector("#state"),
  details: document.querySelector("#details"),
  provider: document.querySelector("#provider"),
  fullscreen: document.querySelector("#fullscreen"),
  start: document.querySelector("#start"),
  stop: document.querySelector("#stop"),
  grant: document.querySelector("#grant"),
  castControls: document.querySelector("#cast-controls"),
  castBack: document.querySelector("#cast-back"),
  castToggle: document.querySelector("#cast-toggle"),
  castForward: document.querySelector("#cast-forward"),
  castSeek: document.querySelector("#cast-seek"),
  castCurrent: document.querySelector("#cast-current"),
  castDuration: document.querySelector("#cast-duration"),
  error: document.querySelector("#error")
};

let lastStatus = null;
let castSeekInProgress = false;

function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function providerSelection() {
  if (els.provider.value === "voe") {
    return { providerPriority: ["VOE"], providerFailoverEnabled: false };
  }
  if (els.provider.value === "doodstream") {
    return { providerPriority: ["Doodstream"], providerFailoverEnabled: false };
  }
  return { providerPriority: [...DEFAULT_PROVIDER_PRIORITY], providerFailoverEnabled: true };
}

function render(status) {
  lastStatus = status;
  const state = status?.state || SessionState.IDLE;
  els.state.textContent = state;

  const lines = [];
  if (status?.currentEpisode) {
    lines.push(`Episode: S${status.currentEpisode.season}E${status.currentEpisode.episode}`);
  }
  if (status?.selectedProvider?.provider) lines.push(`Hoster: ${status.selectedProvider.provider}`);
  if (status?.providerFailoverEnabled && status?.providerFailures?.length) {
    const failed = status.providerFailures.map((entry) => `${entry.provider} (${entry.reason})`).join(" → ");
    lines.push(`Fallback: ${failed}`);
  }
  if (status?.playbackDocument?.origin) lines.push(`Player: ${status.playbackDocument.origin}`);
  if (status?.lifecycle === SessionLifecycle.ACTIVE) {
    const authority = status?.playbackAuthority;
    if (authority === PlaybackAuthority.CAST) lines.push("Wiedergabe: Chromecast");
    else if (authority === PlaybackAuthority.LOCAL) lines.push("Wiedergabe: Webplayer");
    else lines.push("Wiedergabe: Übergang / noch nicht gestartet");
  }
  if (status?.cast?.connected) {
    const device = status.cast.deviceName || "Cast-Gerät";
    lines.push(`Cast: ${device} · wird für diese Session beibehalten`);
    if (status.cast.stickyTransferMethod) lines.push(`Cast-Handoff: ${status.cast.stickyTransferMethod}`);
    if (status.cast.remoteControlDriver) lines.push(`Cast-Steuerung: ${status.cast.remoteControlDriver}`);
    if (typeof status.cast.jwCastActive === "boolean") {
      lines.push(`JW Cast: ${status.cast.jwCastActive ? "aktiv" : "inaktiv"}`);
    }
    if (Array.isArray(status.cast.trace) && status.cast.trace.length) {
      lines.push(`Cast-Trace: ${status.cast.trace.slice(-10).join(" → ")}`);
    }
  } else if (status?.cast?.sticky && status?.cast?.sessionId) {
    const device = status.cast.deviceName || "Cast-Gerät";
    lines.push(`Cast: ${device} · Wiederverbinden…`);
    if (Array.isArray(status.cast.trace) && status.cast.trace.length) {
      lines.push(`Cast-Trace: ${status.cast.trace.slice(-10).join(" → ")}`);
    }
  } else if (status?.cast?.available) {
    lines.push("Cast: verfügbar · Gerät einmal im Player auswählen");
  }
  if (status?.blockedReason) lines.push(`Status: ${status.blockedReason}`);
  if (status?.lastMedia?.type) {
    const media = status.lastMedia.payload || {};
    const detail = [
      `Media: ${status.lastMedia.type}`,
      media.playerKind ? `player=${media.playerKind}` : null,
      media.state ? `state=${media.state}` : null,
      typeof media.paused === "boolean" ? `paused=${media.paused}` : null,
      Number.isFinite(media.readyState) ? `ready=${media.readyState}` : null,
      Number.isFinite(media.playAttempt) ? `try=${media.playAttempt}` : null,
      media.errorName ? `error=${media.errorName}` : null
    ].filter(Boolean).join(" · ");
    lines.push(detail);
  }
  if (status?.pendingPermissionOrigin) lines.push(`Benötigt Zugriff: ${status.pendingPermissionOrigin}`);
  els.details.textContent = lines.join("\n");

  const active = status?.lifecycle === SessionLifecycle.ACTIVE;
  els.start.disabled = active;
  els.provider.disabled = active;
  els.fullscreen.disabled = active;
  els.stop.disabled = !active;
  els.grant.hidden = status?.blockedReason !== "PROVIDER_PERMISSION_REQUIRED" || !status?.pendingPermissionOrigin;

  const castState = String(status?.cast?.mediaPlayerState || "").toUpperCase();
  const castControlActive = Boolean(
    active &&
    status?.playbackAuthority === PlaybackAuthority.CAST &&
    status?.cast?.connected &&
    status?.cast?.remoteControlAvailable
  );
  els.castControls.hidden = !castControlActive;
  if (castControlActive) {
    const current = Number.isFinite(status.cast.remoteCurrentTime) ? status.cast.remoteCurrentTime : 0;
    const duration = Number.isFinite(status.cast.remoteDuration) && status.cast.remoteDuration > 0
      ? status.cast.remoteDuration
      : 0;
    const canSeek = duration > 0 && status.cast.isMediaLoaded !== false;
    els.castToggle.textContent = castState === "PLAYING" || castState === "BUFFERING" ? "Pause" : "Fortsetzen";
    els.castBack.disabled = !canSeek;
    els.castForward.disabled = !canSeek;
    els.castSeek.disabled = !canSeek;
    els.castSeek.max = String(Math.max(1, Math.floor(duration)));
    if (!castSeekInProgress) els.castSeek.value = String(Math.min(current, Math.max(1, duration)));
    els.castCurrent.textContent = formatTime(castSeekInProgress ? Number(els.castSeek.value) : current);
    els.castDuration.textContent = formatTime(duration);
  } else {
    castSeekInProgress = false;
  }
}

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage(envelope(type, payload));
  if (!response?.ok) throw new Error(response?.error || "Unbekannter Fehler");
  if (response.status) render(response.status);
  return response;
}

async function refresh() {
  try {
    els.error.textContent = "";
    const response = await send(MessageType.GET_STATUS);
    render(response.status);
  } catch (error) {
    els.error.textContent = String(error?.message || error);
  }
}

els.start.addEventListener("click", async () => {
  try {
    els.error.textContent = "";
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab?.windowId) throw new Error("Kein aktiver Tab gefunden");
    const selection = providerSelection();
    await send(MessageType.START, {
      tabId: tab.id,
      windowId: tab.windowId,
      fullscreen: els.fullscreen.checked,
      ...selection
    });
  } catch (error) {
    els.error.textContent = String(error?.message || error);
  }
});

els.stop.addEventListener("click", async () => {
  try {
    els.error.textContent = "";
    await send(MessageType.STOP);
  } catch (error) {
    els.error.textContent = String(error?.message || error);
  }
});

async function castControl(action, seconds = null) {
  try {
    els.error.textContent = "";
    await send(MessageType.CAST_REMOTE_CONTROL, {
      action,
      ...(Number.isFinite(seconds) ? { seconds } : {})
    });
  } catch (error) {
    els.error.textContent = String(error?.message || error);
  }
}

els.castToggle.addEventListener("click", () => castControl(CastRemoteAction.TOGGLE_PLAY_PAUSE));
els.castBack.addEventListener("click", () => castControl(CastRemoteAction.SEEK_RELATIVE, -10));
els.castForward.addEventListener("click", () => castControl(CastRemoteAction.SEEK_RELATIVE, 10));
els.castSeek.addEventListener("input", () => {
  castSeekInProgress = true;
  els.castCurrent.textContent = formatTime(Number(els.castSeek.value));
});
els.castSeek.addEventListener("change", async () => {
  const seconds = Number(els.castSeek.value);
  castSeekInProgress = false;
  if (Number.isFinite(seconds)) await castControl(CastRemoteAction.SEEK_TO, seconds);
});

els.grant.addEventListener("click", async () => {
  try {
    els.error.textContent = "";
    const origin = lastStatus?.pendingPermissionOrigin;
    if (!origin) throw new Error("Kein Hoster-Zugriff ausstehend");
    const pattern = permissionPatternForOrigin(origin);
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) throw new Error("Zugriff wurde nicht erteilt");
    await send(MessageType.PERMISSION_GRANTED, { origin });
  } catch (error) {
    els.error.textContent = String(error?.message || error);
  }
});

void refresh();
setInterval(refresh, 1000);
