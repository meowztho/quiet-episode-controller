import { envelope, MessageType, SessionState } from "../core/protocol.js";
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
  error: document.querySelector("#error")
};

let lastStatus = null;

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

  const active = ![SessionState.IDLE, SessionState.STOPPED, SessionState.COMPLETED].includes(state);
  els.start.disabled = active;
  els.provider.disabled = active;
  els.fullscreen.disabled = active;
  els.stop.disabled = !active;
  els.grant.hidden = status?.blockedReason !== "PROVIDER_PERMISSION_REQUIRED" || !status?.pendingPermissionOrigin;
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
