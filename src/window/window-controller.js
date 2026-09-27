export async function enterPlaybackMode(windowId) {
  const before = await chrome.windows.get(windowId);
  if (before.state === "fullscreen") {
    return { changed: false, originalState: "fullscreen", currentState: "fullscreen" };
  }
  const after = await chrome.windows.update(windowId, { state: "fullscreen" });
  return { changed: true, originalState: before.state, currentState: after.state };
}

export async function restorePlaybackMode(windowId, originalState, changed) {
  if (!changed || !originalState || originalState === "fullscreen") return false;
  try {
    await chrome.windows.update(windowId, { state: originalState });
    return true;
  } catch {
    return false;
  }
}
