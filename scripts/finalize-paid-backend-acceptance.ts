import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseAuditReport, parseVerificationReport } from "../agents/hunter/src/security-pipeline.js";
import { verifyReceiptTool } from "../agents/hunter/src/tools/verify.js";

const MISSION_ID = "93c1d134-5c7a-40a8-ad85-e5f783f4939d";
const AUTHORITY_ID = "agora-v2-sentinel-20260904-01";
const ASSET = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565";
const EXPECTED = {
  auditor: { id: "auditor-v1", provider: "0x3Bd3Fd38ecC72378946c790780c8C1216e4c5527", amount: "500000000000000000" },
  verifier: { id: "verifier-v1", provider: "0x7EA7fBf92d5355957C187976BFE7c5788B2F70bb", amount: "250000000000000000" }
} as const;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameAddress(left: unknown, right: string): boolean {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

function validatePayment(scope: Record<string, unknown>, expected: typeof EXPECTED.auditor | typeof EXPECTED.verifier) {
  const service = scope.service as Record<string, unknown> | undefined;
  const quote = scope.quote as { accepts?: Array<Record<string, unknown>> } | undefined;
  const accepted = quote?.accepts?.find((entry) => entry.scheme === "exact");
  const execution = scope.execution as Record<string, unknown> | undefined;
  const receipt = execution?.receipt as Parameters<typeof verifyReceiptTool>[0] | undefined;
  invariant(service?.id === expected.id && sameAddress(service.provider, expected.provider), `${expected.id} service identity mismatch`);
  invariant(accepted?.network === "eip155:97" && sameAddress(accepted.asset, ASSET) &&
    sameAddress(accepted.payTo, expected.provider) && accepted.amount === expected.amount, `${expected.id} quote mismatch`);
  invariant(typeof scope.paymentTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(scope.paymentTx), `${expected.id} tx missing`);
  invariant(scope.receiptVerified === true && receipt && typeof execution?.result === "string", `${expected.id} receipt evidence missing`);
  invariant(verifyReceiptTool(receipt, { result: execution.result, provider: expected.provider }).isValid, `${expected.id} receipt signature invalid`);
  return { serviceId: expected.id, provider: expected.provider, amountRaw: expected.amount, asset: ASSET, transaction: scope.paymentTx };
}

async function main(): Promise<void> {
  const repositoryRoot = path.resolve(process.env.INIT_CWD ?? process.cwd());
  const missions = JSON.parse(await readFile(path.join(repositoryRoot, "registry/missions.json"), "utf8")) as {
    records?: Record<string, Record<string, unknown>>;
  };
  const mission = missions.records?.[MISSION_ID];
  invariant(mission?.status === "completed" && mission.source === "recovered-evidence", "Recovered mission is not completed");
  invariant(mission.authorityId === AUTHORITY_ID, "Recovered mission used an unexpected Authority");
  const goal = JSON.parse(String(mission.goal)) as { source?: string; sourceName?: string };
  invariant(goal.sourceName === "VulnerableVault.sol" && typeof goal.source === "string", "Recovered mission source is invalid");
  const sourceHash = `sha256:${createHash("sha256").update(goal.source.trim()).digest("hex")}`;
  const result = mission.result as Record<string, unknown> | undefined;
  invariant(result, "Recovered mission result is missing");
  const auditor = validatePayment(result, EXPECTED.auditor);
  const verification = result.verification as Record<string, unknown> | undefined;
  invariant(verification, "Verifier result is missing");
  const verifier = validatePayment(verification, EXPECTED.verifier);
  const auditorExecution = result.execution as { result: string };
  const verifierExecution = verification.execution as { result: string };
  const auditReport = parseAuditReport(auditorExecution.result);
  const verificationReport = parseVerificationReport(verifierExecution.result, sourceHash, {
    findingIds: auditReport.vulnerabilities.map((finding) => finding.findingId),
    verifierAgentId: (verification.service as { agentId?: string }).agentId
  });

  const evidence = {
    version: 1,
    artifactKind: "auditor-verifier-paid-acceptance",
    status: "completed",
    deliveryMode: "settlement-recovered",
    authorityId: AUTHORITY_ID,
    missionId: MISSION_ID,
    sourceHash,
    completedAt: new Date(Number(mission.completedAt)).toISOString(),
    economics: { intendedSpendRaw: "750000000000000000", auditor, verifier },
    receiptsVerified: true,
    auditorFindings: auditReport.vulnerabilities.length,
    verifier: { engine: verificationReport.engine, summary: verificationReport.summary },
    recoveryDisclosure: "The Auditor payment settled once; a stalled model request was recovered from the exact mission/request/transaction before the Verifier payment."
  };
  const directory = path.join(repositoryRoot, "evidence/stability");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, "auditor-verifier-paid-acceptance.json");
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Backend acceptance finalization failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
