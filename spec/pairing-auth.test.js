import test from "node:test";
import assert from "node:assert/strict";
import {
  hasValidPairingToken,
  isPairingTokenConfigured,
} from "../System/PairingAuth.js";

test("requires a configured token with at least 32 characters", () => {
  assert.equal(isPairingTokenConfigured("short"), false);
  assert.equal(isPairingTokenConfigured("a".repeat(32)), true);
});

test("accepts only an exact token match", () => {
  const expected = "a".repeat(32);
  assert.equal(hasValidPairingToken(expected, expected), true);
  assert.equal(hasValidPairingToken(`${expected}x`, expected), false);
  assert.equal(hasValidPairingToken("b".repeat(32), expected), false);
  assert.equal(hasValidPairingToken(expected, ""), false);
});
