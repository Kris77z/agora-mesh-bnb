import assert from "node:assert/strict";
import test from "node:test";
import { HunterError } from "./errors.js";
import { resolveSecurityTaskInput } from "./security-input.js";

test("normalizes inline Solidity and binds a source hash", async () => {
  const result = await resolveSecurityTaskInput(
    "```solidity\npragma solidity ^0.8.20; contract Vault {}\n```",
    { chainId: 97 }
  );
  assert.equal(result.mode, "inline-source");
  assert.equal(result.sourceName, "Contract.sol");
  assert.match(result.sourceHash, /^sha256:[0-9a-f]{64}$/);
});

test("extracts Solidity from a natural-language goal before hashing it", async () => {
  const source = "pragma solidity ^0.8.20;\ncontract Vault { function ping() external {} }";
  const result = await resolveSecurityTaskInput(
    `Audit this benchmark and verify every finding. Source:\n${source}\nReturn a report.`,
    { chainId: 97 }
  );
  assert.equal(result.mode, "inline-source");
  assert.equal(result.source, source);
  assert.equal(
    result.sourceHash,
    "sha256:ef8217199a0718644c1931eec7fcccc50529decde5d1a0a83df03ac493687aca"
  );
});

test("extracts an embedded Solidity fence without including surrounding instructions", async () => {
  const result = await resolveSecurityTaskInput(
    "Please audit this:\n```solidity\ncontract Vault {}\n```\nFocus on loss of funds.",
    { chainId: 97 }
  );
  assert.equal(result.source, "contract Vault {}");
});

test("rejects a natural-language audit goal without source or address", async () => {
  await assert.rejects(
    resolveSecurityTaskInput("Please audit my BNB contract", { chainId: 97 }),
    (error: unknown) => error instanceof HunterError && error.code === "SECURITY_SOURCE_REQUIRED"
  );
});

test("resolves and combines multi-file verified source through Etherscan V2", async () => {
  let requestedUrl = "";
  const result = await resolveSecurityTaskInput(
    "Audit 0x0000000000000000000000000000000000000001",
    {
      chainId: 97,
      apiKey: "test-key",
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            status: "1",
            message: "OK",
            result: [
              {
                ContractName: "Vault",
                SourceCode: `{{"language":"Solidity","sources":{"Vault.sol":{"content":"contract Vault {}"},"Lib.sol":{"content":"library Lib {}"}},"settings":{"remappings":["lib/=vendor/lib/"]}}}`
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    }
  );
  assert.equal(result.mode, "verified-source");
  assert.equal(result.contractAddress, "0x0000000000000000000000000000000000000001");
  assert.match(result.source, /\/\/ File: Vault\.sol/);
  assert.match(result.source, /\/\/ File: Lib\.sol/);
  assert.deepEqual(Object.keys(result.sources ?? {}), ["Lib.sol", "Vault.sol"]);
  assert.deepEqual(result.remappings, ["lib/=vendor/lib/"]);
  const url = new URL(requestedUrl);
  assert.equal(url.pathname, "/v2/api");
  assert.equal(url.searchParams.get("chainid"), "97");
  assert.equal(url.searchParams.get("action"), "getsourcecode");
});

test("fails explicitly when an address cannot be resolved without an API key", async () => {
  await assert.rejects(
    resolveSecurityTaskInput("0x0000000000000000000000000000000000000001", {
      chainId: 97,
      apiKey: ""
    }),
    (error: unknown) =>
      error instanceof HunterError && error.code === "SECURITY_SOURCE_API_KEY_MISSING"
  );
});
