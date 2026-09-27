import test from "node:test";
import assert from "node:assert/strict";
import { permissionPatternForOrigin } from "../../src/permissions/permission-broker.js";

test("permission pattern requests only the provider host and strips ports", () => {
  assert.equal(permissionPatternForOrigin("https://voe.sx"), "https://voe.sx/*");
  assert.equal(permissionPatternForOrigin("http://127.0.0.1:8766"), "http://127.0.0.1/*");
});

test("non-http provider origins are rejected", () => {
  assert.throws(() => permissionPatternForOrigin("file:///tmp/test"), /http\(s\)/);
});
