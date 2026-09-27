(() => {
  if (globalThis.__QEC_JW_MAIN_BRIDGE__) return;
  globalThis.__QEC_JW_MAIN_BRIDGE__ = true;

  const CHANNEL = "__QEC_JW_BRIDGE_V1__";
  let boundPlayer = null;
  let boundHandlers = [];

  function safeCall(player, method, fallback = null) {
    try {
      if (!player || typeof player[method] !== "function") return fallback;
      return player[method]();
    } catch {
      return fallback;
    }
  }

  function findPlayer() {
    if (typeof globalThis.jwplayer !== "function") return null;

    const candidates = Array.from(document.querySelectorAll(".jwplayer[id]"));
    for (const element of candidates) {
      try {
        const player = globalThis.jwplayer(element.id);
        if (player && typeof player.getState === "function") return player;
      } catch {}
    }

    try {
      const player = globalThis.jwplayer();
      if (player && typeof player.getState === "function") return player;
    } catch {}
    return null;
  }

  function snapshot(player) {
    const state = safeCall(player, "getState", "unknown");
    const position = Number(safeCall(player, "getPosition", NaN));
    const duration = Number(safeCall(player, "getDuration", NaN));
    const volume = Number(safeCall(player, "getVolume", NaN));
    return {
      playerKind: "JWPlayer",
      state,
      currentTime: Number.isFinite(position) ? position : null,
      duration: Number.isFinite(duration) ? duration : null,
      volume: Number.isFinite(volume) ? volume / 100 : null,
      muted: Boolean(safeCall(player, "getMute", false)),
      fullscreen: Boolean(safeCall(player, "getFullscreen", false))
    };
  }

  function post(event, payload = {}) {
    window.postMessage({
      channel: CHANNEL,
      direction: "main-to-isolated",
      event,
      payload
    }, "*");
  }

  function unbind() {
    if (!boundPlayer) return;
    for (const [event, handler] of boundHandlers) {
      try { boundPlayer.off?.(event, handler); } catch {}
    }
    boundHandlers = [];
    boundPlayer = null;
  }

  function bind(player) {
    if (!player || player === boundPlayer) return;
    unbind();
    boundPlayer = player;

    const events = [
      ["ready", "READY"],
      ["play", "PLAY"],
      ["pause", "PAUSE"],
      ["complete", "COMPLETE"],
      ["error", "ERROR"],
      ["warning", "WARNING"],
      ["buffer", "BUFFER"],
      ["idle", "IDLE"],
      ["firstFrame", "FIRST_FRAME"],
      ["playAttemptFailed", "PLAY_FAILED"],
      ["autostartNotAllowed", "AUTOSTART_NOT_ALLOWED"],
      ["resize", "RESIZE"],
      ["fullscreen", "FULLSCREEN"]
    ];

    for (const [jwEvent, qecEvent] of events) {
      const handler = (eventData = {}) => post(qecEvent, { ...snapshot(player), eventData });
      try {
        player.on(jwEvent, handler);
        boundHandlers.push([jwEvent, handler]);
      } catch {}
    }

    post("AVAILABLE", snapshot(player));
  }

  function ensurePlayer() {
    const player = findPlayer();
    if (player) bind(player);
    return player;
  }

  globalThis.__QEC_JW_USER_GESTURE_PLAY__ = () => {
    const player = ensurePlayer();
    if (!player || typeof player.play !== "function") return false;
    player.play();
    return true;
  };

  function handleCommand(command, payload = {}) {
    const player = ensurePlayer();
    if (!player) {
      post("UNAVAILABLE", { playerKind: "JWPlayer" });
      return;
    }

    try {
      switch (command) {
        case "PROBE":
          post("STATUS", snapshot(player));
          break;
        case "PLAY":
          player.play();
          break;
        case "PAUSE":
          player.pause();
          break;
        case "TOGGLE_PLAYBACK": {
          const state = safeCall(player, "getState", "unknown");
          if (state === "playing" || state === "buffering") player.pause();
          else player.play();
          break;
        }
        case "PRESENT_VIEWPORT": {
          const fallbackHeight = Number(globalThis.innerHeight || document.documentElement?.clientHeight || 720);
          const height = Math.max(1, Math.round(Number(payload.height) || fallbackHeight || 720));
          if (typeof player.setControls === "function") player.setControls(true);
          if (typeof player.setAllowFullscreen === "function") player.setAllowFullscreen(true);
          if (typeof player.resize === "function") player.resize("100%", height);
          post("STATUS", snapshot(player));
          break;
        }
        case "SEEK":
          if (Number.isFinite(Number(payload.position))) player.seek(Number(payload.position));
          break;
        case "SET_VOLUME":
          if (Number.isFinite(Number(payload.volume))) {
            player.setVolume(Math.max(0, Math.min(100, Number(payload.volume))));
          }
          break;
        case "SET_MUTE":
          player.setMute(Boolean(payload.muted));
          break;
        default:
          break;
      }
    } catch (error) {
      post("ERROR", {
        ...snapshot(player),
        error: String(error?.message || error || "JW command failed")
      });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.direction !== "isolated-to-main") return;
    handleCommand(data.command, data.payload || {});
  });

  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (ensurePlayer() || attempts >= 80) clearInterval(timer);
  }, 250);
  ensurePlayer();
})();
