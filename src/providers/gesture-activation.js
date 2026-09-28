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

export async function invokeTrustedCastSessionRequest(tabId) {
  return withDebugger(tabId, async (target) => {
    // A retained HTML5 Cast handoff may run on a page where the legacy
    // requestSessionById() API is unavailable. Supply one transient user
    // activation to the canonical Cast bridge so Google's own CastContext can
    // open its managed session UI. The bridge, not this transport, owns all
    // Cast API access; QEC still does not select a receiver or load media.
    const response = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(() => {
        const requestSession = globalThis.__QEC_CAST_TRUSTED_REQUEST_SESSION__;
        if (typeof requestSession !== "function") {
          return { ok: false, reason: "QEC_CAST_BRIDGE_REQUEST_SESSION_NOT_FOUND" };
        }
        try {
          return requestSession();
        } catch (error) {
          return {
            ok: false,
            reason: String(error?.name || "Error") + ": " + String(error?.message || error || "requestSession failed")
          };
        }
      })()`,
      returnByValue: true,
      userGesture: true
    });

    const value = response?.result?.value;
    if (value?.ok) return { ok: true };
    return {
      ok: false,
      reason: value?.reason || response?.exceptionDetails?.text || "TRUSTED_CAST_SESSION_REQUEST_FAILED"
    };
  });
}

export async function invokeTrustedHtml5Cast(tabId) {
  return withDebugger(tabId, async (target) => {
    // Mirror the provider's own Cast affordance without inventing a media
    // transport. Scope discovery to the canonical HTML5 player surface and a
    // small set of semantic Cast controls used by common player libraries.
    const located = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(() => {
        const media = document.querySelector(${JSON.stringify(QEC_MEDIA_SELECTOR)});
        if (!media) return { ok: false, reason: "QEC_CANONICAL_MEDIA_NOT_FOUND" };

        const surface = media.closest('.plyr, .video-js, .dplayer, media-player, video-player') || media.parentElement;
        if (!surface) return { ok: false, reason: "HTML5_PLAYER_SURFACE_NOT_FOUND" };

        const selectors = [
          'google-cast-launcher',
          '.vjs-chromecast-button',
          '.vjs-cast-button',
          '.vjs-icon-chromecast',
          '.plyr__control[data-plyr="cast"]',
          'button[aria-label*="cast" i]',
          '[role="button"][aria-label*="cast" i]',
          'button[title*="cast" i]',
          '[role="button"][title*="cast" i]'
        ];

        const roots = [surface];
        for (const selector of selectors) {
          for (const root of roots) {
            for (const element of root.querySelectorAll(selector)) {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0) continue;
              if (rect.width < 4 || rect.height < 4) continue;
              return {
                ok: true,
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                selector,
                ariaLabel: element.getAttribute('aria-label') || null,
                title: element.getAttribute('title') || null
              };
            }
          }
        }
        return { ok: false, reason: "HTML5_CAST_CONTROL_NOT_FOUND" };
      })()`,
      returnByValue: true
    });

    const point = located?.result?.value;
    if (!point?.ok || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return { ok: false, reason: point?.reason || "HTML5_CAST_CONTROL_NOT_FOUND" };
    }

    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
      buttons: 0
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });

    return {
      ok: true,
      target: point.selector,
      ariaLabel: point.ariaLabel || null,
      title: point.title || null
    };
  });
}

export async function invokeTrustedJwCast(tabId) {
  return withDebugger(tabId, async (target) => {
    // Reproduce the provider player's own Chromecast control with a trusted,
    // tab-local pointer event. This targets only JW's cast control inside the
    // playback tab; it never moves the OS pointer or clicks arbitrary page UI.
    const located = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(() => {
        const selectors = [
          ".jw-icon-cast",
          "button[aria-label*='cast' i]",
          "[role='button'][aria-label*='cast' i]",
          "google-cast-launcher"
        ];
        for (const selector of selectors) {
          for (const element of document.querySelectorAll(selector)) {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) <= 0) continue;
            if (rect.width < 4 || rect.height < 4) continue;
            return {
              ok: true,
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              selector,
              ariaLabel: element.getAttribute("aria-label") || null
            };
          }
        }
        return { ok: false, reason: "JW_CAST_CONTROL_NOT_FOUND" };
      })()`,
      returnByValue: true
    });

    const point = located?.result?.value;
    if (!point?.ok || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return { ok: false, reason: point?.reason || "JW_CAST_CONTROL_NOT_FOUND" };
    }

    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
      buttons: 0
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });

    return {
      ok: true,
      target: point.selector || ".jw-icon-cast",
      ariaLabel: point.ariaLabel || null
    };
  });
}
