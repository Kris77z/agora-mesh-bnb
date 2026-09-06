import assert from "node:assert/strict";
import test from "node:test";
import { writerConfig } from "./config.js";
import { getWriterAgentId, getWriterIdentity, getWriterServicesInfo } from "./identity.js";

test("uses one canonical agent id for identity, service advertisements, and verifier reports", () => {
  const expected =
    writerConfig.identity.agentId ??
    `${writerConfig.chainId}:${writerConfig.writerAddress.toLowerCase()}`;

  assert.equal(getWriterAgentId(), expected);
  assert.equal(getWriterIdentity().agentId, expected);
  for (const service of getWriterServicesInfo()) {
    assert.equal(service.agentId, expected);
  }
});
