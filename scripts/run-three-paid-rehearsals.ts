import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  for (const line of readFileSync(path.join(repositoryRoot, ".env"), "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const raw = match[2].trim();
    process.env[match[1]] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
} catch {
  // Environment-only operation is supported when no repository .env exists.
}
const hunterUrl = (process.env.REHEARSAL_HUNTER_URL ?? "http://127.0.0.1:3002").replace(/\/$/, "");
const confirmation = process.env.REHEARSAL_CONFIRM;
const expectedAuthorityId = process.env.REHEARSAL_AUTHORITY_ID?.trim();
const resumeMissionId = process.env.REHEARSAL_RESUME_MISSION_ID?.trim();
const resumeMissionIds = (process.env.REHEARSAL_RESUME_MISSION_IDS?.trim() || resumeMissionId || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const apiToken = process.env.HUNTER_API_AUTH_TOKEN ?? process.env.API_AUTH_TOKEN;
const expected = {
  chainId: 97,
  asset: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
  runs: 3,
  auditor: { serviceId: "auditor-v1", recipient: "0x3Bd3Fd38ecC72378946c790780c8C1216e4c5527", amountRaw: "500000000000000000" },
  verifier: { serviceId: "verifier-v1", recipient: "0x7EA7fBf92d5355957C187976BFE7c5788B2F70bb", amountRaw: "250000000000000000" },
  intendedSpendRaw: "2250000000000000000",
  maximumAuthoritySpendRaw: "2250000000000000000"
} as const;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function paymentFrom(result: Record<string, unknown>, role: "primary" | "verification") {
  const scope = role === "primary" ? result : result.verification as Record<string, unknown> | undefined;
  invariant(scope && typeof scope === "object", `${role} result is missing`);
  const service = scope.service as Record<string, unknown> | undefined;
  const quote = scope.quote as Record<string, unknown> | undefined;
  const transaction = scope.paymentTx;
  invariant(service && quote && typeof transaction === "string", `${role} payment evidence is incomplete`);
  const accepts = quote.accepts as Array<Record<string, unknown>> | undefined;
  const accepted = accepts?.find((candidate) => candidate.scheme === "exact" || candidate.scheme === "x402-exact");
  invariant(accepted, `${role} x402 quote is missing`);
  const asset = accepted.asset as Record<string, unknown> | string | undefined;
  const assetAddress = typeof asset === "string" ? asset : asset?.address;
  return {
    serviceId: String(service.id),
    recipient: String(accepted.payTo ?? accepted.recipient ?? service.provider),
    amountRaw: String(accepted.maxAmountRequired ?? accepted.amount ?? accepted.amountRaw),
    assetAddress: String(assetAddress ?? ""),
    transaction
  };
}

async function requestJson(endpoint: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const headers = new Headers(init?.headers);
  if (apiToken) headers.set("Authorization", `Bearer ${apiToken}`);
  const response = await fetch(`${hunterUrl}${endpoint}`, { ...init, headers, signal: AbortSignal.timeout(900_000) });
  const body = await response.text();
  invariant(response.ok, `${endpoint} failed (${response.status}): ${body.slice(0, 500)}`);
  return JSON.parse(body) as Record<string, unknown>;
}

async function main(): Promise<void> {
  invariant(confirmation === "I_CONFIRM_3_PAID_REHEARSALS", "Refusing to broadcast: set REHEARSAL_CONFIRM=I_CONFIRM_3_PAID_REHEARSALS after reviewing the exact transaction preview");
  invariant(expectedAuthorityId, "REHEARSAL_AUTHORITY_ID must bind this run to the freshly approved Authority");

  const authorityResponse = await requestJson("/authority");
  const authority = authorityResponse.authority as Record<string, unknown> | undefined;
  invariant(authority?.authorityId === expectedAuthorityId, "Hunter is not using the explicitly approved Authority");
  invariant(authority.status === "active", "Approved Authority is not active");
  invariant(authority.chainId === expected.chainId, "Authority is not on BNB Testnet");
  const allowedCalls = authority.allowedCalls as Array<{ to?: string }>;
  invariant(expected.auditor.recipient && allowedCalls.some((call) => typeof call.to === "string" && sameAddress(call.to, expected.auditor.recipient)), "Authority does not allow the Auditor recipient");
  invariant(allowedCalls.some((call) => typeof call.to === "string" && sameAddress(call.to, expected.verifier.recipient)), "Authority does not allow the Verifier recipient");
  const spendLimits = authority.spendLimits as Array<{ limit?: string }>;
  invariant(spendLimits.some((limit) => limit.limit === expected.maximumAuthoritySpendRaw), "Authority cap is not exactly the approved 2.25 U");

  const source = (await readFile(path.join(repositoryRoot, "evidence/experiment-1-contract-audit/VulnerableVault.sol"), "utf8")).trim();
  const sourceHash = sha256(source);
  const goal = JSON.stringify({ source, sourceName: "VulnerableVault.sol" });
  let startedAt = new Date().toISOString();
  const runs: Array<Record<string, unknown>> = [];

  const validateCompletedRun = (
    result: Record<string, unknown>,
    runNumber: number,
    durationMs: number,
    deliveryMode: "live-response" | "settlement-reconciled" = "live-response"
  ): Record<string, unknown> => {
    const auditor = paymentFrom(result, "primary");
    const verifier = paymentFrom(result, "verification");
    invariant(auditor.serviceId === expected.auditor.serviceId && sameAddress(auditor.recipient, expected.auditor.recipient) && sameAddress(auditor.assetAddress, expected.asset) && auditor.amountRaw === expected.auditor.amountRaw, `Run ${runNumber} Auditor settlement does not match the approved preview`);
    invariant(verifier.serviceId === expected.verifier.serviceId && sameAddress(verifier.recipient, expected.verifier.recipient) && sameAddress(verifier.assetAddress, expected.asset) && verifier.amountRaw === expected.verifier.amountRaw, `Run ${runNumber} Verifier settlement does not match the approved preview`);
    invariant(/^0x[0-9a-fA-F]{64}$/.test(auditor.transaction) && /^0x[0-9a-fA-F]{64}$/.test(verifier.transaction), `Run ${runNumber} transaction evidence is invalid`);
    invariant(result.receiptVerified === true && (result.verification as Record<string, unknown>)?.receiptVerified === true, `Run ${runNumber} receipt verification failed`);
    const verificationReport = ((result.verification as Record<string, unknown>).report ?? {}) as Record<string, unknown>;
    const summary = verificationReport.summary as Record<string, number> | undefined;
    return {
      runNumber,
      status: "completed",
      deliveryMode,
      missionId: result.missionId,
      durationMs,
      sourceHash,
      payments: { auditor, verifier },
      receiptsVerified: true,
      hunterEvaluation: result.evaluation,
      verifier: { engine: verificationReport.engine, summary }
    };
  };

  if (resumeMissionIds.length > 0) {
    const missionStore = JSON.parse(
      await readFile(path.join(repositoryRoot, "registry/missions.json"), "utf8")
    ) as { records?: Record<string, Record<string, unknown>> };
    invariant(resumeMissionIds.length <= expected.runs, "Too many resume missions were supplied");
    for (const missionId of resumeMissionIds) {
      const mission = missionStore.records?.[missionId];
      invariant(mission, `Resume mission not found: ${missionId}`);
      invariant(mission.status === "completed", "Resume mission is not completed");
      invariant(mission.authorityId === expectedAuthorityId, "Resume mission used a different Authority");
      const missionGoal = JSON.parse(String(mission.goal)) as { source?: string; sourceName?: string };
      invariant(missionGoal.sourceName === "VulnerableVault.sol" && sha256(String(missionGoal.source ?? "").trim()) === sourceHash, "Resume mission source does not match the locked benchmark");
      const events = mission.events as Array<{ type?: string; at?: string }> | undefined;
      const startEvent = events?.find((event) => event.type === "run_started");
      const completeEvent = events?.slice().reverse().find((event) => event.type === "run_completed");
      invariant(startEvent?.at && completeEvent?.at, "Resume mission timing evidence is incomplete");
      const durationMs = Date.parse(completeEvent.at) - Date.parse(startEvent.at);
      invariant(Number.isSafeInteger(durationMs) && durationMs > 0, "Resume mission duration is invalid");
      const result = mission.result as Record<string, unknown> | undefined;
      invariant(result, "Resume mission result is missing");
      const runNumber = runs.length + 1;
      runs.push(validateCompletedRun(
        result,
        runNumber,
        durationMs,
        mission.source === "recovered-evidence" ? "settlement-reconciled" : "live-response"
      ));
      if (runNumber === 1) startedAt = startEvent.at;
      process.stdout.write(`Recovered paid rehearsal ${runNumber}/3: ${missionId}\n`);
    }
  }

  for (let runNumber = runs.length + 1; runNumber <= expected.runs; runNumber += 1) {
    const runStartedAt = Date.now();
    const result = await requestJson("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, mode: "scripted", locale: "en" })
    });
    runs.push(validateCompletedRun(result, runNumber, Date.now() - runStartedAt));
    process.stdout.write(`Paid rehearsal ${runNumber}/3 completed: ${String(result.missionId)}\n`);
  }

  const durations = runs.map((run) => Number(run.durationMs)).sort((left, right) => left - right);
  const evidence = {
    version: 1,
    artifactKind: "three-consecutive-paid-rehearsals",
    status: "completed",
    chainId: expected.chainId,
    authorityId: expectedAuthorityId,
    sourceHash,
    startedAt,
    completedAt: new Date().toISOString(),
    expectedEconomics: expected,
    actualSpendRaw: expected.intendedSpendRaw,
    medianDurationMs: durations[1],
    runs
  };
  const directory = path.join(repositoryRoot, "evidence/stability");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, "three-consecutive-paid-runs.json");
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  process.stdout.write(`${JSON.stringify({ status: evidence.status, authorityId: expectedAuthorityId, runs: runs.length, actualSpendRaw: evidence.actualSpendRaw, evidence: path.relative(repositoryRoot, target) }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Paid rehearsal failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
