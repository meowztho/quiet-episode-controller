import test from "node:test";
import assert from "node:assert/strict";

const calls = [];
globalThis.chrome = {
  debugger: {
    async attach(target, version) { calls.push(["attach", structuredClone(target), version]); },
    async sendCommand(target, method, params) {
      calls.push(["command", structuredClone(target), method, structuredClone(params)]);
      if (method === "Runtime.evaluate") {
        return { result: { type: "object", value: { ok: true, paused: false } } };
      }
      return {};
    },
    async detach(target) { calls.push(["detach", structuredClone(target)]); }
  }
};

const { invokeTrustedHtml5Playback, invokeTrustedJwPlayback } = await import(`../../src/providers/gesture-activation.js?test=${Date.now()}`);

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
