import { timingSafeEqual } from "node:crypto";

export const isPairingTokenConfigured = (token) =>
  typeof token === "string" && token.length >= 32;

export const hasValidPairingToken = (supplied, expected) => {
  if (!isPairingTokenConfigured(expected) || typeof supplied !== "string") {
    return false;
  }
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer);
};
