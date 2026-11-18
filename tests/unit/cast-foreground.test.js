import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const CAST_BRIDGE = readFileSync(new URL("../../src/providers/cast-main-bridge.js", import.meta.url), "utf8");
const FRAME_AGENT = readFileSync(new URL("../../src/providers/frame-agent.js", import.meta.url), "utf8");
const CAST_CHANNEL = "__QEC_CAST_BRIDGE_V1__";
const JW_CHANNEL = "__QEC_JW_BRIDGE_V1__";

// A deterministic clock so hidden-page timer clamping never enters the test:
// only the code under test decides when a deadline is reached.
function createClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(handler, delay) {
      const id = ++sequence;
      timers.set(id, { handler, at: now + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      for (let guard = 0; guard < 10000; guard += 1) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = Math.max(now, timer.at);
        timer.handler();
      }
      now = target;
    }
  };
}

// ---------------------------------------------------------------------------
// Cast MAIN-world bridge: legacy chrome.cast.media.Media observation
// ---------------------------------------------------------------------------

function createLegacyMedia({ playerState = "PLAYING", currentTime = 99.2, duration = 100, mediaSessionId = 41 } = {}) {
  return {
    playerState,
    currentTime,
    mediaSessionId,
    idleReason: null,
    media: { duration },
    listeners: [],
    removed: [],
    getEstimatedTime() { return this.currentTime; },
    addUpdateListener(handler) { this.listeners.push(handler); },
    removeUpdateListener(handler) {
      const index = this.listeners.indexOf(handler);
      if (index >= 0) this.listeners.splice(index, 1);
      this.removed.push(handler);
    },
    push() {
      for (const handler of [...this.listeners]) handler(true);
    }
  };
}

// Mirrors the live VOE/JW sender: the Framework CastContext and the legacy
// chrome.cast namespace exist, but there is no RemotePlayer/RemotePlayerController.
function createCastBridgeEnvironment(media) {
  const state = { media };
  const messages = [];
  const listeners = new Map();
  const intervals = [];

  const session = {
    getSessionId: () => "cast-123",
    getCastDevice: () => ({ friendlyName: "Fixture TV" }),
    getApplicationMetadata: () => ({ applicationId: "CC1AD845" }),
    getSessionState: () => "SESSION_STARTED",
    getMediaSession: () => state.media,
    getSessionObj: () => null
  };
  const context = {
    getCurrentSession: () => session,
    getCastState: () => "CONNECTED",
    setOptions() {},
    addEventListener() {},
    removeEventListener() {}
  };
  const window = {
    postMessage(data) { messages.push(data); },
    addEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    }
  };
  const sandbox = {
    window,
    console,
    Date,
    queueMicrotask,
    setInterval(handler, delay) {
      const id = { handler, delay, cleared: false };
      intervals.push(id);
      return id;
    },
    clearInterval(id) { if (id) id.cleared = true; },
    cast: {
      framework: {
        CastContext: { getInstance: () => context },
        CastContextEventType: {}
      }
    },
    chrome: {
      cast: { AutoJoinPolicy: { ORIGIN_SCOPED: "ORIGIN_SCOPED" } }
    }
  };
  createContext(sandbox);
  runInContext(CAST_BRIDGE, sandbox);

  const probe = () => {
    for (const handler of listeners.get("message") ?? []) {
      handler({
        source: window,
        data: { channel: CAST_CHANNEL, direction: "isolated-to-main", command: "PROBE", payload: {} }
      });
    }
  };

  return { state, messages, listeners, intervals, window, probe };
}

test("legacy media push updates detect a near-end unload without a poll tick", () => {
  const media = createLegacyMedia();
  const env = createCastBridgeEnvironment(media);

  // The initial inspect observes PLAYING at 99.2/100 and binds the push listener.
  assert.equal(media.listeners.length, 1);
  assert.equal(env.messages.some((message) => message.event === "REMOTE_PLAYING"), true);
  assert.equal(
    env.messages.some((message) => message.event === "MEDIA_PUSH_BOUND" && message.payload.traceEvent === "CAST_MEDIA_PUSH_BOUND"),
    true
  );
  // The 1 s poll remains as the documented compatibility fallback.
  assert.equal(env.intervals.length, 1);

  // The receiver unloads the finished item. Only the media's own push callback
  // runs; no interval tick is simulated.
  env.state.media = null;
  media.playerState = "IDLE";
  media.push();

  const ended = env.messages.filter((message) => message.event === "REMOTE_ENDED");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].payload.endDetection, "MEDIA_UNLOADED_NEAR_END");
  // The replaced identity is unbound instead of leaking the listener.
  assert.equal(media.listeners.length, 0);
});

test("legacy media without an update API keeps the poll and reports the limitation once", () => {
  const media = {
    playerState: "PLAYING",
    currentTime: 10,
    mediaSessionId: 42,
    media: { duration: 100 },
    getEstimatedTime() { return this.currentTime; }
  };
  const env = createCastBridgeEnvironment(media);

  const diagnostics = () => env.messages.filter((message) => message.event === "MEDIA_PUSH_UNAVAILABLE");
  assert.equal(diagnostics().length, 1);
  assert.equal(diagnostics()[0].payload.traceEvent, "CAST_MEDIA_PUSH_UNAVAILABLE");
  assert.equal(env.intervals.length, 1);

  env.probe();
  env.probe();
  assert.equal(diagnostics().length, 1);
});

test("a replaced legacy media identity rebinds the push listener", () => {
  const first = createLegacyMedia({ mediaSessionId: 41 });
  const env = createCastBridgeEnvironment(first);
  assert.equal(first.listeners.length, 1);

  const second = createLegacyMedia({ mediaSessionId: 77, currentTime: 1 });
  env.state.media = second;
  env.probe();

  assert.equal(first.listeners.length, 0);
  assert.equal(second.listeners.length, 1);
  assert.equal(
    env.messages.some((message) => message.event === "REMOTE_PLAYING" && message.payload.mediaSessionId === 77),
    true
  );
});

test("pagehide unbinds the legacy media listener and clears the poll", () => {
  const media = createLegacyMedia();
  const env = createCastBridgeEnvironment(media);
  assert.equal(media.listeners.length, 1);
  const pagehide = env.listeners.get("pagehide") ?? [];
  assert.equal(pagehide.length, 1);

  for (const handler of pagehide) handler({});

  assert.equal(media.listeners.length, 0);
  assert.equal(env.intervals[0].cleared, true);
});

// ---------------------------------------------------------------------------
// Provider Frame Agent: D-028 relay bounds and JW export re-offer
// ---------------------------------------------------------------------------

function createFrameAgentEnvironment() {
  const clock = createClock();
  const messages = [];
  const posted = [];
  const windowListeners = new Map();
  let runtimeListener = null;

  const style = () => ({ setProperty() {} });
  const container = {
    isConnected: true,
    parentElement: null,
    style: style(),
    dataset: {},
    remove() {},
    addEventListener() {},
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
    querySelectorAll: () => []
  };
  const document = {
    documentElement: { style: style(), clientHeight: 720 },
    body: { style: style() },
    querySelectorAll(selector) { return selector === ".jwplayer" ? [container] : []; },
    createElement() { return { style: style(), dataset: {}, append() {}, addEventListener() {}, remove() {} }; }
  };
  const window = {
    innerHeight: 720,
    addEventListener(type, handler) {
      const list = windowListeners.get(type) ?? [];
      list.push(handler);
      windowListeners.set(type, list);
    },
    postMessage(data) { posted.push(data); }
  };
  const chrome = {
    runtime: {
      sendMessage(message) {
        messages.push(message);
        return Promise.resolve({ ok: true });
      },
      onMessage: { addListener(handler) { runtimeListener = handler; } }
    }
  };
  const sandbox = {
    window,
    document,
    location: { href: "https://provider.example.invalid/episode" },
    chrome,
    console,
    Date: { now: () => clock.now() },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  };
  createContext(sandbox);
  runInContext(FRAME_AGENT, sandbox);

  return {
    clock,
    messages,
    posted,
    window,
    sendRuntime(message) {
      return runtimeListener(message, {}, () => {});
    },
    sendWindow(data) {
      for (const handler of windowListeners.get("message") ?? []) handler({ source: window, data });
    }
  };
}

const relayAttach = (env) => env.sendRuntime({
  version: 1,
  sessionId: "relay-session",
  epoch: 2,
  type: "PROVIDER_ATTACH",
  payload: {
    provider: "VOE",
    castSessionId: "cast-123",
    castReceiverApplicationId: "CC1AD845",
    castRelayMode: true
  }
});

const exportCommands = (env) => env.posted.filter(
  (message) => message.channel === JW_CHANNEL && message.direction === "isolated-to-main" && message.command === "EXPORT_CAST_ITEM"
);

const castStatuses = (env) => env.messages.filter((message) => message.type === "CAST_STATUS");

test("relay mode does not arm the 6 s local fallback that closes the retained sender", () => {
  const env = createFrameAgentEnvironment();
  relayAttach(env);
  assert.equal(exportCommands(env).length, 1);

  env.clock.advance(6000);

  assert.equal(
    castStatuses(env).some((message) => message.payload.stickyResumeFailed),
    false,
    "the local fallback must not close the sender while the relay is in flight"
  );
});

test("a delivered relay is not abandoned and terminates on its own bounded deadline", () => {
  const env = createFrameAgentEnvironment();
  relayAttach(env);
  env.sendWindow({
    channel: JW_CHANNEL,
    direction: "main-to-isolated",
    event: "CAST_ITEM_EXPORT",
    payload: { item: { opaque: "fixture-item" } }
  });
  assert.equal(env.messages.filter((message) => message.type === "CAST_RELAY_ITEM").length, 1);

  // A re-offer can race the first export answer; the item must cross once.
  env.sendWindow({
    channel: JW_CHANNEL,
    direction: "main-to-isolated",
    event: "CAST_ITEM_EXPORT",
    payload: { item: { opaque: "fixture-item" } }
  });
  assert.equal(env.messages.filter((message) => message.type === "CAST_RELAY_ITEM").length, 1);

  env.clock.advance(6000);
  assert.equal(
    castStatuses(env).some((message) => message.payload.stickyResumeFailed),
    false,
    "a delivered relay must survive the local 6 s fallback"
  );

  env.clock.advance(30000);
  const failed = castStatuses(env).find((message) => message.payload.stickyResumeFailed);
  assert.ok(failed, "the relay deadline must still terminate a silent relay");
  assert.equal(failed.payload.stickyResumeReason, "CAST_RELAY_TIMEOUT");
});

test("an export that never reaches the sender terminates through the bounded path", () => {
  const env = createFrameAgentEnvironment();
  relayAttach(env);

  env.clock.advance(60000);

  assert.equal(env.messages.some((message) => message.type === "CAST_RELAY_ITEM"), false);
  const failed = castStatuses(env).find((message) => message.payload.stickyResumeFailed);
  assert.ok(failed, "a relay that never delivered must still terminate");
  assert.equal(failed.payload.stickyResumeReason, "CAST_RELAY_EXPORT_TIMEOUT");
});

test("a silent JW bridge UNAVAILABLE does not latch the export", () => {
  const env = createFrameAgentEnvironment();
  relayAttach(env);
  assert.equal(exportCommands(env).length, 1);

  env.sendWindow({
    channel: JW_CHANNEL,
    direction: "main-to-isolated",
    event: "UNAVAILABLE",
    payload: { playerKind: "JWPlayer" }
  });
  env.sendWindow({
    channel: JW_CHANNEL,
    direction: "main-to-isolated",
    event: "READY",
    payload: { state: "idle", currentTime: 0, duration: 100 }
  });

  assert.equal(exportCommands(env).length, 2, "READY after UNAVAILABLE must re-offer the export");
});
