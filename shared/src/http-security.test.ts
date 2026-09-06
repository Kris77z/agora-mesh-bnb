import assert from "node:assert/strict";
import test from "node:test";
import {
  apiTokenMatches,
  FixedWindowRateLimiter,
  isAllowedCorsOrigin,
  normalizeRequestId,
  parseOriginAllowlist,
  validateServiceEndpointUrl
} from "./http-security.js";

test("CORS allowlist and request ids fail closed", () => {
  const origins = parseOriginAllowlist("https://demo.example, https://judge.example", []);
  assert.equal(isAllowedCorsOrigin("https://demo.example", origins), true);
  assert.equal(isAllowedCorsOrigin("https://evil.example", origins), false);
  assert.equal(normalizeRequestId("mission:123"), "mission:123");
  assert.match(normalizeRequestId("bad request id"), /^[0-9a-f-]{36}$/);
});

test("API tokens use exact constant-time hash comparison", () => {
  assert.equal(apiTokenMatches("secret", "secret"), true);
  assert.equal(apiTokenMatches("secret", "secret2"), false);
  assert.equal(apiTokenMatches(undefined, "secret"), false);
});

test("fixed-window limiter rejects overflow and resets", () => {
  const limiter = new FixedWindowRateLimiter(2, 1_000);
  assert.equal(limiter.consume("client", 100).allowed, true);
  assert.equal(limiter.consume("client", 200).allowed, true);
  assert.equal(limiter.consume("client", 300).allowed, false);
  assert.equal(limiter.consume("client", 1_100).allowed, true);
});

test("service endpoints reject private networks and insecure public HTTP", () => {
  assert.throws(
    () => validateServiceEndpointUrl("http://169.254.169.254", { allowLocal: false }),
    /not allowed/
  );
  assert.throws(
    () => validateServiceEndpointUrl("http://example.com", { allowLocal: false }),
    /HTTPS/
  );
  assert.equal(
    validateServiceEndpointUrl("http://localhost:3001", { allowLocal: true }).port,
    "3001"
  );
  assert.equal(
    validateServiceEndpointUrl("https://service.example", { allowLocal: false }).hostname,
    "service.example"
  );
});
