import assert from "node:assert/strict";
import test from "node:test";
import { detectSolidityRules, runDeterministicVerification } from "./deterministic-verifier.js";
import { parseSlitherJson } from "./slither-runner.js";

const NO_SLITHER = {
  runSlither: () => ({
    ok: false,
    available: false,
    detections: [],
    error: "Slither unavailable in deterministic unit test"
  })
};

const SOURCE = `pragma solidity ^0.8.20;
contract VulnerableVault {
  mapping(address => uint256) public balances;
  address public owner;
  function withdraw() external {
    uint256 amount = balances[msg.sender];
    (bool ok,) = msg.sender.call{value: amount}("");
    require(ok);
    balances[msg.sender] = 0;
  }
  function proxy(address target, bytes calldata data) external {
    require(tx.origin == owner);
    target.delegatecall(data);
  }
}`;

test("deterministically confirms cited rules and reports auditor misses", () => {
  const report = runDeterministicVerification(
    JSON.stringify({
      source: SOURCE,
      sourceName: "VulnerableVault.sol",
      findings: [
        {
          findingId: "reentrancy-withdraw",
          title: "Reentrancy in withdraw",
          severity: "high",
          description: "An external call happens before the balance state update.",
          evidence: {
            file: "VulnerableVault.sol",
            lines: "L7-L9",
            snippet: "msg.sender.call{value: amount}(\"\")"
          },
          exploitScenario: "A receiver re-enters withdraw before its balance is cleared.",
          recommendation: "Move the balance update before the external call.",
          confidence: 0.95
        }
      ]
    }),
    "97:0x1111111111111111111111111111111111111111",
    NO_SLITHER
  );

  assert.equal(report.engine.method, "ast-rule");
  assert.equal(report.summary.confirmed, 1);
  assert.equal(report.summary.missed, 2);
  assert.equal(report.verifications[0]?.evidence.detector, "reentrancy-ordering");
  assert.deepEqual(
    report.verifications.filter((item) => item.status === "missed").map((item) => item.evidence.detector),
    ["tx-origin", "delegatecall"]
  );
});

test("rejects a known deterministic claim when the pattern is absent", () => {
  const report = runDeterministicVerification(
    JSON.stringify({
      source: "contract Safe { function ping() external pure returns (bool) { return true; } }",
      findings: [
        {
          findingId: "delegatecall-claim",
          title: "Unsafe delegatecall",
          severity: "high",
          description: "Arbitrary delegatecall is exposed.",
          evidence: {},
          exploitScenario: "An attacker executes arbitrary code.",
          recommendation: "Remove delegatecall.",
          confidence: 0.8
        }
      ]
    }),
    "verifier-test",
    NO_SLITHER
  );
  assert.equal(report.verifications[0]?.status, "rejected");
  assert.equal(report.verifications[0]?.method, "ast-rule");
});

test("ignores detector keywords that only appear in comments", () => {
  assert.deepEqual(
    detectSolidityRules(
      `contract Safe {\n// tx.origin and target.delegatecall(data) are forbidden\nstring constant NOTE = "selfdestruct(target)";\n}`
    ),
    []
  );
});

test("rejects malformed verifier input instead of fabricating a result", () => {
  assert.throws(() => runDeterministicVerification("{}", "verifier-test", NO_SLITHER));
});

test("uses Slither detector JSON as independent static-analysis evidence", () => {
  const slitherJson = JSON.stringify({
    success: true,
    error: null,
    results: {
      detectors: [
        {
          check: "reentrancy-eth",
          impact: "High",
          confidence: "Medium",
          description: "Vault.withdraw sends ETH before updating balances.",
          elements: [{ source_mapping: {
            lines: [7, 8],
            filename_absolute: "/tmp/agora-slither-test/src/VulnerableVault.sol",
            filename_relative: "src/VulnerableVault.sol"
          } }]
        }
      ]
    }
  });
  const parsed = parseSlitherJson(slitherJson, SOURCE);
  assert.equal(parsed[0]?.id, "reentrancy-eth");
  assert.equal(parsed[0]?.line, 7);
  assert.equal(parsed[0]?.file, "src/VulnerableVault.sol");

  const report = runDeterministicVerification(
    JSON.stringify({
      source: SOURCE,
      sourceName: "VulnerableVault.sol",
      findings: [
        {
          findingId: "reentrancy-withdraw",
          title: "Reentrancy in withdraw",
          severity: "high",
          description: "An external call happens before the state update.",
          evidence: { lines: "L7" },
          exploitScenario: "A receiver re-enters withdraw.",
          recommendation: "Update state before calling out.",
          confidence: 0.9
        }
      ]
    }),
    "verifier-test",
    {
      runSlither: () => ({
        ok: true,
        available: true,
        version: "0.11.3",
        detections: parsed
      })
    }
  );
  assert.equal(report.engine.method, "static-analysis");
  assert.equal(report.engine.name, "slither");
  assert.equal(report.verifications[0]?.method, "static-analysis");
  assert.equal(report.verifications[0]?.status, "confirmed");
  assert.equal(report.verifications[0]?.evidence.file, "src/VulnerableVault.sol");
});

test("forwards explorer remappings to compiler-backed analysis", () => {
  let receivedRemappings: string[] | undefined;
  runDeterministicVerification(
    JSON.stringify({
      source: "contract Safe {}",
      sourceName: "src/Safe.sol",
      sources: { "src/Safe.sol": "contract Safe {}" },
      remappings: ["lib/=vendor/lib/"],
      findings: []
    }),
    "verifier-test",
    {
      runSlither: (_source, _sourceName, _sources, remappings) => {
        receivedRemappings = remappings;
        return { ok: true, available: true, detections: [] };
      }
    }
  );
  assert.deepEqual(receivedRemappings, ["lib/=vendor/lib/"]);
});

test("deduplicates identical Slither detections before emitting missed findings", () => {
  const detection = {
    id: "missing-zero-check",
    title: "missing-zero-check",
    line: 3,
    lines: [3],
    snippet: "owner = nextOwner;",
    note: "Missing zero-address validation.",
    keywords: ["missing zero check"]
  };
  const report = runDeterministicVerification(
    JSON.stringify({ source: "contract Safe {}", findings: [] }),
    "verifier-test",
    {
      runSlither: () => ({
        ok: true,
        available: true,
        detections: [detection, { ...detection }]
      })
    }
  );
  assert.equal(report.summary.missed, 1);
  assert.equal(report.verifications.length, 1);
});

test("matches a finding to its primary category instead of exploit-scenario side effects", () => {
  const report = runDeterministicVerification(
    JSON.stringify({
      source: SOURCE,
      sourceName: "VulnerableVault.sol",
      findings: [
        {
          findingId: "reentrancy-eth-transfer",
          title: "Reentrancy in withdraw",
          severity: "critical",
          description: "The external call happens before the balance state update.",
          evidence: { lines: "L7-L9", snippet: "msg.sender.call{value: amount}(\"\")" },
          exploitScenario: "The owner is phished through a tx.origin call chain before re-entry.",
          recommendation: "Use checks-effects-interactions.",
          confidence: 0.95
        }
      ]
    }),
    "verifier-test",
    NO_SLITHER
  );

  assert.equal(report.verifications[0]?.status, "confirmed");
  assert.equal(report.verifications[0]?.evidence.detector, "reentrancy-ordering");
  assert.deepEqual(
    report.verifications.filter((item) => item.status === "missed").map((item) => item.evidence.detector),
    ["tx-origin", "delegatecall"]
  );
});

test("treats a detector range intersecting the cited evidence as confirmed", () => {
  const report = runDeterministicVerification(
    JSON.stringify({
      source: SOURCE,
      sourceName: "VulnerableVault.sol",
      findings: [
        {
          findingId: "tx-origin-authentication",
          title: "tx.origin authentication",
          severity: "high",
          description: "Authorization relies on tx.origin.",
          evidence: { lines: "L12", snippet: "require(tx.origin == owner)" },
          exploitScenario: "A phishing contract preserves the transaction origin.",
          recommendation: "Use msg.sender.",
          confidence: 0.9
        }
      ]
    }),
    "verifier-test",
    {
      runSlither: () => ({
        ok: true,
        available: true,
        version: "0.11.6",
        detections: [
          {
            id: "tx-origin",
            title: "tx-origin",
            line: 11,
            lines: [11, 12, 13],
            snippet: "require(tx.origin == owner)",
            note: "tx.origin is used for authorization.",
            keywords: ["tx.origin", "tx origin", "authorization", "authentication"]
          }
        ]
      })
    }
  );

  assert.equal(report.verifications[0]?.status, "confirmed");
});

test("partially confirms lifecycle and cross-role structures without claiming exploitability", () => {
  const source = `contract StablecoinV2 {
  address public autoOwner;
  uint256 public autoMintMaxLimit;
  function owner() public view returns (address) { return address(this); }
  function initializeV2() public reinitializer(2) { }
  function autoMint(address to, uint256 amount) external onlyAutoOwner {
    require(autoMintMaxLimit >= amount);
    _mint(to, amount);
  }
  function autoBurn(uint256 amount) external onlyAutoOwner {
    address owner = owner();
    _burn(owner, amount);
  }
}`;
  const finding = (findingId: string, title: string, lines: string) => ({
    findingId,
    title,
    severity: "medium",
    description: title,
    evidence: { file: "src/StablecoinV2.sol", lines },
    exploitScenario: "The structural precondition combines with unsafe deployment or role policy.",
    recommendation: "Review lifecycle and role policy.",
    confidence: 0.8
  });
  const report = runDeterministicVerification(
    JSON.stringify({
      source,
      sourceName: "src/StablecoinV2.sol",
      sources: { "src/StablecoinV2.sol": source },
      findings: [
        finding("v2-initializer-unprotected", "V2 initializer can be called by anyone", "L5"),
        finding("unbounded-auto-mint-limit-bypass", "Auto-mint max limit allows unbounded total minting", "L6-L9"),
        finding("auto-burns-owner-balance", "autoBurn destroys owner's balance without allowance", "L10-L13")
      ]
    }),
    "verifier-test",
    {
      runSlither: () => ({ ok: true, available: true, version: "0.11.6", detections: [] })
    }
  );
  assert.equal(report.summary.partial, 3);
  assert.equal(report.summary.inconclusive, 0);
  assert.deepEqual(
    report.verifications.map((verification) => verification.evidence.detector),
    ["unprotected-initializer", "per-call-mint-limit", "cross-role-owner-burn"]
  );
  assert.ok(report.verifications.every(
    (verification) => verification.evidence.tool === "agora-solidity-rules@2"
  ));
});

test("binds a structural confirmation to the finding's cited source unit", () => {
  const v1 = `contract Stablecoin {
  function initialize() public initializer { }
}`;
  const v2 = `contract StablecoinV2 {
  function initializeV2() public reinitializer(2) { }
}`;
  const report = runDeterministicVerification(
    JSON.stringify({
      source: `${v1}\n${v2}`,
      sourceName: "src/StablecoinV2.sol",
      sources: {
        "src/Stablecoin.sol": v1,
        "src/StablecoinV2.sol": v2
      },
      findings: [{
        findingId: "v2-initializer-unprotected",
        title: "V2 initializer can be called by anyone",
        severity: "medium",
        description: "The V2 reinitializer lacks explicit authorization.",
        evidence: { file: "src/StablecoinV2.sol", lines: "L2" },
        exploitScenario: "An unsafe upgrade could expose the reinitializer.",
        recommendation: "Initialize atomically.",
        confidence: 0.8
      }]
    }),
    "verifier-test",
    {
      runSlither: () => ({ ok: true, available: true, version: "0.11.6", detections: [] })
    }
  );
  const findingVerification = report.verifications.find(
    (verification) => verification.findingId === "v2-initializer-unprotected"
  );
  assert.equal(findingVerification?.status, "partial");
  assert.equal(findingVerification?.evidence.file, "src/StablecoinV2.sol");
  assert.equal(findingVerification?.evidence.lines, "L2");
});
