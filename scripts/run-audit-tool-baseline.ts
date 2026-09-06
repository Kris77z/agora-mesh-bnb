import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadAuditGroundTruth,
  scoreAuditAgainstGroundTruth
} from "../agents/hunter/src/advantage-evaluator.js";
import { runSlitherAnalysis } from "../agents/writer/src/verification/slither-runner.js";

function sha256Source(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

async function main(): Promise<void> {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const experimentDirectory = path.join(
    repositoryRoot,
    "evidence/experiment-1-contract-audit"
  );
  const sourcePath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(experimentDirectory, "VulnerableVault.sol");
  const manifestPath = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.join(experimentDirectory, "ground-truth.json");
  const source = (await readFile(sourcePath, "utf8")).trim();
  const sourceHash = sha256Source(source);
  const startedAt = new Date();
  const started = process.hrtime.bigint();

  // Ground truth is deliberately loaded only after the tool has completed.
  const analysis = runSlitherAnalysis(source, path.basename(sourcePath));
  const completedAt = new Date();
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  if (!analysis.ok) {
    throw new Error(analysis.error ?? "Slither baseline failed");
  }

  const groundTruth = await loadAuditGroundTruth(manifestPath);
  if (!groundTruth) throw new Error("Ground-truth manifest is missing");
  const result = JSON.stringify({
    vulnerabilities: analysis.detections.map((detection) => ({
      findingId: detection.id,
      evidence: {
        file: path.basename(sourcePath),
        lines: (detection.lines ?? [detection.line]).join(","),
        snippet: detection.snippet
      }
    }))
  });
  const quality = scoreAuditAgainstGroundTruth({ result, sourceHash, groundTruth });
  if (!quality) {
    throw new Error("Tool baseline source is not bound to the reviewed ground truth");
  }

  process.stdout.write(`${JSON.stringify({
    version: 1,
    experimentId: "contract-audit",
    baselineKind: "tool-only-static-analysis",
    controlledHumanBaselineStatus: "pending",
    input: {
      sourceFile: path.relative(repositoryRoot, sourcePath),
      sourceHash,
      benchmarkId: groundTruth.benchmarkId
    },
    runtime: {
      tool: "Slither",
      version: analysis.version ?? "unknown",
      command: "slither <source> --json - --disable-color --solc-disable-warnings --exclude-informational --exclude-optimization"
    },
    timing: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Number(durationMs.toFixed(3))
    },
    cost: {
      currency: "USD",
      amount: 0,
      basis: "Local open-source tool execution; hardware cost not allocated."
    },
    output: analysis,
    quality,
    limitations: [
      "This is a reproducible tool-only reference, not the plan's controlled human plus ordinary-LLM baseline.",
      "No manual triage or LLM interpretation was performed.",
      "Ground truth was loaded only after Slither completed, then used for deterministic scoring."
    ]
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Audit tool baseline failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
