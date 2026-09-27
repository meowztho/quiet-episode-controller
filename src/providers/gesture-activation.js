const DEBUGGER_PROTOCOL_VERSION = "1.3";
const SPACE_EVENT = Object.freeze({
  key: " ",
  code: "Space",
  windowsVirtualKeyCode: 32,
  nativeVirtualKeyCode: 32
});
const QEC_MEDIA_SELECTOR = 'video[data-qec-canonical-media="true"]';

async function dispatchSpace(target, type) {
  await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
    type,
    ...SPACE_EVENT
  });
}

async function withDebugger(tabId, action) {
  if (!Number.isInteger(tabId)) throw new TypeError("playback tab id is required");

  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION);
    attached = true;
    return await action(target);
  } catch (error) {
    return { ok: false, reason: String(error?.message || error || "TRUSTED_PLAYBACK_START_FAILED") };
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target); } catch {}
    }
  }
}

export async function invokeTrustedJwPlayback(tabId) {
  return withDebugger(tabId, async (target) => {
    // Send the semantic JW Play/Pause shortcut directly to the playback target.
    // CDP targets the tab itself; this does not synthesize OS keyboard input or
    // require the browser window to become the foreground application.
    await dispatchSpace(target, "rawKeyDown");
    await dispatchSpace(target, "keyUp");
    return { ok: true };
  });
}

export async function invokeTrustedHtml5Playback(tabId) {
  return withDebugger(tabId, async (target) => {
    // The Provider Frame Agent owns media selection and marks exactly one
    // canonical HTMLMediaElement in the shared document tree. Runtime.evaluate only
    // transports a user activation to that already-selected element; it does
    // not discover media, inspect network state, or click provider UI.
    const response = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(() => {
        const media = document.querySelector(${JSON.stringify(QEC_MEDIA_SELECTOR)});
        if (!media || typeof media.play !== "function") {
          return { ok: false, reason: "QEC_CANONICAL_MEDIA_NOT_FOUND" };
        }
        try {
          const result = media.play();
          if (!result || typeof result.then !== "function") {
            return { ok: true, paused: Boolean(media.paused) };
          }
          return result.then(
            () => ({ ok: true, paused: Boolean(media.paused) }),
            (error) => ({
              ok: false,
              reason: String(error?.name || "Error") + ": " + String(error?.message || error || "play failed")
            })
          );
        } catch (error) {
          return {
            ok: false,
            reason: String(error?.name || "Error") + ": " + String(error?.message || error || "play failed")
          };
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });

    const value = response?.result?.value;
    if (value?.ok) return { ok: true };
    return {
      ok: false,
      reason: value?.reason || response?.exceptionDetails?.text || "TRUSTED_HTML5_PLAYBACK_FAILED"
    };
  });
}
