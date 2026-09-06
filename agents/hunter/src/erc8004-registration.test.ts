import assert from "node:assert/strict";
import test from "node:test";
import { buildErc8004RegistrationFile, ERC8004_REGISTRATION_TYPE } from "./erc8004-registration.js";

test("builds the normative ERC-8004 registration shape and only claims a recorded registration", () => {
  const identity = {
    agentId: "local", name: "Hunter", description: "Test", walletAddress: "0x1111111111111111111111111111111111111111",
    capabilities: [{ type: "a2a" as const, endpoint: "https://agent.example/run" }, { type: "mcp" as const, endpoint: "https://agent.example/mcp" }],
    trustModels: ["reputation"], active: true, registeredAt: 1
  };
  assert.deepEqual(buildErc8004RegistrationFile({ identity, chainId: 97, x402Support: true }).registrations, []);
  const file = buildErc8004RegistrationFile({
    identity, chainId: 97, x402Support: true,
    registryAddress: "0x8004A818BFB912233c491871b3d84c89A494BD9e", onchainAgentId: "42"
  });
  assert.equal(file.type, ERC8004_REGISTRATION_TYPE);
  assert.equal(file.registrations[0]?.agentRegistry, "eip155:97:0x8004A818BFB912233c491871b3d84c89A494BD9e");
  assert.deepEqual(file.services.map((service) => service.name), ["A2A", "MCP"]);
});
