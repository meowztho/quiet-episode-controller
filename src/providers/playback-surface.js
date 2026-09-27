const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_INTERVAL_MS = 150;
const STABLE_OBSERVATIONS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpUrl(input) {
  try {
    const url = input instanceof URL ? input : new URL(input);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

export function providerEntryUrl(candidate, baseUrl) {
  const activation = candidate?.activation;
  if (!activation || activation.kind !== "provider-navigation" || !activation.target) return null;
  try {
    const url = new URL(activation.target, baseUrl);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

export async function currentPlaybackDocument(tabId) {
  if (!Number.isInteger(tabId)) throw new TypeError("playback tab id is required");
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
  const url = httpUrl(frame?.url);
  if (!frame || !url) throw new Error("PLAYBACK_DOCUMENT_NOT_READY");
  return {
    tabId,
    frameId: 0,
    documentId: frame.documentId ?? null,
    url: url.href,
    origin: url.origin
  };
}

export async function waitForExternalPlaybackDocument(tabId, sourceOrigin, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  stableObservations = STABLE_OBSERVATIONS
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let stableKey = null;
  let stableCount = 0;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const current = await currentPlaybackDocument(tabId);
      if (current.origin !== sourceOrigin) {
        const key = `${current.documentId ?? ""}|${current.url}`;
        if (key === stableKey) stableCount += 1;
        else {
          stableKey = key;
          stableCount = 1;
        }
        if (stableCount >= stableObservations) return current;
      } else {
        stableKey = null;
        stableCount = 0;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }

  const detail = lastError ? `: ${String(lastError?.message || lastError)}` : "";
  throw new Error(`PLAYBACK_PROVIDER_NAVIGATION_TIMEOUT${detail}`);
}

export async function openPlaybackSurface({
  windowId,
  candidate,
  baseUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS
}) {
  const entry = providerEntryUrl(candidate, baseUrl);
  if (!entry) throw new Error("PROVIDER_TARGET_NOT_FOUND");
  const sourceOrigin = new URL(baseUrl).origin;

  const tab = await chrome.tabs.create({
    windowId,
    url: entry.href,
    active: false
  });
  if (!Number.isInteger(tab?.id)) throw new Error("PLAYBACK_TAB_CREATE_FAILED");

  try {
    const document = await waitForExternalPlaybackDocument(tab.id, sourceOrigin, { timeoutMs, intervalMs });
    return { tabId: tab.id, entryUrl: entry.href, document };
  } catch (error) {
    try { await chrome.tabs.remove(tab.id); } catch {}
    throw error;
  }
}

export async function activatePlaybackSurface(tabId) {
  if (!Number.isInteger(tabId)) throw new TypeError("playback tab id is required");
  await chrome.tabs.update(tabId, { active: true });
  return true;
}

export async function closePlaybackSurface(tabId) {
  if (!Number.isInteger(tabId)) return false;
  try {
    await chrome.tabs.remove(tabId);
    return true;
  } catch {
    return false;
  }
}
