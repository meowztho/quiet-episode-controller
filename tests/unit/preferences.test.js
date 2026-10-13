import test from "node:test";
import assert from "node:assert/strict";
import { readFullscreenPreference, writeFullscreenPreference } from "../../src/ui/preferences.js";

function storage() {
  const data = new Map();
  return {
    async get(key) { return { [key]: data.get(key) }; },
    async set(entries) {
      for (const [key, value] of Object.entries(entries)) data.set(key, structuredClone(value));
    }
  };
}

test("fullscreen preference defaults to on, then preserves both user choices across popups", async () => {
  const local = storage();
  assert.equal(await readFullscreenPreference(local), true);
  await writeFullscreenPreference(local, false);
  assert.equal(await readFullscreenPreference(local), false);
  await writeFullscreenPreference(local, true);
  assert.equal(await readFullscreenPreference(local), true);
});

test("invalid stored fullscreen value uses the default", async () => {
  const local = storage();
  await local.set({ "qec.preferences": { fullscreen: "false" } });
  assert.equal(await readFullscreenPreference(local), true);
});
