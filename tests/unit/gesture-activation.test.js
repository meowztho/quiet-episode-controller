import test from "node:test";
import assert from "node:assert/strict";

const calls = [];
globalThis.chrome = {
  debugger: {
    async attach(target, version) { calls.push(["attach", structuredClone(target), version]); },
    async sendCommand(target, method, params) {
      calls.push(["command", structuredClone(target), method, structuredClone(params)]);
      if (method === "Runtime.evaluate") {
        if (params?.expression?.includes(".jw-icon-cast")) {
          return { result: { type: "object", value: { ok: true, x: 321, y: 45, selector: ".jw-icon-cast", ariaLabel: "Cast" } } };
        }
        if (params?.expression?.includes(".vjs-chromecast-button")) {
          return { result: { type: "object", value: { ok: true, x: 280, y: 42, selector: ".vjs-chromecast-button", ariaLabel: "Cast", title: null } } };
        }
        return { result: { type: "object", value: { ok: true, paused: false } } };
      }
      return {};
    },
    async detach(target) { calls.push(["detach", structuredClone(target)]); }
  }
};

const {
  invokeTrustedCastSessionRequest,
  invokeTrustedHtml5Cast,
  invokeTrustedHtml5Playback,
  invokeTrustedJwCast,
  invokeTrustedJwPlayback
} = await import(`../../src/providers/gesture-activation.js?test=${Date.now()}`);

test("trusted JW activation dispatches only Space to the playback target and always detaches", async () => {
  calls.length = 0;
  const result = await invokeTrustedJwPlayback(42);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls[0], ["attach", { tabId: 42 }, "1.3"]);

  assert.equal(calls[1][0], "command");
  assert.deepEqual(calls[1][1], { tabId: 42 });
  assert.equal(calls[1][2], "Input.dispatchKeyEvent");
  assert.deepEqual(calls[1][3], {
    type: "rawKeyDown",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
    nativeVirtualKeyCode: 32
  });

  assert.equal(calls[2][0], "command");
  assert.deepEqual(calls[2][1], { tabId: 42 });
  assert.equal(calls[2][2], "Input.dispatchKeyEvent");
  assert.deepEqual(calls[2][3], {
    type: "keyUp",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
    nativeVirtualKeyCode: 32
  });

  assert.deepEqual(calls[3], ["detach", { tabId: 42 }]);
});

test("trusted HTML5 activation plays only the Provider Agent-marked canonical media with userGesture", async () => {
  calls.length = 0;
  const result = await invokeTrustedHtml5Playback(77);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls[0], ["attach", { tabId: 77 }, "1.3"]);
  assert.equal(calls[1][0], "command");
  assert.deepEqual(calls[1][1], { tabId: 77 });
  assert.equal(calls[1][2], "Runtime.evaluate");
  assert.equal(calls[1][3].userGesture, true);
  assert.equal(calls[1][3].awaitPromise, true);
  assert.equal(calls[1][3].returnByValue, true);
  assert.match(calls[1][3].expression, /data-qec-canonical-media/);
  assert.match(calls[1][3].expression, /\.play\(\)/);
  assert.deepEqual(calls[2], ["detach", { tabId: 77 }]);
});

test("trusted retained Cast activation invokes only the Cast bridge session request with userGesture", async () => {
  calls.length = 0;
  const result = await invokeTrustedCastSessionRequest(79);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls[0], ["attach", { tabId: 79 }, "1.3"]);
  assert.equal(calls[1][2], "Runtime.evaluate");
  assert.equal(calls[1][3].userGesture, true);
  assert.equal(calls[1][3].returnByValue, true);
  assert.match(calls[1][3].expression, /__QEC_CAST_TRUSTED_REQUEST_SESSION__/);
  assert.doesNotMatch(calls[1][3].expression, /cast\.framework|chrome\.cast/);
  assert.deepEqual(calls[2], ["detach", { tabId: 79 }]);
});

test("trusted HTML5 Cast handoff clicks only a semantic cast control inside the canonical player surface", async () => {
  calls.length = 0;
  const result = await invokeTrustedHtml5Cast(81);
  assert.deepEqual(result, { ok: true, target: ".vjs-chromecast-button", ariaLabel: "Cast", title: null });
  assert.deepEqual(calls[0], ["attach", { tabId: 81 }, "1.3"]);
  assert.equal(calls[1][2], "Runtime.evaluate");
  assert.match(calls[1][3].expression, /data-qec-canonical-media/);
  assert.match(calls[1][3].expression, /vjs-chromecast-button/);
  assert.equal(calls[1][3].returnByValue, true);
  assert.deepEqual(calls.slice(2, 5).map((call) => call[2]), [
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent"
  ]);
  assert.equal(calls[3][3].type, "mousePressed");
  assert.equal(calls[4][3].type, "mouseReleased");
  assert.deepEqual(calls[5], ["detach", { tabId: 81 }]);
});


test("trusted JW Cast handoff clicks only the native JW cast control inside the playback tab", async () => {
  calls.length = 0;
  const result = await invokeTrustedJwCast(88);
  assert.deepEqual(result, { ok: true, target: ".jw-icon-cast", ariaLabel: "Cast" });
  assert.deepEqual(calls[0], ["attach", { tabId: 88 }, "1.3"]);
  assert.equal(calls[1][2], "Runtime.evaluate");
  assert.match(calls[1][3].expression, /\.jw-icon-cast/);
  assert.equal(calls[1][3].returnByValue, true);
  assert.deepEqual(calls.slice(2, 5).map((call) => call[2]), [
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent",
    "Input.dispatchMouseEvent"
  ]);
  assert.equal(calls[3][3].type, "mousePressed");
  assert.equal(calls[3][3].button, "left");
  assert.equal(calls[4][3].type, "mouseReleased");
  assert.equal(calls[4][3].button, "left");
  assert.deepEqual(calls[5], ["detach", { tabId: 88 }]);
});
