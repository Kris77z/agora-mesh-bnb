import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProductionTokenRiskVerification } from "../agents/writer/src/investigation/token-risk-verifier.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const experimentDirectory = path.join(repositoryRoot, "evidence/experiment-2-token-risk");
const sourcePath = path.join(experimentDirectory, "paid-run-output.json");
const outputPath = path.join(experimentDirectory, "security-review-output.json");
const candidatePath = path.join(experimentDirectory, "ground-truth-candidate.json");

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function main(): Promise<void> {
  const source = JSON.parse(await readFile(sourcePath, "utf8")) as {
  mission?: { missionId?: unknown };
  report?: unknown;
  };
  if (!source.report || typeof source.report !== "object") {
    throw new Error("paid-run-output.json does not contain a report object");
  }
  const startedAt = new Date();
  const started = performance.now();
  const review = await runProductionTokenRiskVerification(
    JSON.stringify({ report: source.report })
  );
  const completedAt = new Date();
  const evidence = {
  version: 1,
  experimentId: "token-risk",
  reviewKind: "independent-security-agent-rpc-replay",
  settlement: {
    status: "not-paid",
    reason: "Local post-run validation; no new Authority or onchain payment was authorized."
  },
  source: {
    missionId: typeof source.mission?.missionId === "string" ? source.mission.missionId : "unknown",
    evidenceFile: "paid-run-output.json",
    reportHash: review.sourceReportHash,
    blockNumber: review.blockNumber
  },
  timing: {
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Number((performance.now() - started).toFixed(3))
  },
  reviewer: {
    serviceId: "risk-verifier-v1",
    engine: review.engine
  },
  review
  };
  const candidate = {
  version: 1,
  experimentId: "token-risk",
  benchmarkId: `bnb-testnet-u-block-${review.blockNumber}`,
  reviewStatus: "candidate",
  sourceReportHash: review.sourceReportHash,
  target: review.target,
  chainId: review.chainId,
  blockNumber: review.blockNumber,
  candidateMethod: [
    "source Investigator RPC snapshot",
    "independent historical-block RPC replay",
    "deterministic bytecode selector and opcode scoring"
  ],
  confirmedCheckIds: review.checks
    .filter((check) => check.status === "confirmed")
    .map((check) => check.id),
  mismatchedCheckIds: review.checks
    .filter((check) => check.status === "mismatch")
    .map((check) => check.id),
  independentTransport: review.engine.independentTransport,
  humanReviewRequired: true,
  limitations: [
    "Candidate ground truth is objective replay evidence, but it is not marked reviewed until an independent human signs off.",
    ...review.limitations
  ]
  };

  await mkdir(experimentDirectory, { recursive: true });
  await Promise.all([
    writeJsonAtomic(outputPath, evidence),
    writeJsonAtomic(candidatePath, candidate)
  ]);
  console.log(JSON.stringify({
    outputPath,
    candidatePath,
    status: review.conclusion.status,
    checks: review.summary,
    independentTransport: review.engine.independentTransport,
    durationMs: evidence.timing.durationMs
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
