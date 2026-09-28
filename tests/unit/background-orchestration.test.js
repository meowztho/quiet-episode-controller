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
  debuggerDetaches: [],
  castHandoffResultMessages: [],
  castRelayApplyMessages: [],
  castRelayPromoteMessages: [],
  castRelayFailureMessages: [],
  castRemoteControlMessages: []
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
  state.castHandoffResultMessages = [];
  state.castRelayApplyMessages = [];
  state.castRelayPromoteMessages = [];
  state.castRelayFailureMessages = [];
  state.castRemoteControlMessages = [];
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
      if (method === "Runtime.evaluate" && params?.expression?.includes(".jw-icon-cast")) {
        return { result: { type: "object", value: { ok: true, x: 300, y: 40, selector: ".jw-icon-cast", ariaLabel: "Cast" } } };
      }
      if (method === "Runtime.evaluate" && params?.expression?.includes(".vjs-chromecast-button")) {
        return { result: { type: "object", value: { ok: true, x: 280, y: 42, selector: ".vjs-chromecast-button", ariaLabel: "Cast" } } };
      }
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
      if (message.type === "CAST_HANDOFF_RESULT") {
        state.castHandoffResultMessages.push({ tabId, message: structuredClone(message), options: structuredClone(options) });
        return { ok: true };
      }
      if (message.type === "CAST_RELAY_APPLY") {
        state.castRelayApplyMessages.push({ tabId, message: structuredClone(message), options: structuredClone(options) });
        return { ok: true };
      }
      if (message.type === "CAST_RELAY_PROMOTE") {
        state.castRelayPromoteMessages.push({ tabId, message: structuredClone(message), options: structuredClone(options) });
        return { ok: true };
      }
      if (message.type === "CAST_RELAY_FAILED") {
        state.castRelayFailureMessages.push({ tabId, message: structuredClone(message), options: structuredClone(options) });
        return { ok: true };
      }
      if (message.type === "POPUP_CAST_REMOTE_CONTROL") {
        state.castRemoteControlMessages.push({ tabId, message: structuredClone(message), options: structuredClone(options) });
        return { ok: true };
      }
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
    entry.files?.includes("src/providers/cast-main-bridge.js") ||
    entry.files?.includes("src/providers/jw-main-bridge.js") ||
    entry.files?.includes("src/providers/frame-agent.js")
  );
  assert.ok(providerInjections.some((entry) => entry.files?.includes("src/providers/cast-main-bridge.js") && entry.world === "MAIN"));
  assert.ok(providerInjections.some((entry) => entry.files?.includes("src/providers/jw-main-bridge.js") && entry.world === "MAIN"));
  const castBridge = providerInjections.findIndex((entry) => entry.files?.includes("src/providers/cast-main-bridge.js"));
  const jwBridge = providerInjections.findIndex((entry) => entry.files?.includes("src/providers/jw-main-bridge.js"));
  const firstAgent = providerInjections.findIndex((entry) => entry.files?.includes("src/providers/frame-agent.js"));
  assert.ok(castBridge >= 0 && castBridge < firstAgent, "Cast MAIN-world bridge must be injected before the isolated provider agent");
  assert.ok(jwBridge >= 0 && jwBridge < firstAgent, "JW MAIN-world bridge must be injected before the isolated provider agent");
  assert.deepEqual(state.windowUpdates, [{ id: 20, state: "fullscreen" }]);

  const playing = message("MEDIA_PLAYING", { paused: false, readyState: 4 }, resumed.status.sessionId, resumed.status.epoch);
  await dispatch(playing, { tab: { id: 30 }, frameId: 0 });
  assert.equal(state.storage["qec.session"].state, "RUNNING");

  const castStatus = message("CAST_STATUS", {
    available: true,
    connected: true,
    sessionId: "cast-123",
    deviceName: "Wohnzimmer TV",
    receiverApplicationId: "CC1AD845",
    mediaPlayerState: "PLAYING"
  }, resumed.status.sessionId, resumed.status.epoch);
  await dispatch(castStatus, { tab: { id: 30 }, frameId: 0 });
  assert.equal(state.storage["qec.session"].cast.sticky, true);
  assert.equal(state.storage["qec.session"].cast.sessionId, "cast-123");

  const ended = message("MEDIA_ENDED", { playerKind: "GoogleCast" }, resumed.status.sessionId, resumed.status.epoch);
  await dispatch(ended, { tab: { id: 30 }, frameId: 0 });
  let retained = state.storage["qec.session"];
  assert.deepEqual(state.removedTabs, [], "sticky Cast keeps the old sender tab alive until the new sender is remote-playing");
  assert.equal(retained.playbackTabId, null);
  assert.equal(retained.retiringPlaybackTabId, 30);
  assert.deepEqual(state.tabUpdates, [
    { tabId: 30, active: true },
    { tabId: 10, url: probe.nextEpisode.url }
  ], "controller advances while the previous Cast sender overlaps temporarily");

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
  assert.equal(state.attachMessages[1].message.payload.castSessionId, "cast-123", "next provider page receives the sticky Cast session id for rejoin");
  assert.equal(state.attachMessages[1].message.payload.castReceiverApplicationId, "CC1AD845", "next provider page receives the retained Cast receiver app id before rejoin");

  const playingNext = message("MEDIA_PLAYING", { playerKind: "GoogleCast", mediaPlayerState: "PLAYING" }, persisted.sessionId, persisted.epoch);
  await dispatch(playingNext, { tab: { id: 31 }, frameId: 0 });
  persisted = state.storage["qec.session"];
  assert.equal(persisted.state, "RUNNING");
  assert.equal(persisted.retiringPlaybackTabId, null);
  assert.deepEqual(state.removedTabs, [30], "old sender closes only after the new Cast sender reaches MEDIA_PLAYING");
  assert.equal(state.windowUpdates.length, 1, "episode progression does not churn fullscreen");
  assert.equal("focused" in state.windowUpdates[0], false);

  state.tabRemovedListener?.(10);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(state.storage["qec.session"].state, "STOPPED");
  assert.ok(state.removedTabs.includes(31), "closing AniWorld controller must also close its playback tab");
  assert.deepEqual(state.windowUpdates.at(-1), { id: 20, state: "normal" });
});

test("retained Cast sender receives the next JW item transiently and becomes canonical again on remote play", async () => {
  reset({ grantedOrigins: new Set(["https://voe.sx/*"]) });

  const started = await dispatch(message("POPUP_START", {
    tabId: 10,
    windowId: 20,
    fullscreen: false,
    providerPriority: ["VOE", "Doodstream"]
  }));
  await dispatch(message("MEDIA_PLAYING", { playerKind: "JWPlayer", state: "playing" }, started.status.sessionId, started.status.epoch), { tab: { id: 30 }, frameId: 0 });
  await dispatch(message("CAST_STATUS", {
    available: true,
    connected: true,
    sessionId: "cast-123",
    deviceName: "Seb",
    receiverApplicationId: "CC1AD845",
    mediaPlayerState: "PLAYING"
  }, started.status.sessionId, started.status.epoch), { tab: { id: 30 }, frameId: 0 });

  await dispatch(message("MEDIA_ENDED", { playerKind: "GoogleCast" }, started.status.sessionId, started.status.epoch), { tab: { id: 30 }, frameId: 0 });
  state.currentProbe = {
    ...probe,
    episodeIdentity: { ...probe.episodeIdentity, episode: 2, url: probe.nextEpisode.url },
    nextEpisode: { ...probe.nextEpisode, episode: 3, url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-3" }
  };
  state.tabUpdatedListener?.(10, { status: "complete" });
  await new Promise((resolve) => setTimeout(resolve, 550));

  let persisted = state.storage["qec.session"];
  assert.equal(persisted.playbackTabId, 31);
  assert.equal(persisted.retiringPlaybackTabId, 30);
  assert.equal(persisted.retiringPlaybackProvider, "VOE");
  assert.equal(state.attachMessages[1].message.payload.castRelayMode, true);

  const opaqueItem = {
    title: "Episode 2",
    file: "https://media.example.invalid/opaque-next.m3u8",
    sources: [{ file: "https://media.example.invalid/opaque-next.m3u8", type: "hls" }]
  };
  await dispatch(message("CAST_RELAY_ITEM", { item: opaqueItem }, persisted.sessionId, persisted.epoch), { tab: { id: 31 }, frameId: 0 });

  assert.equal(state.castRelayApplyMessages.length, 1);
  assert.equal(state.castRelayApplyMessages[0].tabId, 30);
  assert.deepEqual(state.castRelayApplyMessages[0].message.payload.item, opaqueItem);
  const transferId = state.castRelayApplyMessages[0].message.payload.transferId;
  assert.match(transferId, /:2:cast-relay$/);
  assert.equal(JSON.stringify(state.storage).includes("media.example.invalid"), false, "opaque media details must never be persisted");
  assert.equal(state.storage["qec.session"].cast.relayState, "TRANSFERRING");

  await dispatch(message("CAST_RELAY_PLAYING", {
    transferId,
    playerKind: "GoogleCast",
    connected: true,
    sessionId: "cast-123",
    deviceName: "Seb",
    receiverApplicationId: "CC1AD845",
    mediaPlayerState: "PLAYING"
  }, started.status.sessionId, 1), { tab: { id: 30 }, frameId: 0 });

  persisted = state.storage["qec.session"];
  assert.equal(persisted.state, "RUNNING");
  assert.equal(persisted.playbackTabId, 30, "the proven Cast sender becomes canonical for the new episode");
  assert.equal(persisted.retiringPlaybackTabId, null);
  assert.equal(persisted.cast.relayState, "REMOTE");
  assert.equal(persisted.cast.connected, true);
  assert.equal(state.castRelayPromoteMessages.length, 1);
  assert.equal(state.castRelayPromoteMessages[0].tabId, 30);
  assert.deepEqual(state.removedTabs, [31], "the helper/source tab closes only after remote PLAYING");
  assert.equal(JSON.stringify(state.storage).includes("media.example.invalid"), false);

  await dispatch(message("POPUP_STOP"));
});

test("Doodstream helper keeps the retiring Cast sender until remote confirmation or bounded rejoin failure", async () => {
  reset({
    grantedOrigins: new Set(["https://playmogo.com/*"]),
    currentPlaybackUrl: "https://playmogo.com/e/dood-example",
    currentPlaybackDocumentId: "doc-dood"
  });

  const started = await dispatch(message("POPUP_START", {
    tabId: 10,
    windowId: 20,
    fullscreen: false,
    providerPriority: ["Doodstream"]
  }));

  await dispatch(message("MEDIA_PLAYING", { playerKind: "HTML5", paused: false, readyState: 4 }, started.status.sessionId, started.status.epoch), { tab: { id: 30 }, frameId: 0 });
  await dispatch(message("CAST_STATUS", {
    available: true,
    connected: true,
    sessionId: "cast-123",
    deviceName: "Seb",
    receiverApplicationId: "CC1AD845",
    mediaPlayerState: "PLAYING"
  }, started.status.sessionId, started.status.epoch), { tab: { id: 30 }, frameId: 0 });

  await dispatch(message("MEDIA_ENDED", { playerKind: "GoogleCast" }, started.status.sessionId, started.status.epoch), { tab: { id: 30 }, frameId: 0 });
  state.currentProbe = {
    ...probe,
    episodeIdentity: { ...probe.episodeIdentity, episode: 2, url: probe.nextEpisode.url },
    nextEpisode: { ...probe.nextEpisode, episode: 3, url: "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-3" },
    providers: [
      { key: "22", provider: "Doodstream", available: true, activation: { kind: "provider-navigation", target: "/redirect/22" } }
    ]
  };
  state.currentPlaybackDocumentId = "doc-dood-next";
  state.tabUpdatedListener?.(10, { status: "complete" });
  await new Promise((resolve) => setTimeout(resolve, 550));

  let persisted = state.storage["qec.session"];
  assert.equal(persisted.playbackTabId, 31);
  assert.equal(persisted.retiringPlaybackTabId, 30);
  assert.equal(persisted.retiringPlaybackProvider, "Doodstream");
  assert.equal(state.attachMessages[1].message.payload.castRelayMode, true);

  await dispatch(message("MEDIA_PLAYING", {
    playerKind: "HTML5",
    paused: false,
    readyState: 4
  }, persisted.sessionId, persisted.epoch), { tab: { id: 31 }, frameId: 0 });

  persisted = state.storage["qec.session"];
  assert.equal(persisted.retiringPlaybackTabId, 30, "local helper playback must not retire the retained Cast sender");
  assert.equal(persisted.playbackAuthority, "NONE", "local helper playback is not authoritative during retained Cast continuation");
  assert.equal(state.removedTabs.includes(30), false);

  await dispatch(message("CAST_STATUS", {
    playerKind: "GoogleCast",
    connected: false,
    stickyResumeFailed: true,
    stickyResumeReason: "CAST_RESUME_TIMEOUT"
  }, persisted.sessionId, persisted.epoch), { tab: { id: 31 }, frameId: 0 });

  persisted = state.storage["qec.session"];
  assert.equal(persisted.retiringPlaybackTabId, null);
  assert.equal(state.removedTabs.includes(30), true, "retiring sender closes only after the bounded Cast rejoin has failed");

  await dispatch(message("POPUP_STOP"));
});


test("global active-session lock rejects Start from another tab", async () => {
  reset({ grantedOrigins: new Set(["https://voe.sx/*"]) });

  const first = dispatch(message("POPUP_START", {
    tabId: 10,
    windowId: 20,
    fullscreen: false,
    providerPriority: ["VOE"]
  }));
  const second = dispatch(message("POPUP_START", {
    tabId: 11,
    windowId: 20,
    fullscreen: false,
    providerPriority: ["VOE"]
  }));

  const [firstResult, secondResult] = await Promise.all([first, second]);
  const success = [firstResult, secondResult].find((result) => result?.ok === true);
  const rejected = [firstResult, secondResult].find((result) => result?.ok === false);
  assert.ok(success);
  assert.equal(rejected?.error, "SESSION_ALREADY_ACTIVE");
  assert.equal(state.createdTabs.length, 1, "concurrent Start must still create only one playback surface");
  assert.equal(state.storage["qec.session"].lifecycle, "ACTIVE");

  await dispatch(message("POPUP_STOP"));
});

test("unexpected canonical playback-tab closure preserves the global session lock", async () => {
  reset({ grantedOrigins: new Set(["https://voe.sx/*"]) });

  const started = await dispatch(message("POPUP_START", {
    tabId: 10,
    windowId: 20,
    fullscreen: false,
    providerPriority: ["VOE"]
  }));
  await dispatch(message("MEDIA_PLAYING", { playerKind: "JWPlayer", state: "playing" }, started.status.sessionId, started.status.epoch), { tab: { id: 30 }, frameId: 0 });

  state.tabRemovedListener?.(30);
  await new Promise((resolve) => setTimeout(resolve, 25));

  let persisted = state.storage["qec.session"];
  assert.equal(persisted.lifecycle, "ACTIVE");
  assert.equal(persisted.state, "BLOCKED");
  assert.equal(persisted.blockedReason, "PLAYBACK_SURFACE_CLOSED");
  assert.equal(persisted.playbackTabId, null);
  assert.equal(persisted.playbackAuthority, "NONE");

  const status = await dispatch(message("POPUP_GET_STATUS"));
  assert.equal(status.status.lifecycle, "ACTIVE");
  assert.equal(status.status.state, "BLOCKED");

  const otherTabStart = await dispatch(message("POPUP_START", {
    tabId: 11,
    windowId: 20,
    fullscreen: false,
    providerPriority: ["VOE"]
  }));
  assert.equal(otherTabStart.ok, false);
  assert.equal(otherTabStart.error, "SESSION_ALREADY_ACTIVE");
  assert.equal(state.createdTabs.length, 1, "lost playback surface must not silently authorize a second session");

  const stopped = await dispatch(message("POPUP_STOP"));
  assert.equal(stopped.status.lifecycle, "ENDED");
  assert.equal(stopped.status.state, "STOPPED");
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
  assert.equal(state.injections.filter((x) => x.files?.includes("src/providers/cast-main-bridge.js") && x.world === "MAIN").length, 3);
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

test("retained JW Cast requests a trusted click on the provider-owned cast control", async () => {
  reset({ grantedOrigins: new Set(["https://voe.sx/*"]) });

  const started = await dispatch(message("POPUP_START", {
    tabId: 10,
    windowId: 20,
    fullscreen: false,
    providerPriority: ["VOE", "Doodstream"]
  }));

  const session = state.storage["qec.session"];
  session.cast = {
    available: true, connected: true, sticky: true, sessionId: "cast-123",
    deviceName: "Seb", receiverApplicationId: "CC1AD845", updatedAt: Date.now()
  };
  state.storage["qec.session"] = session;

  await dispatch(message("CAST_HANDOFF_REQUIRED", {
    playerKind: "JWPlayer",
    handoffMethod: "TRUSTED_JW_CAST_CONTROL"
  }, started.status.sessionId, started.status.epoch), { tab: { id: 30 }, frameId: 0 });

  assert.equal(state.debuggerAttaches.length, 1);
  assert.equal(state.debuggerCommands[0].method, "Runtime.evaluate");
  assert.match(state.debuggerCommands[0].params.expression, /\.jw-icon-cast/);
  assert.deepEqual(state.debuggerCommands.slice(1).map((entry) => entry.method), [
    "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent"
  ]);
  assert.equal(state.castHandoffResultMessages.length, 1);
  assert.equal(state.castHandoffResultMessages[0].message.payload.ok, true);
  assert.equal(state.castHandoffResultMessages[0].message.payload.target, ".jw-icon-cast");
  assert.match(state.storage["qec.session"].diagnostics.at(-1), /trusted JW cast control triggered/);

  await dispatch(message("POPUP_STOP"));
});

test("retained HTML5 Cast can request one trusted Google Cast session UI activation", async () => {
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

  await dispatch(message("CAST_HANDOFF_REQUIRED", {
    playerKind: "HTML5",
    handoffMethod: "TRUSTED_CAST_CONTEXT_REQUEST",
    rejoinReason: "REQUEST_SESSION_BY_ID_UNAVAILABLE"
  }, started.status.sessionId, started.status.epoch), { tab: { id: 30 }, frameId: 0 });

  assert.equal(state.debuggerAttaches.length, 1);
  assert.equal(state.debuggerCommands.length, 1);
  assert.equal(state.debuggerCommands[0].method, "Runtime.evaluate");
  assert.equal(state.debuggerCommands[0].params.userGesture, true);
  assert.match(state.debuggerCommands[0].params.expression, /__QEC_CAST_TRUSTED_REQUEST_SESSION__/);
  assert.equal(state.castHandoffResultMessages.length, 1);
  assert.equal(state.castHandoffResultMessages[0].message.payload.ok, true);
  assert.equal(state.castHandoffResultMessages[0].message.payload.handoffMethod, "TRUSTED_CAST_CONTEXT_REQUEST");
  assert.match(state.storage["qec.session"].diagnostics.at(-1), /trusted Google Cast session UI requested/);

  await dispatch(message("POPUP_STOP"));
});

test("retained HTML5 Cast can trigger the provider-owned semantic cast control", async () => {
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

  await dispatch(message("CAST_HANDOFF_REQUIRED", {
    playerKind: "HTML5",
    handoffMethod: "TRUSTED_HTML5_CAST_CONTROL",
    rejoinReason: "HTML5_CAST_SESSION_REJOINED"
  }, started.status.sessionId, started.status.epoch), { tab: { id: 30 }, frameId: 0 });

  assert.equal(state.debuggerAttaches.length, 1);
  assert.equal(state.debuggerCommands[0].method, "Runtime.evaluate");
  assert.match(state.debuggerCommands[0].params.expression, /data-qec-canonical-media/);
  assert.match(state.debuggerCommands[0].params.expression, /vjs-chromecast-button/);
  assert.deepEqual(state.debuggerCommands.slice(1).map((entry) => entry.method), [
    "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent"
  ]);
  assert.equal(state.castHandoffResultMessages.length, 1);
  assert.equal(state.castHandoffResultMessages[0].message.payload.ok, true);
  assert.equal(state.castHandoffResultMessages[0].message.payload.handoffMethod, "TRUSTED_HTML5_CAST_CONTROL");
  assert.match(state.storage["qec.session"].diagnostics.at(-1), /trusted HTML5 cast control triggered/);

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

test("popup Cast remote controls route only to the canonical Cast playback surface", async () => {
  reset({ grantedOrigins: new Set(["https://voe.sx/*"]) });

  const started = await dispatch(message("POPUP_START", {
    tabId: 10,
    windowId: 20,
    fullscreen: false,
    providerPriority: ["VOE", "Doodstream"]
  }));

  const premature = await dispatch(message("POPUP_CAST_REMOTE_CONTROL", {
    action: "TOGGLE_PLAY_PAUSE"
  }));
  assert.equal(premature.ok, false);
  assert.equal(premature.error, "CAST_REMOTE_NOT_AUTHORITATIVE");
  assert.equal(state.castRemoteControlMessages.length, 0);

  await dispatch(message("CAST_STATUS", {
    available: true,
    connected: true,
    sessionId: "cast-remote-1",
    deviceName: "Seb",
    receiverApplicationId: "CC1AD845",
    mediaPlayerState: "PLAYING",
    isMediaLoaded: true,
    remoteControlAvailable: true,
    remoteCurrentTime: 41,
    remoteDuration: 120
  }, started.status.sessionId, started.status.epoch), { tab: { id: 30 }, frameId: 0 });

  let persisted = state.storage["qec.session"];
  assert.equal(persisted.playbackAuthority, "CAST");
  assert.equal(persisted.cast.remoteControlAvailable, true);
  assert.equal(persisted.cast.remoteCurrentTime, 41);
  assert.equal(persisted.cast.remoteDuration, 120);

  const seek = await dispatch(message("POPUP_CAST_REMOTE_CONTROL", {
    action: "SEEK_RELATIVE",
    seconds: 10
  }));
  assert.equal(seek.ok, true);
  assert.equal(state.castRemoteControlMessages.length, 1);
  assert.equal(state.castRemoteControlMessages[0].tabId, 30);
  assert.equal(state.castRemoteControlMessages[0].options.frameId, 0);
  assert.equal(state.castRemoteControlMessages[0].message.payload.action, "SEEK_RELATIVE");
  assert.equal(state.castRemoteControlMessages[0].message.payload.seconds, 10);
  assert.equal(state.castRemoteControlMessages[0].message.payload.castSessionId, "cast-remote-1");

  await dispatch(message("POPUP_STOP"));
  assert.equal(state.castRemoteControlMessages.length, 2, "Stop should best-effort stop remote Cast media before closing the sender");
  assert.equal(state.castRemoteControlMessages[1].message.payload.action, "STOP");
});
