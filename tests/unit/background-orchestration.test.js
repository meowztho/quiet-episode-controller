import test from "node:test";
import assert from "node:assert/strict";

const state = {
  storage: {},
  grantedOrigins: new Set(),
  runtimeListener: null,
  tabUpdatedListener: null,
  tabRemovedListener: null,
  windowUpdates: [],
  tabUpdates: [],
  createdTabs: [],
  removedTabs: [],
  injections: [],
  attachMessages: [],
  currentProbe: null,
  currentPlaybackUrl: "https://voe.sx/e/example",
  currentPlaybackDocumentId: "doc-voe",
  nextPlaybackTabId: 30,
  transientAttachFailures: 0,
  originShiftOnProviderInjection: null,
  debuggerAttaches: [],
  debuggerCommands: [],
  debuggerDetaches: []
};

const probe = {
  supported: true,
  episodeIdentity: {
    site: "aniworld",
    seriesSlug: "black-torch",
    season: 1,
    episode: 1,
    url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-1"
  },
  nextEpisode: {
    site: "aniworld",
    seriesSlug: "black-torch",
    season: 1,
    episode: 2,
    url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-2"
  },
  providers: [
    { key: "11", provider: "VOE", available: true, activation: { kind: "provider-navigation", target: "/redirect/11" } },
    { key: "22", provider: "Doodstream", available: true, activation: { kind: "provider-navigation", target: "/redirect/22" } }
  ],
  diagnostics: []
};
state.currentProbe = probe;

function reset(overrides = {}) {
  state.storage = {};
  state.grantedOrigins = new Set();
  state.windowUpdates = [];
  state.tabUpdates = [];
  state.createdTabs = [];
  state.removedTabs = [];
  state.injections = [];
  state.attachMessages = [];
  state.currentProbe = probe;
  state.currentPlaybackUrl = "https://voe.sx/e/example";
  state.currentPlaybackDocumentId = "doc-voe";
  state.nextPlaybackTabId = 30;
  state.transientAttachFailures = 0;
  state.originShiftOnProviderInjection = null;
  state.debuggerAttaches = [];
  state.debuggerCommands = [];
  state.debuggerDetaches = [];
  Object.assign(state, overrides);
}

globalThis.chrome = {
  storage: {
    session: {
      async get(key) { return { [key]: state.storage[key] }; },
      async set(values) { Object.assign(state.storage, values); },
      async remove(key) { delete state.storage[key]; }
    }
  },
  runtime: {
    onMessage: { addListener(fn) { state.runtimeListener = fn; } }
  },
  permissions: {
    async contains({ origins }) { return origins.every((origin) => state.grantedOrigins.has(origin)); }
  },
  debugger: {
    async attach(target, version) {
      state.debuggerAttaches.push({ target: structuredClone(target), version });
    },
    async sendCommand(target, method, params) {
      state.debuggerCommands.push({ target: structuredClone(target), method, params: structuredClone(params) });
      return { result: { type: "object", value: { ok: true, reason: null } } };
    },
    async detach(target) {
      state.debuggerDetaches.push(structuredClone(target));
    }
  },
  scripting: {
    async executeScript(details) {
      state.injections.push(structuredClone(details));
      if (details.files?.includes("src/providers/frame-agent.js") && state.originShiftOnProviderInjection) {
        state.currentPlaybackUrl = state.originShiftOnProviderInjection;
        state.currentPlaybackDocumentId = "doc-shifted";
        state.originShiftOnProviderInjection = null;
        throw new Error("Cannot access contents of the page. Extension manifest must request permission to access the respective host.");
      }
      return [];
    }
  },
  webNavigation: {
    async getFrame({ tabId, frameId }) {
      assert.equal(frameId, 0);
      const created = state.createdTabs.some((tab) => tab.id === tabId);
      if (!created) return null;
      return {
        frameId: 0,
        parentFrameId: -1,
        documentId: state.currentPlaybackDocumentId,
        url: state.currentPlaybackUrl
      };
    }
  },
  windows: {
    async get(id) { return { id, state: state.windowUpdates.at(-1)?.state ?? "normal" }; },
    async update(id, patch) {
      state.windowUpdates.push({ id, ...patch });
      return { id, state: patch.state };
    }
  },
  tabs: {
    onUpdated: { addListener(fn) { state.tabUpdatedListener = fn; } },
    onRemoved: { addListener(fn) { state.tabRemovedListener = fn; } },
    async create(options) {
      const tab = { id: state.nextPlaybackTabId++, ...options };
      state.createdTabs.push(tab);
      return tab;
    },
    async remove(tabId) { state.removedTabs.push(tabId); },
    async sendMessage(tabId, message, options) {
      if (message.type === "SITE_PROBE") {
        assert.equal(tabId, 10);
        return { ok: true, probe: state.currentProbe };
      }
      if (message.type === "PROVIDER_ATTACH") {
        if (state.transientAttachFailures > 0) {
          state.transientAttachFailures -= 1;
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        state.attachMessages.push({ tabId, message: structuredClone(message), options: structuredClone(options) });
        return { ok: true };
      }
      if (message.type === "PROVIDER_STOP") return { ok: true };
      throw new Error(`unexpected tabs.sendMessage ${message.type}`);
    },
    async update(tabId, patch) {
      state.tabUpdates.push({ tabId, ...patch });
      return { id: tabId, ...patch };
    }
  }
};

await import(`../../src/background.js?test=${Date.now()}`);

function message(type, payload = {}, sessionId = null, epoch = null) {
  return { version: 1, type, sessionId, epoch, payload };
}

function dispatch(msg, sender = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("message response timeout")), 4000);
    const result = state.runtimeListener(msg, sender, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    if (result !== true) {
      clearTimeout(timeout);
      resolve(undefined);
    }
  });
}

test("controller tab stays open while a temporary playback tab handles media and episode progression", async () => {
  reset();

  const start = await dispatch(message("POPUP_START", {
    tabId: 10,
    windowId: 20,
    fullscreen: true,
    providerPriority: ["VOE", "Doodstream"]
  }));

  assert.equal(start.ok, true);
  assert.equal(start.status.state, "BLOCKED");
  assert.equal(start.status.blockedReason, "PROVIDER_PERMISSION_REQUIRED");
  assert.equal(start.status.pendingPermissionOrigin, "https://voe.sx");
  assert.equal(start.status.tabId, 10);
  assert.equal(start.status.playbackTabId, 30);
  assert.equal(state.createdTabs.length, 1);
  assert.equal(state.createdTabs[0].url, "https://aniworld.to/redirect/11");
  assert.equal(state.createdTabs[0].active, false);
  assert.deepEqual(state.tabUpdates, [], "permission discovery must not steal the active tab");
  assert.deepEqual(state.windowUpdates, [], "fullscreen waits for provider permission");

  const repeatedStart = await dispatch(message("POPUP_START", {
    tabId: 10,
    windowId: 20,
    fullscreen: true,
    providerPriority: ["VOE", "Doodstream"]
  }));
  assert.equal(repeatedStart.status.sessionId, start.status.sessionId);
  assert.equal(state.createdTabs.length, 1, "repeated Start must not create another playback tab");

  state.grantedOrigins.add("https://voe.sx/*");
  state.transientAttachFailures = 1;
  const resumed = await dispatch(message("POPUP_PERMISSION_GRANTED", { origin: "https://voe.sx" }));
  assert.equal(resumed.status.state, "ARMING");
  assert.deepEqual(state.tabUpdates, [{ tabId: 30, active: true }], "grant resumes the existing playback tab without a second Start");
  assert.equal(state.createdTabs.length, 1, "grant must reuse the already-discovered playback tab");
  assert.equal(state.attachMessages.length, 1);
  assert.equal(state.attachMessages[0].tabId, 30);
  assert.equal(state.attachMessages[0].options.frameId, 0);
  const providerInjections = state.injections.filter((entry) =>
    entry.files?.includes("src/providers/jw-main-bridge.js") || entry.files?.includes("src/providers/frame-agent.js")
  );
  assert.ok(providerInjections.some((entry) => entry.files?.includes("src/providers/jw-main-bridge.js") && entry.world === "MAIN"));
  const firstBridge = providerInjections.findIndex((entry) => entry.files?.includes("src/providers/jw-main-bridge.js"));
  const firstAgent = providerInjections.findIndex((entry) => entry.files?.includes("src/providers/frame-agent.js"));
  assert.ok(firstBridge >= 0 && firstBridge < firstAgent, "JW MAIN-world bridge must be injected before the isolated provider agent");
  assert.deepEqual(state.windowUpdates, [{ id: 20, state: "fullscreen" }]);

  const playing = message("MEDIA_PLAYING", { paused: false, readyState: 4 }, resumed.status.sessionId, resumed.status.epoch);
  await dispatch(playing, { tab: { id: 30 }, frameId: 0 });
  assert.equal(state.storage["qec.session"].state, "RUNNING");

  const ended = message("MEDIA_ENDED", {}, resumed.status.sessionId, resumed.status.epoch);
  await dispatch(ended, { tab: { id: 30 }, frameId: 0 });
  assert.deepEqual(state.removedTabs, [30], "finished provider tab must close");
  assert.deepEqual(state.tabUpdates, [
    { tabId: 30, active: true },
    { tabId: 10, url: probe.nextEpisode.url }
  ], "controller advances after the already-activated playback tab finishes");

  await dispatch(ended, { tab: { id: 30 }, frameId: 0 });
  assert.equal(state.tabUpdates.length, 2, "duplicate ended event must not navigate twice");

  state.currentProbe = {
    ...probe,
    episodeIdentity: { ...probe.episodeIdentity, episode: 2, url: probe.nextEpisode.url },
    nextEpisode: { ...probe.nextEpisode, episode: 3, url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-3" }
  };
  state.tabUpdatedListener?.(10, { status: "complete" });
  await new Promise((resolve) => setTimeout(resolve, 550));

  let persisted = state.storage["qec.session"];
  assert.equal(persisted.state, "ARMING");
  assert.equal(persisted.epoch, 2);
  assert.equal(persisted.currentEpisode.episode, 2);
  assert.equal(persisted.playbackTabId, 31);
  assert.equal(state.createdTabs.length, 2, "next episode gets one fresh playback tab");
  assert.equal(state.attachMessages.length, 2);

  const playingNext = message("MEDIA_PLAYING", { paused: false, readyState: 4 }, persisted.sessionId, persisted.epoch);
  await dispatch(playingNext, { tab: { id: 31 }, frameId: 0 });
  persisted = state.storage["qec.session"];
  assert.equal(persisted.state, "RUNNING");
  assert.equal(state.windowUpdates.length, 1, "episode progression does not churn fullscreen");
  assert.equal("focused" in state.windowUpdates[0], false);

  state.tabRemovedListener?.(10);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(state.storage["qec.session"].state, "STOPPED");
  assert.ok(state.removedTabs.includes(31), "closing AniWorld controller must also close its playback tab");
  assert.deepEqual(state.windowUpdates.at(-1), { id: 20, state: "normal" });
});

test("existing provider permission survives a transient missing receiver in the top-level playback tab", async () => {
  reset({
    grantedOrigins: new Set(["https://voe.sx/*"]),
    transientAttachFailures: 2
  });

  const started = await dispatch(message("POPUP_START", {
    tabId: 10,
    windowId: 20,
    fullscreen: false,
    providerPriority: ["VOE", "Doodstream"]
  }));

  assert.equal(started.status.state, "ARMING");
  assert.equal(started.status.playbackTabId, 30);
  assert.deepEqual(state.tabUpdates, [{ tabId: 30, active: true }]);
  assert.equal(state.attachMessages.length, 1);
  assert.equal(state.injections.filter((x) => x.files?.includes("src/providers/frame-agent.js")).length, 3);
  assert.equal(state.injections.filter((x) => x.files?.includes("src/providers/jw-main-bridge.js") && x.world === "MAIN").length, 3);
  assert.deepEqual(state.windowUpdates, []);
  await dispatch(message("POPUP_STOP"));
});

test("current top-level provider origin owns permission after redirects", async () => {
  reset({
    grantedOrigins: new Set(["https://voe.sx/*"]),
    currentPlaybackUrl: "https://final-player.example/watch/abc",
    currentPlaybackDocumentId: "doc-final"
  });

  const started = await dispatch(message("POPUP_START", {
    tabId: 10,
    windowId: 20,
    fullscreen: false,
    providerPriority: ["VOE", "Doodstream"]
  }));

  assert.equal(started.status.state, "BLOCKED");
  assert.equal(started.status.blockedReason, "PROVIDER_PERMISSION_REQUIRED");
  assert.equal(started.status.pendingPermissionOrigin, "https://final-player.example");
  assert.equal(started.status.playbackDocument.origin, "https://final-player.example");
  assert.equal(state.attachMessages.length, 0);
  await dispatch(message("POPUP_STOP"));
});

test("origin change during provider-agent injection becomes a new permission boundary", async () => {
  reset({
    grantedOrigins: new Set(["https://voe.sx/*"]),
    originShiftOnProviderInjection: "https://final-player.example/watch/late"
  });

  const started = await dispatch(message("POPUP_START", {
    tabId: 10,
    windowId: 20,
    fullscreen: false,
    providerPriority: ["VOE", "Doodstream"]
  }));

  assert.equal(started.status.state, "BLOCKED");
  assert.equal(started.status.blockedReason, "PROVIDER_PERMISSION_REQUIRED");
  assert.equal(started.status.pendingPermissionOrigin, "https://final-player.example");
  assert.equal(started.status.playbackDocument.origin, "https://final-player.example");
  assert.equal(state.attachMessages.length, 0);
  await dispatch(message("POPUP_STOP"));
});


test("JW autoplay block gets one targeted background-tab Space recovery without OS focus", async () => {
  reset({ grantedOrigins: new Set(["https://voe.sx/*"]) });

  const started = await dispatch(message("POPUP_START", {
    tabId: 10,
    windowId: 20,
    fullscreen: false,
    providerPriority: ["VOE", "Doodstream"]
  }));

  assert.equal(started.status.state, "ARMING");
  const blocked = message("MEDIA_PLAY_BLOCKED", {
    playerKind: "JWPlayer",
    reason: "AUTOPLAY_BLOCKED",
    state: "idle"
  }, started.status.sessionId, started.status.epoch);

  await dispatch(blocked, { tab: { id: 30 }, frameId: 0 });
  let persisted = state.storage["qec.session"];
  assert.equal(persisted.state, "BLOCKED");
  assert.equal(persisted.playbackActivationAttempts, 1);
  assert.deepEqual(state.debuggerAttaches, [{ target: { tabId: 30 }, version: "1.3" }]);
  assert.equal(state.debuggerCommands.length, 2);
  assert.equal(state.debuggerCommands[0].method, "Input.dispatchKeyEvent");
  assert.equal(state.debuggerCommands[0].params.type, "rawKeyDown");
  assert.equal(state.debuggerCommands[0].params.code, "Space");
  assert.equal(state.debuggerCommands[1].method, "Input.dispatchKeyEvent");
  assert.equal(state.debuggerCommands[1].params.type, "keyUp");
  assert.equal(state.debuggerCommands[1].params.code, "Space");
  assert.deepEqual(state.debuggerDetaches, [{ tabId: 30 }]);

  await dispatch(blocked, { tab: { id: 30 }, frameId: 0 });
  assert.equal(state.debuggerCommands.length, 2, "trusted gesture recovery is bounded to one attempt per episode");

  await dispatch(message("MEDIA_PLAYING", {
    playerKind: "JWPlayer",
    state: "playing"
  }, started.status.sessionId, started.status.epoch), { tab: { id: 30 }, frameId: 0 });
  persisted = state.storage["qec.session"];
  assert.equal(persisted.state, "RUNNING");

  await dispatch(message("POPUP_STOP"));
});

test("Doodstream current playmogo host can attach without a second runtime permission click", async () => {
  reset({
    grantedOrigins: new Set(["https://playmogo.com/*"]),
    currentPlaybackUrl: "https://playmogo.com/e/dood-example",
    currentPlaybackDocumentId: "doc-dood"
  });

  const started = await dispatch(message("POPUP_START", {
    tabId: 10,
    windowId: 20,
    fullscreen: true,
    providerPriority: ["Doodstream", "VOE"]
  }));

  assert.equal(started.ok, true);
  assert.equal(started.status.state, "ARMING");
  assert.equal(started.status.selectedProvider.provider, "Doodstream");
  assert.equal(started.status.pendingPermissionOrigin, null);
  assert.equal(started.status.playbackDocument.origin, "https://playmogo.com");
  assert.equal(state.attachMessages.length, 1);
  assert.equal(state.attachMessages[0].message.payload.provider, "Doodstream");
  assert.deepEqual(state.windowUpdates, [{ id: 20, state: "fullscreen" }]);
  await dispatch(message("POPUP_STOP"));
});

test("HTML5 autoplay block gets one userGesture playback recovery on the canonical playback tab", async () => {
  reset({
    grantedOrigins: new Set(["https://playmogo.com/*"]),
    currentPlaybackUrl: "https://playmogo.com/e/dood-example",
    currentPlaybackDocumentId: "doc-dood"
  });

  const started = await dispatch(message("POPUP_START", {
    tabId: 10,
    windowId: 20,
    fullscreen: false,
    providerPriority: ["Doodstream", "VOE"]
  }));

  assert.equal(started.status.state, "ARMING");
  const blocked = message("MEDIA_PLAY_BLOCKED", {
    playerKind: "HTML5",
    playerUi: "provider",
    reason: "PLAY_START_TIMEOUT",
    paused: true,
    readyState: 4,
    playAttempt: 1
  }, started.status.sessionId, started.status.epoch);

  await dispatch(blocked, { tab: { id: 30 }, frameId: 0 });
  let persisted = state.storage["qec.session"];
  assert.equal(persisted.playbackActivationAttempts, 1);
  assert.deepEqual(state.debuggerAttaches, [{ target: { tabId: 30 }, version: "1.3" }]);
  assert.equal(state.debuggerCommands.length, 1);
  assert.equal(state.debuggerCommands[0].method, "Runtime.evaluate");
  assert.equal(state.debuggerCommands[0].params.userGesture, true);
  assert.match(state.debuggerCommands[0].params.expression, /data-qec-canonical-media/);
  assert.deepEqual(state.debuggerDetaches, [{ tabId: 30 }]);

  await dispatch(blocked, { tab: { id: 30 }, frameId: 0 });
  assert.equal(state.debuggerCommands.length, 1, "HTML5 recovery remains bounded to one attempt per episode");

  await dispatch(message("MEDIA_PLAYING", {
    playerKind: "HTML5",
    playerUi: "provider",
    paused: false,
    readyState: 4
  }, started.status.sessionId, started.status.epoch), { tab: { id: 30 }, frameId: 0 });
  persisted = state.storage["qec.session"];
  assert.equal(persisted.state, "RUNNING");

  await dispatch(message("POPUP_STOP"));
});

test("Auto runtime failure closes the failed provider and tries the next provider once", async () => {
  reset({
    grantedOrigins: new Set(["https://voe.sx/*", "https://playmogo.com/*"])
  });

  const started = await dispatch(message("POPUP_START", {
    tabId: 10,
    windowId: 20,
    fullscreen: false,
    providerPriority: ["VOE", "Doodstream"],
    providerFailoverEnabled: true
  }));

  assert.equal(started.status.selectedProvider.provider, "VOE");
  assert.deepEqual(started.status.attemptedProviders, ["VOE"]);

  const blocked = message("MEDIA_PLAY_BLOCKED", {
    playerKind: "JWPlayer",
    reason: "PLAY_START_TIMEOUT",
    state: "idle"
  }, started.status.sessionId, started.status.epoch);

  await dispatch(blocked, { tab: { id: 30 }, frameId: 0 });
  assert.equal(state.storage["qec.session"].playbackActivationAttempts, 1);

  state.currentPlaybackUrl = "https://playmogo.com/e/dood-example";
  state.currentPlaybackDocumentId = "doc-dood";
  await dispatch(blocked, { tab: { id: 30 }, frameId: 0 });

  let persisted = state.storage["qec.session"];
  assert.equal(persisted.state, "ARMING");
  assert.equal(persisted.selectedProvider.provider, "Doodstream");
  assert.deepEqual(persisted.attemptedProviders, ["VOE", "Doodstream"]);
  assert.equal(persisted.providerFailures.length, 1);
  assert.equal(persisted.providerFailures[0].provider, "VOE");
  assert.equal(persisted.providerFailures[0].reason, "PLAY_START_TIMEOUT");
  assert.deepEqual(state.removedTabs, [30]);
  assert.equal(state.createdTabs.length, 2);
  assert.equal(persisted.playbackTabId, 31);

  await dispatch(message("MEDIA_PLAYING", {
    playerKind: "HTML5",
    paused: false,
    readyState: 4
  }, persisted.sessionId, persisted.epoch), { tab: { id: 31 }, frameId: 0 });
  persisted = state.storage["qec.session"];
  assert.equal(persisted.state, "RUNNING");

  await dispatch(message("POPUP_STOP"));
});

test("Auto stops with NO_WORKING_PROVIDER after every offered provider failed once", async () => {
  reset({
    grantedOrigins: new Set(["https://voe.sx/*", "https://playmogo.com/*"])
  });

  const started = await dispatch(message("POPUP_START", {
    tabId: 10,
    windowId: 20,
    fullscreen: false,
    providerPriority: ["VOE", "Doodstream"],
    providerFailoverEnabled: true
  }));

  const voeBlocked = message("MEDIA_PLAY_BLOCKED", {
    playerKind: "JWPlayer",
    reason: "PLAY_START_TIMEOUT"
  }, started.status.sessionId, started.status.epoch);
  await dispatch(voeBlocked, { tab: { id: 30 }, frameId: 0 });

  state.currentPlaybackUrl = "https://playmogo.com/e/dood-example";
  state.currentPlaybackDocumentId = "doc-dood";
  await dispatch(voeBlocked, { tab: { id: 30 }, frameId: 0 });

  let persisted = state.storage["qec.session"];
  assert.equal(persisted.selectedProvider.provider, "Doodstream");
  assert.equal(persisted.playbackTabId, 31);

  await dispatch(message("MEDIA_ERROR", {
    playerKind: "HTML5",
    mediaErrorCode: 4
  }, persisted.sessionId, persisted.epoch), { tab: { id: 31 }, frameId: 0 });

  persisted = state.storage["qec.session"];
  assert.equal(persisted.state, "BLOCKED");
  assert.equal(persisted.blockedReason, "NO_WORKING_PROVIDER");
  assert.deepEqual(persisted.attemptedProviders, ["VOE", "Doodstream"]);
  assert.equal(persisted.providerFailures.length, 2);
  assert.deepEqual(state.removedTabs, [30, 31]);
  assert.equal(state.createdTabs.length, 2, "Auto must not loop back to a provider already tried this episode");

  await dispatch(message("POPUP_STOP"));
});

test("manual provider selection never runtime-fails over to another provider", async () => {
  reset({ grantedOrigins: new Set(["https://voe.sx/*", "https://playmogo.com/*"]) });

  const started = await dispatch(message("POPUP_START", {
    tabId: 10,
    windowId: 20,
    fullscreen: false,
    providerPriority: ["VOE"],
    providerFailoverEnabled: false
  }));

  const blocked = message("MEDIA_PLAY_BLOCKED", {
    playerKind: "JWPlayer",
    reason: "PLAY_START_TIMEOUT"
  }, started.status.sessionId, started.status.epoch);

  await dispatch(blocked, { tab: { id: 30 }, frameId: 0 });
  await dispatch(blocked, { tab: { id: 30 }, frameId: 0 });

  const persisted = state.storage["qec.session"];
  assert.equal(persisted.state, "BLOCKED");
  assert.equal(persisted.blockedReason, "PLAY_START_TIMEOUT");
  assert.equal(persisted.selectedProvider.provider, "VOE");
  assert.deepEqual(persisted.attemptedProviders, ["VOE"]);
  assert.equal(state.createdTabs.length, 1);
  assert.deepEqual(state.removedTabs, []);

  await dispatch(message("POPUP_STOP"));
});
