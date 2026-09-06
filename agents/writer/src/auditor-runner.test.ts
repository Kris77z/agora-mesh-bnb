import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { buildFirstPartyAuditTask, normalizeAuditorOutput } from "./auditor-runner.js";

test("normalizes fenced Auditor JSON without loading payment or identity modules", () => {
  const normalized = normalizeAuditorOutput(`\`\`\`json
{"vulnerabilities":[]}
\`\`\``);
  assert.deepEqual(JSON.parse(normalized), { vulnerabilities: [] });
});

test("rejects malformed Auditor output", () => {
  assert.throws(() => normalizeAuditorOutput("not-json"), /valid JSON/);
  assert.throws(
    () => normalizeAuditorOutput('{"vulnerabilities":[{"title":"missing fields"}]}'),
    /does not match/
  );
});

test("builds a hash-bound first-party audit scope without duplicating dependencies", () => {
  const fullSource = "full explorer package";
  const packageSourceHash = `sha256:${createHash("sha256").update(fullSource).digest("hex")}`;
  const result = buildFirstPartyAuditTask({
    chainId: 97,
    mode: "verified-source",
    sourceName: "src/StablecoinV2.sol",
    source: fullSource,
    sourceHash: packageSourceHash,
    contractAddress: "0x1111111111111111111111111111111111111111",
    sources: {
      "src/StablecoinV2.sol": "contract StablecoinV2 {}",
      "src/Stablecoin.sol": "contract Stablecoin {}",
      "lib/openzeppelin/Ownable.sol": "contract Ownable {}"
    }
  });
  const parsed = JSON.parse(result.taskInput) as {
    source: string;
    sourceHash: string;
    packageSourceHash: string;
    sources: Record<string, string>;
  };
  assert.equal(parsed.packageSourceHash, packageSourceHash);
  assert.equal(parsed.sourceHash, result.scope.scopeSourceHash);
  assert.deepEqual(Object.keys(parsed.sources).sort(), ["src/Stablecoin.sol", "src/StablecoinV2.sol"]);
  assert.doesNotMatch(parsed.source, /Ownable/);
  assert.deepEqual(result.scope.omittedDependencySourceUnits, ["lib/openzeppelin/Ownable.sol"]);
});
