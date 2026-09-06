import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ServiceInfo } from "@rebel/shared";

const CONFIRMATION = "I_CONFIRM_0_5_U_AUDITOR_AND_0_25_U_VERIFIER";
const EXPECTED = {
  authorityId: "agora-v2-sentinel-20260904-01",
  chainId: 97,
  asset: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565",
  cap: "1150000000000000000",
  auditor: {
    id: "auditor-v1",
    provider: "0x3Bd3Fd38ecC72378946c790780c8C1216e4c5527",
    amount: "500000000000000000"
  },
  verifier: {
    id: "verifier-v1",
    provider: "0x7EA7fBf92d5355957C187976BFE7c5788B2F70bb",
    amount: "250000000000000000"
  }
} as const;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameAddress(left: unknown, right: string): boolean {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

async function readJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(900_000) });
  const body = await response.text();
  invariant(response.ok, `${url} failed (${response.status}): ${body.slice(0, 600)}`);
  return JSON.parse(body) as Record<string, unknown>;
}

function assertService(service: ServiceInfo | undefined, expected: typeof EXPECTED.auditor | typeof EXPECTED.verifier): void {
  invariant(service, `${expected.id} is not advertised`);
  invariant(service.availability?.available !== false, `${expected.id} is unavailable`);
  invariant(service.paymentRails?.includes("x402"), `${expected.id} does not advertise x402`);
  invariant(service.network === `eip155:${EXPECTED.chainId}`, `${expected.id} is on an unexpected chain`);
  invariant(sameAddress(service.provider, expected.provider), `${expected.id} has an unexpected payee`);
  invariant(service.price === expected.amount, `${expected.id} has an unexpected price`);
  invariant(service.asset?.kind === "erc20" && service.asset.chainId === EXPECTED.chainId &&
    sameAddress(service.asset.address, EXPECTED.asset), `${expected.id} has an unexpected asset`);
}

function extractPayment(result: Record<string, unknown>, verification = false) {
  const scope = verification ? result.verification as Record<string, unknown> | undefined : result;
  invariant(scope, `${verification ? "Verifier" : "Auditor"} result is missing`);
  const service = scope.service as Record<string, unknown> | undefined;
  const quote = scope.quote as Record<string, unknown> | undefined;
  const accepts = quote?.accepts as Array<Record<string, unknown>> | undefined;
  const accepted = accepts?.find((entry) => entry.scheme === "exact" || entry.scheme === "x402-exact");
  invariant(service && accepted, `${verification ? "Verifier" : "Auditor"} quote evidence is missing`);
  return {
    serviceId: String(service.id),
    provider: String(service.provider),
    amount: String(accepted.amount ?? accepted.maxAmountRequired),
    asset: String(accepted.asset),
    transaction: String(scope.paymentTx),
    receiptVerified: scope.receiptVerified === true
  };
}

async function main(): Promise<void> {
  invariant(process.env.BACKEND_ACCEPTANCE_CONFIRM === CONFIRMATION, `Refusing to pay: set BACKEND_ACCEPTANCE_CONFIRM=${CONFIRMATION}`);
  const repositoryRoot = path.resolve(process.env.INIT_CWD ?? process.cwd());
  const hunterUrl = (process.env.ACCEPTANCE_HUNTER_URL ?? "http://127.0.0.1:3002").replace(/\/$/, "");
  const registryUrl = (process.env.ACCEPTANCE_REGISTRY_URL ?? "http://127.0.0.1:3003").replace(/\/$/, "");
  const apiToken = process.env.HUNTER_API_AUTH_TOKEN ?? process.env.API_AUTH_TOKEN;

  const authorityBody = await readJson(`${hunterUrl}/authority`);
  const authority = authorityBody.authority as Record<string, unknown> | undefined;
  invariant(authority?.authorityId === EXPECTED.authorityId && authority.status === "active", "Expected Authority is not active");
  invariant(authority.chainId === EXPECTED.chainId, "Authority is on an unexpected chain");
  const spendLimits = authority.spendLimits as Array<{ limit?: string }> | undefined;
  invariant(spendLimits?.some((entry) => entry.limit === EXPECTED.cap), "Authority cap is not exactly 1.15 U");

  const catalog = await readJson(`${registryUrl}/services`) as { services?: ServiceInfo[] };
  assertService(catalog.services?.find((entry) => entry.id === EXPECTED.auditor.id), EXPECTED.auditor);
  assertService(catalog.services?.find((entry) => entry.id === EXPECTED.verifier.id), EXPECTED.verifier);

  const source = (await readFile(path.join(repositoryRoot, "evidence/experiment-1-contract-audit/VulnerableVault.sol"), "utf8")).trim();
  const sourceHash = `sha256:${createHash("sha256").update(source).digest("hex")}`;
  const idempotencyKey = `backend-acceptance-${randomUUID()}`;
  const headers = new Headers({ "Content-Type": "application/json", "Idempotency-Key": idempotencyKey });
  if (apiToken) headers.set("Authorization", `Bearer ${apiToken}`);
  const startedAt = new Date().toISOString();
  const result = await readJson(`${hunterUrl}/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      goal: JSON.stringify({ source, sourceName: "VulnerableVault.sol" }),
      mode: "single",
      locale: "en-US"
    })
  });
  const auditor = extractPayment(result);
  const verifier = extractPayment(result, true);
  invariant(auditor.serviceId === EXPECTED.auditor.id && sameAddress(auditor.provider, EXPECTED.auditor.provider) &&
    auditor.amount === EXPECTED.auditor.amount && sameAddress(auditor.asset, EXPECTED.asset), "Auditor settlement differs from preview");
  invariant(verifier.serviceId === EXPECTED.verifier.id && sameAddress(verifier.provider, EXPECTED.verifier.provider) &&
    verifier.amount === EXPECTED.verifier.amount && sameAddress(verifier.asset, EXPECTED.asset), "Verifier settlement differs from preview");
  invariant(auditor.receiptVerified && verifier.receiptVerified, "One or more receipts failed verification");
  invariant(/^0x[0-9a-fA-F]{64}$/.test(auditor.transaction) && /^0x[0-9a-fA-F]{64}$/.test(verifier.transaction), "Settlement transaction evidence is incomplete");

  const evidence = {
    version: 1,
    artifactKind: "auditor-verifier-paid-acceptance",
    status: "completed",
    authorityId: EXPECTED.authorityId,
    missionId: result.missionId,
    idempotencyKey,
    sourceHash,
    startedAt,
    completedAt: new Date().toISOString(),
    economics: { intendedSpendRaw: "750000000000000000", auditor, verifier },
    evaluation: result.evaluation
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
  process.stderr.write(`Backend paid acceptance failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
