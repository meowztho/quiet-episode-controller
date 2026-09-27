import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalProviderName,
  chooseProvider,
  DEFAULT_PROVIDER_PRIORITY,
  SUPPORTED_PROVIDERS
} from "../../src/providers/registry.js";

test("current provider names normalize without leaking hostnames into the core", () => {
  assert.equal(canonicalProviderName("VOE Video"), "VOE");
  assert.equal(canonicalProviderName("Doodstream"), "Doodstream");
});

test("current provider priority is VOE then Doodstream", () => {
  assert.deepEqual(SUPPORTED_PROVIDERS, ["VOE", "Doodstream"]);
  assert.deepEqual(DEFAULT_PROVIDER_PRIORITY, ["VOE", "Doodstream"]);
  const candidates = [
    { provider: "Doodstream", available: true, key: "d" },
    { provider: "FileMoon", available: true, key: "f" },
    { provider: "VOE", available: true, key: "v" }
  ];
  assert.equal(chooseProvider(candidates, ["VOE", "Doodstream"]).key, "v");
  assert.equal(chooseProvider(candidates, ["Doodstream", "VOE"]).key, "d");
});

test("deferred or unknown providers cannot become an implicit fallback", () => {
  assert.equal(chooseProvider([{ provider: "FileMoon", available: true, key: "f" }]), null);
  assert.equal(chooseProvider([{ provider: "UnknownHost", available: true, key: "x" }]), null);
});

test("explicit provider priority is strict and exclusions support runtime failover", () => {
  const candidates = [
    { provider: "VOE", available: true, key: "v" },
    { provider: "Doodstream", available: true, key: "d" }
  ];

  assert.equal(chooseProvider(candidates, ["VOE"]).key, "v");
  assert.equal(chooseProvider(candidates, ["VOE"], { excludeProviders: ["VOE"] }), null);
  assert.equal(
    chooseProvider(candidates, DEFAULT_PROVIDER_PRIORITY, { excludeProviders: ["VOE"] }).key,
    "d"
  );
});
