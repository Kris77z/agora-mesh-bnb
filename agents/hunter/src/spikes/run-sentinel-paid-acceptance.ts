import { randomUUID } from "node:crypto";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ServiceInfo } from "@rebel/shared";
import { hunterConfig } from "../config.js";
import { runProductionX402Purchase } from "../integrations/altana/x402-client.js";
import { parseAuditReport } from "../security-pipeline.js";
import { resolveSecurityTaskInput } from "../security-input.js";
import { verifyReceiptTool } from "../tools/verify.js";

const CONFIRMATION = "I_CONFIRM_0_4_U_SENTINEL_PAYMENT";
const EXPECTED = {
  authorityId: "agora-v2-sentinel-20260904-01",
  serviceId: "sentinel-audit-v1",
  provider: "0x1Ef8eEb640e60d5d3Bc3eFe1A4b2fFCd64132c2C",
  asset: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
  amount: "400000000000000000",
  chainId: 97
} as const;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameAddress(left: string | undefined, right: string): boolean {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

async function main(): Promise<void> {
  invariant(
    process.env.SENTINEL_ACCEPTANCE_CONFIRM === CONFIRMATION,
    `Refusing to pay: set SENTINEL_ACCEPTANCE_CONFIRM=${CONFIRMATION}`
  );
  invariant(hunterConfig.chainId === EXPECTED.chainId, "Sentinel acceptance requires BNB Testnet");
  invariant(hunterConfig.altana.authorityId === EXPECTED.authorityId, "Unexpected Authority id");
  invariant(hunterConfig.altana.enabled && hunterConfig.x402.enabled, "Altana x402 is not enabled");

  const sentinelUrl = (process.env.SENTINEL_URL ?? "http://127.0.0.1:3006").replace(/\/$/, "");
  const identityResponse = await fetch(`${sentinelUrl}/identity`, { signal: AbortSignal.timeout(10_000) });
  invariant(identityResponse.ok, `Sentinel identity request failed (${identityResponse.status})`);
  const identity = await identityResponse.json() as { services?: ServiceInfo[] };
  const service = identity.services?.find((candidate) => candidate.id === EXPECTED.serviceId);
  invariant(service, "Sentinel did not advertise sentinel-audit-v1");
  invariant(service.availability?.available !== false, `Sentinel is unavailable: ${service.availability?.reason ?? "unknown"}`);
  invariant(service.endpoint.replace(/\/$/, "") === sentinelUrl, "Sentinel advertised an unexpected endpoint");
  invariant(sameAddress(service.provider, EXPECTED.provider), "Sentinel advertised an unexpected payee");
  invariant(service.price === EXPECTED.amount, "Sentinel advertised an unexpected price");
  invariant(service.asset?.chainId === EXPECTED.chainId, "Sentinel advertised an unexpected chain");
  invariant(service.asset?.kind === "erc20" && sameAddress(service.asset.address, EXPECTED.asset), "Sentinel advertised an unexpected asset");
  invariant(service.paymentRails?.includes("x402"), "Sentinel did not advertise x402");

  const repositoryRoot = path.resolve(process.env.INIT_CWD ?? process.cwd());
  const source = (await readFile(
    path.join(repositoryRoot, "evidence/experiment-1-contract-audit/VulnerableVault.sol"),
    "utf8"
  )).trim();
  const securityInput = await resolveSecurityTaskInput(
    JSON.stringify({ source, sourceName: "VulnerableVault.sol" })
  );
  const missionId = `sentinel-acceptance-${randomUUID()}`;
  const purchase = await runProductionX402Purchase({
    missionId,
    service,
    taskType: "smart-contract-audit",
    taskInput: JSON.stringify(securityInput),
    locale: "en-US"
  });
  const receiptCheck = verifyReceiptTool(purchase.execution.receipt, {
    result: purchase.execution.result,
    provider: EXPECTED.provider
  });
  invariant(receiptCheck.isValid, "Sentinel receipt verification failed");
  const report = parseAuditReport(purchase.execution.result);
  invariant(purchase.execution.payment.transaction.startsWith("0x"), "Sentinel settlement transaction is missing");

  const evidence = {
    version: 1,
    artifactKind: "sentinel-paid-acceptance",
    status: "completed",
    authorityId: EXPECTED.authorityId,
    missionId,
    completedAt: new Date().toISOString(),
    service: {
      id: service.id,
      agentId: service.agentId,
      provider: service.provider,
      endpoint: service.endpoint
    },
    economics: {
      chainId: EXPECTED.chainId,
      asset: EXPECTED.asset,
      amountRaw: EXPECTED.amount,
      transaction: purchase.execution.payment.transaction
    },
    requestHash: purchase.request.requestHash,
    idempotencyKey: purchase.request.idempotencyKey,
    receipt: purchase.execution.receipt,
    receiptVerified: true,
    sourceHash: securityInput.sourceHash,
    reportSummary: {
      vulnerabilityCount: report.vulnerabilities.length,
      vulnerabilities: report.vulnerabilities.map((finding) => ({
        findingId: finding.findingId,
        title: finding.title,
        severity: finding.severity
      }))
    }
  };
  const directory = path.join(repositoryRoot, "evidence/stability");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, "sentinel-paid-acceptance.json");
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Sentinel paid acceptance failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
