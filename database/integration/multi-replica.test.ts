import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  PostgresCoordinationStore,
  StaleLeaseError,
  assertPostgresSchemaCurrent,
  createPostgresPool
} from "../../shared/src/postgres-coordination-store.js";
import {
  closeProcessPostgresStores,
  getOnchainIdentityRecord,
  getPersistedAgentIdentity,
  listDynamicServices,
  listPersistedAgentIdentities,
  persistAgentIdentity,
  registerDynamicService,
  upsertOnchainIdentityRecord
} from "../../shared/src/index.js";
import { appendExperience, readExperiences } from "../../agents/hunter/src/memory.js";
import { PostgresHunterRunStore } from "../../agents/hunter/src/run-store.js";
import { PostgresHunterMissionStore } from "../../agents/hunter/src/mission-store.js";
import {
  PostgresX402PurchaseStore,
  purchaseKey
} from "../../agents/hunter/src/integrations/altana/purchase-store.js";
import { PostgresX402ExecutionStore } from "../../agents/writer/src/x402/receipt-store.js";
import { PostgresAuthorityEvidenceStore } from "../../agents/hunter/src/integrations/altana/authority-evidence-store.js";

const connectionString = process.env.AGORA_POSTGRES_TEST_URL ??
  "postgresql://agora_runtime:agora_runtime_local@127.0.0.1:55432/agora_mesh";
const testScope = `integration:${randomUUID()}`;
const poolA = createPostgresPool({ connectionString, applicationName: "agora-test-replica-a", maxConnections: 12 });
const poolB = createPostgresPool({ connectionString, applicationName: "agora-test-replica-b", maxConnections: 12 });
const a = new PostgresCoordinationStore(poolA);
const b = new PostgresCoordinationStore(poolB);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runInput(suffix: string, requestHash = hash(`request:${suffix}`)) {
  return {
    scope: testScope,
    keyHash: hash(`key:${suffix}`),
    requestHash,
    ownerId: "integration-owner",
    goal: `integration goal ${suffix}`,
    requestMode: "commander" as const,
    locale: "en"
  };
}

async function cleanIntegrationData(scopePattern: string): Promise<void> {
  await poolA.query(`
    DELETE FROM outbox
    WHERE aggregate_id LIKE $1
       OR aggregate_id IN (
         SELECT execution_id::text FROM x402_executions WHERE service_id LIKE $1
       )
  `, [scopePattern]);
  await poolA.query("DELETE FROM x402_executions WHERE service_id LIKE $1", [scopePattern]);
  await poolA.query("DELETE FROM x402_purchases WHERE service_id LIKE $1", [scopePattern]);
  await poolA.query("DELETE FROM missions WHERE mission_id IN (SELECT mission_id FROM runs WHERE scope LIKE $1)", [scopePattern]);
  await poolA.query(`DELETE FROM service_feedback WHERE mission_id LIKE $1 OR mission_id IN (
    SELECT mission_id FROM runs WHERE scope LIKE $1
  )`, [scopePattern]);
  await poolA.query("DELETE FROM agent_feedback WHERE agent_id LIKE $1", [scopePattern]);
  await poolA.query("DELETE FROM agent_identities WHERE agent_id LIKE $1", [scopePattern]);
  await poolA.query("DELETE FROM onchain_identities WHERE identity_key LIKE $1", [scopePattern]);
  await poolA.query("DELETE FROM hunter_experiences WHERE mission_id LIKE $1", [scopePattern]);
  await poolA.query(`DELETE FROM run_events WHERE mission_id IN (
    SELECT mission_id FROM runs WHERE scope LIKE $1
  )`, [scopePattern]);
  await poolA.query("DELETE FROM run_idempotency WHERE scope LIKE $1", [scopePattern]);
  await poolA.query("DELETE FROM runs WHERE scope LIKE $1", [scopePattern]);
  await poolA.query("DELETE FROM service_leases WHERE service_id LIKE $1", [scopePattern]);
  await poolA.query("DELETE FROM authority_steps WHERE authority_id LIKE $1", [scopePattern]);
  await poolA.query("DELETE FROM authorities WHERE authority_id LIKE $1", [scopePattern]);
  await poolA.query("DELETE FROM chain_transactions WHERE tx_hash IN ($1, $2)", [
    `0x${"a".repeat(64)}`, `0x${"c".repeat(64)}`
  ]);
  await poolA.query("DELETE FROM chain_transactions WHERE metadata->>'serviceId' LIKE $1", [scopePattern]);
  await poolA.query("DELETE FROM chain_transactions WHERE metadata->>'authorityId' LIKE $1", [scopePattern]);
}

before(async () => {
  await assertPostgresSchemaCurrent(poolA);
  await assertPostgresSchemaCurrent(poolB);
  await cleanIntegrationData("integration:%");
});

after(async () => {
  await cleanIntegrationData(`${testScope}%`);
  await closeProcessPostgresStores();
  await Promise.all([poolA.end(), poolB.end()]);
});

test("20 concurrent admissions converge on one mission and reject changed input", async () => {
  const input = runInput("same-idempotency");
  const admissions = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    (index % 2 ? a : b).admitRun(input)
  ));
  assert.equal(admissions.filter((item) => item.kind === "created").length, 1);
  assert.equal(new Set(admissions.map((item) => item.run.missionId)).size, 1);
  assert.equal((await b.admitRun(input)).kind, "replay");
  assert.equal((await b.admitRun({ ...input, requestHash: hash("changed") })).kind, "conflict");
});

test("two replicas claim disjoint work with SKIP LOCKED", async () => {
  const scope = `${testScope}:claim`;
  await Promise.all(Array.from({ length: 12 }, (_, index) => a.admitRun({
    ...runInput(`claim-${index}`), scope
  })));
  const [claimedA, claimedB] = await Promise.all([
    a.claimRuns(scope, "worker-a", 6, 10_000),
    b.claimRuns(scope, "worker-b", 6, 10_000)
  ]);
  assert.equal(claimedA.length, 6);
  assert.equal(claimedB.length, 6);
  assert.equal(new Set([...claimedA, ...claimedB].map((run) => run.missionId)).size, 12);
  assert.equal((await a.claimRuns(scope, "worker-c", 20, 10_000)).length, 0);
});

test("expired lease is taken over and the stale fencing token cannot write", async () => {
  const scope = `${testScope}:fencing`;
  const admitted = await a.admitRun({ ...runInput("fencing"), scope });
  const first = (await a.claimRuns(scope, "worker-old", 1, 150)).find(
    (run) => run.missionId === admitted.run.missionId
  );
  assert.ok(first);
  assert.equal(await a.appendRunEvent({
    missionId: first.missionId,
    workerId: "worker-old",
    fencingToken: first.fencingToken,
    eventType: "phase",
    payload: { step: 1 }
  }), "1");
  await new Promise((resolve) => setTimeout(resolve, 190));
  const second = (await b.claimRuns(scope, "worker-new", 20, 5_000)).find(
    (run) => run.missionId === first.missionId
  );
  assert.ok(second);
  assert.equal(BigInt(second.fencingToken), BigInt(first.fencingToken) + 1n);
  await assert.rejects(a.appendRunEvent({
    missionId: first.missionId,
    workerId: "worker-old",
    fencingToken: first.fencingToken,
    eventType: "stale",
    payload: {}
  }), StaleLeaseError);
  assert.equal(await b.appendRunEvent({
    missionId: second.missionId,
    workerId: "worker-new",
    fencingToken: second.fencingToken,
    eventType: "phase",
    payload: { step: 2 }
  }), "2");
  const replay = await a.listRunEvents(second.missionId, "1");
  assert.deepEqual(replay.map((event) => event.sequence), ["2"]);
  const completed = await b.finishRun({
    missionId: second.missionId,
    workerId: "worker-new",
    fencingToken: second.fencingToken,
    status: "completed",
    result: { ok: true }
  });
  assert.equal(completed.status, "completed");
  await assert.rejects(a.finishRun({
    missionId: first.missionId,
    workerId: "worker-old",
    fencingToken: first.fencingToken,
    status: "failed"
  }), StaleLeaseError);
});

test("payment transaction, execution state and outbox commit atomically and replay once", async () => {
  const run = (await a.admitRun(runInput("payment"))).run;
  const purchase = await a.createPurchase({
    missionId: run.missionId,
    serviceId: `${testScope}:auditor`,
    idempotencyKeyHash: hash("payment-key"),
    requestHash: hash("payment-request"),
    chainId: 97,
    assetKind: "erc20",
    assetAddress: "0x1111111111111111111111111111111111111111",
    assetSymbol: "U",
    assetDecimals: 18,
    amount: "500000000000000000",
    recipient: "0x2222222222222222222222222222222222222222",
    request: { missionId: run.missionId },
    requirement: { scheme: "exact" },
    selectedAccept: { amount: "500000000000000000" }
  });
  assert.equal(purchase.created, true);
  assert.equal((await b.createPurchase({
    missionId: run.missionId,
    serviceId: `${testScope}:auditor`,
    idempotencyKeyHash: hash("payment-key"),
    requestHash: hash("payment-request"),
    chainId: 97,
    assetKind: "erc20",
    assetAddress: "0x1111111111111111111111111111111111111111",
    assetSymbol: "U",
    assetDecimals: 18,
    amount: "500000000000000000",
    recipient: "0x2222222222222222222222222222222222222222",
    request: { missionId: run.missionId },
    requirement: { scheme: "exact" },
    selectedAccept: { amount: "500000000000000000" }
  })).created, false);
  assert.equal(await a.beginExecutionSettlement({
    serviceId: `${testScope}:auditor`,
    idempotencyKeyHash: hash("merchant-key"),
    requestHash: hash("payment-request"),
    purchaseId: purchase.purchaseId,
    request: { audit: true }
  }), true);
  assert.equal(await b.beginExecutionSettlement({
    serviceId: `${testScope}:auditor`,
    idempotencyKeyHash: hash("merchant-key"),
    requestHash: hash("payment-request"),
    purchaseId: purchase.purchaseId,
    request: { audit: true }
  }), false);

  const transaction = {
    chainId: 97,
    txHash: `0x${"a".repeat(64)}`,
    purpose: "x402-payment",
    amount: "500000000000000000",
    blockNumber: "12345678901234567890",
    blockHash: `0x${"b".repeat(64)}`,
    confirmations: 3
  };
  await assert.rejects(a.recordConfirmedPayment({
    serviceId: `${testScope}:auditor`,
    idempotencyKeyHash: hash("merchant-key"),
    paymentEvidence: { paid: true },
    transaction: { ...transaction, txHash: "invalid" }
  }));
  const beforeCommit = await poolA.query<{ state: string }>(`
    SELECT state FROM x402_executions
    WHERE service_id = $1 AND idempotency_key_hash = $2
  `, [`${testScope}:auditor`, hash("merchant-key")]);
  assert.equal(beforeCommit.rows[0].state, "settlement_attempting");

  const first = await a.recordConfirmedPayment({
    serviceId: `${testScope}:auditor`,
    idempotencyKeyHash: hash("merchant-key"),
    paymentEvidence: { paid: true },
    transaction
  });
  assert.equal(first.replay, false);
  const replay = await b.recordConfirmedPayment({
    serviceId: `${testScope}:auditor`,
    idempotencyKeyHash: hash("merchant-key"),
    paymentEvidence: { paid: true },
    transaction
  });
  assert.equal(replay.replay, true);
  assert.equal(replay.transactionId, first.transactionId);
  await assert.rejects(a.recordConfirmedPayment({
    serviceId: `${testScope}:auditor`,
    idempotencyKeyHash: hash("merchant-key"),
    paymentEvidence: { paid: true },
    transaction: { ...transaction, txHash: `0x${"e".repeat(64)}` }
  }), /different settlement transaction/i);
  await assert.rejects(a.recordConfirmedPayment({
    serviceId: `${testScope}:auditor`,
    idempotencyKeyHash: hash("merchant-key"),
    paymentEvidence: { paid: true },
    transaction: { ...transaction, amount: "1" }
  }), /conflicting payment evidence/i);
  assert.equal(await a.beginExecutionSettlement({
    serviceId: `${testScope}:auditor-second`,
    idempotencyKeyHash: hash("merchant-key-second"),
    requestHash: hash("payment-request-second"),
    request: { audit: true }
  }), true);
  await assert.rejects(a.recordConfirmedPayment({
    serviceId: `${testScope}:auditor-second`,
    idempotencyKeyHash: hash("merchant-key-second"),
    paymentEvidence: { paid: true },
    transaction
  }), /unique constraint/i);
  const counts = await poolA.query<{ transactions: string; messages: string }>(`
    SELECT
      (SELECT count(*)::text FROM chain_transactions WHERE chain_id = 97 AND tx_hash = $1) AS transactions,
      (SELECT count(*)::text FROM outbox WHERE dedupe_key = $2) AS messages
  `, [transaction.txHash, `x402-payment-confirmed:${await poolA.query<{ execution_id: string }>(
    "SELECT execution_id FROM x402_executions WHERE service_id = $1 AND idempotency_key_hash = $2",
    [`${testScope}:auditor`, hash("merchant-key")]
  ).then((result) => result.rows[0].execution_id)}`]);
  assert.deepEqual(counts.rows[0], { transactions: "1", messages: "1" });
});

test("uncertain settlement cannot restart and can be explicitly reconciled", async () => {
  const run = (await a.admitRun(runInput("uncertain"))).run;
  const purchase = await a.createPurchase({
    missionId: run.missionId,
    serviceId: `${testScope}:verifier`,
    idempotencyKeyHash: hash("uncertain-purchase"),
    requestHash: hash("uncertain-request"),
    chainId: 97,
    assetKind: "erc20",
    assetAddress: "0x1111111111111111111111111111111111111111",
    assetSymbol: "U",
    assetDecimals: 18,
    amount: "250000000000000000",
    recipient: "0x3333333333333333333333333333333333333333",
    request: {},
    requirement: {},
    selectedAccept: {}
  });
  assert.equal(await a.beginExecutionSettlement({
    serviceId: `${testScope}:verifier`,
    idempotencyKeyHash: hash("uncertain-execution"),
    requestHash: hash("uncertain-request"),
    purchaseId: purchase.purchaseId,
    request: {}
  }), true);
  assert.equal(await a.markSettlementUncertain(
    `${testScope}:verifier`, hash("uncertain-execution"), "relay response lost"
  ), true);
  assert.equal(await b.beginExecutionSettlement({
    serviceId: `${testScope}:verifier`,
    idempotencyKeyHash: hash("uncertain-execution"),
    requestHash: hash("uncertain-request"),
    purchaseId: purchase.purchaseId,
    request: {}
  }), false);
  const state = await poolA.query<{ state: string }>(`
    SELECT state FROM x402_executions WHERE service_id = $1 AND idempotency_key_hash = $2
  `, [`${testScope}:verifier`, hash("uncertain-execution")]);
  assert.equal(state.rows[0].state, "settlement_uncertain");
  await a.recordConfirmedPayment({
    serviceId: `${testScope}:verifier`,
    idempotencyKeyHash: hash("uncertain-execution"),
    paymentEvidence: { reconciled: true },
    transaction: {
      chainId: 97,
      txHash: `0x${"c".repeat(64)}`,
      purpose: "x402-payment-reconciliation"
    }
  });
  const reconciled = await poolA.query<{ state: string }>(`
    SELECT state FROM x402_executions WHERE service_id = $1 AND idempotency_key_hash = $2
  `, [`${testScope}:verifier`, hash("uncertain-execution")]);
  assert.equal(reconciled.rows[0].state, "paid");
});

test("outbox retry is claimed once across replicas and dedupe survives redelivery", async () => {
  await poolA.query(`
    UPDATE outbox SET published_at = clock_timestamp(), locked_by = NULL, locked_until = NULL
    WHERE published_at IS NULL AND aggregate_id IN (
      SELECT execution_id::text FROM x402_executions WHERE service_id LIKE $1
    )
  `, [`${testScope}%`]);
  const aggregateId = `${testScope}:outbox`;
  const message = {
    aggregateType: "service",
    aggregateId,
    topic: "service.registered",
    payload: { serviceId: aggregateId },
    dedupeKey: `${testScope}:outbox-dedupe`
  };
  assert.equal(await a.enqueueOutbox(message), true);
  assert.equal(await b.enqueueOutbox(message), false);
  const [claimA, claimB] = await Promise.all([
    a.claimOutbox("outbox-a", 1, 5_000),
    b.claimOutbox("outbox-b", 1, 5_000)
  ]);
  assert.equal(claimA.length + claimB.length, 1);
  const first = claimA[0] ?? claimB[0];
  const owner = claimA[0] ? "outbox-a" : "outbox-b";
  assert.equal(await a.markOutboxFailed(first.id, owner, "broker unavailable", 0), true);
  const second = await b.claimOutbox("outbox-retry", 1, 5_000);
  assert.equal(second.length, 1);
  assert.equal(second[0].id, first.id);
  assert.equal(second[0].attempts, 2);
  assert.equal(await b.markOutboxPublished(second[0].id, "outbox-retry"), true);
  assert.equal((await a.claimOutbox("outbox-after", 10, 5_000)).some((item) => item.id === first.id), false);
});

test("service heartbeats expire and database disconnect fails closed", async () => {
  const serviceId = `${testScope}:lease`;
  await a.upsertServiceLease({
    serviceId,
    agentId: "agent:test",
    endpoint: "http://127.0.0.1:3999",
    capability: { id: serviceId },
    ttlMs: 120
  });
  assert.equal((await b.listAvailableServices()).some((service) => service.serviceId === serviceId), true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await a.listAvailableServices()).some((service) => service.serviceId === serviceId), false);

  const closedPool = createPostgresPool({ connectionString, applicationName: "agora-test-closed" });
  const closedStore = new PostgresCoordinationStore(closedPool);
  await closedPool.end();
  await assert.rejects(closedStore.admitRun(runInput("must-not-admit")), /pool after calling end/i);
});

test("Authority journal stores public evidence and rejects raw secret material", async () => {
  const authorityId = `${testScope}:authority`;
  await a.saveAuthority({
    authorityId,
    walletAddress: "0x4444444444444444444444444444444444444444",
    sessionPublicKey: "0xpublic-only",
    chainId: 97,
    allowedCalls: [{ to: "0x5555555555555555555555555555555555555555" }],
    spendLimits: [{ amount: "1150000000000000000", period: "total" }],
    expiresAt: new Date(Date.now() + 86_400_000),
    status: "active",
    encryptedMaterialRef: "keychain://agora/session/integration"
  });
  assert.equal(await a.recordAuthorityStep({
    authorityId,
    step: "grantSession",
    attempt: 1,
    state: "confirmed",
    publicEvidence: { txHash: `0x${"d".repeat(64)}` }
  }), true);
  assert.equal(await b.recordAuthorityStep({
    authorityId,
    step: "grantSession",
    attempt: 1,
    state: "confirmed",
    publicEvidence: { duplicate: true }
  }), false);
  await assert.rejects(a.saveAuthority({
    authorityId: `${authorityId}:raw-secret`,
    walletAddress: "0x4444444444444444444444444444444444444444",
    sessionPublicKey: "0xpublic-only",
    chainId: 97,
    allowedCalls: [],
    spendLimits: [],
    expiresAt: new Date(Date.now() + 86_400_000),
    status: "active",
    encryptedMaterialRef: `0x${"e".repeat(64)}`
  }), /opaque KMS/);
  const forbiddenColumns = await poolA.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (column_name LIKE '%private_key%' OR column_name = 'payment_signature')
  `);
  assert.equal(forbiddenColumns.rows[0].count, "0");
});

test("Authority evidence adapter checkpoints lifecycle transactions for restart recovery", async () => {
  const authorityId = `${testScope}:authority-adapter`;
  const txHash = `0x${hash("authority-adapter-grant")}` as `0x${string}`;
  const store = new PostgresAuthorityEvidenceStore(a);
  await store.save({
    authority: {
      authorityId,
      walletAddress: "0x4444444444444444444444444444444444444444",
      sessionPublicKey: "0x5555555555555555555555555555555555555555",
      chainId: 97,
      allowedCalls: [{ to: "0x6666666666666666666666666666666666666666" }],
      spendLimits: [{
        asset: {
          chainId: 97,
          kind: "erc20",
          address: "0x1111111111111111111111111111111111111111",
          symbol: "U",
          decimals: 18
        },
        limit: "600000000000000000",
        period: "total"
      }],
      expiry: Math.floor(Date.now() / 1_000) + 86_400,
      status: "invalid",
      createdAt: Date.now()
    },
    lifecycle: {
      operation: "provision",
      phase: "blocked",
      pendingStep: "grantSession",
      transactions: { grantSession: txHash }
    },
    updatedAt: Math.floor(Date.now() / 1_000)
  });
  const restarted = await new PostgresAuthorityEvidenceStore(b).get(authorityId);
  assert.equal(restarted?.lifecycle?.pendingStep, "grantSession");
  assert.equal(restarted?.lifecycle?.transactions.grantSession, txHash);
  const journal = await poolA.query<{ state: string; tx_hash: string; transaction_status: string }>(`
    SELECT s.state, t.tx_hash, t.status AS transaction_status
    FROM authority_steps s
    JOIN chain_transactions t ON t.transaction_id = s.transaction_id
    WHERE s.authority_id = $1 AND s.step = 'grantSession'
  `, [authorityId]);
  assert.deepEqual(journal.rows[0], {
    state: "uncertain", tx_hash: txHash, transaction_status: "submitted"
  });
});

test("Hunter run and mission adapters persist a complete terminal projection", async () => {
  const scope = `${testScope}:hunter-adapter`;
  const runs = new PostgresHunterRunStore(a, scope, 5_000);
  const missions = new PostgresHunterMissionStore(a);
  const input = {
    idempotencyKey: "adapter:hunter:0001",
    ownerId: "adapter-worker",
    goal: "adapter audit",
    requestMode: "single" as const,
    locale: "en-US" as const
  };
  const admitted = await runs.admit(input);
  assert.equal(admitted.kind, "created");
  const replay = await new PostgresHunterRunStore(b, scope, 5_000).admit(input);
  assert.equal(replay.kind, "replay");
  assert.equal(replay.record.missionId, admitted.record.missionId);
  const trace = {
    type: "run_started" as const,
    at: new Date().toISOString(),
    data: { missionId: admitted.record.missionId }
  };
  const terminal = await runs.update(admitted.record.missionId, (current) => ({
    ...current,
    events: [...current.events, trace],
    status: "completed",
    result: {
      missionId: current.missionId,
      goal: current.goal,
      mode: "scripted",
      service: {}, quote: {}, paymentTx: "0xtest", execution: {}, receiptVerified: true,
      evaluation: { score: 10, summary: "ok" }, finalMessage: "done"
    } as never
  }));
  assert.equal(terminal.status, "completed");
  assert.deepEqual(terminal.events, [trace]);
  await missions.save({
    missionId: terminal.missionId,
    goal: terminal.goal,
    chainId: 97,
    mode: "scripted",
    status: "completed",
    source: "live-run",
    events: terminal.events,
    result: terminal.result,
    createdAt: terminal.createdAt,
    completedAt: terminal.updatedAt
  });
  assert.equal((await new PostgresHunterMissionStore(b).get(terminal.missionId))?.result?.finalMessage, "done");
});

test("Hunter purchase and Writer execution adapters resume one PostgreSQL-backed x402 order", async () => {
  const run = (await a.admitRun({ ...runInput("adapter-payment"), scope: `${testScope}:adapter-payment` })).run;
  const serviceId = `${testScope}:adapter-auditor`;
  const requestHash = `0x${hash("adapter-request")}` as `0x${string}`;
  const idempotencyKey = `0x${hash("adapter-idempotency")}` as `0x${string}`;
  const request = {
    missionId: run.missionId,
    serviceId,
    offerVersion: "2",
    taskType: "smart-contract-audit",
    taskInput: "contract Example {}",
    timestamp: 1_900_000_000,
    expiresAt: 1_900_000_060,
    paymentNonce: `0x${hash("adapter-nonce")}` as `0x${string}`,
    asset: "0x1111111111111111111111111111111111111111" as `0x${string}`,
    amount: "500000000000000000",
    requestHash,
    idempotencyKey,
    locale: "en-US" as const
  };
  const service = {
    id: serviceId,
    name: "Adapter Auditor",
    description: "integration",
    endpoint: "http://127.0.0.1:3998",
    taskType: "smart-contract-audit",
    skills: ["audit-vulnerabilities-v1"],
    price: request.amount,
    currency: "U",
    asset: {
      chainId: 97, kind: "erc20" as const, address: request.asset, symbol: "U", decimals: 18
    },
    paymentRails: ["x402" as const],
    offerVersion: "2",
    network: "eip155:97",
    provider: "0x2222222222222222222222222222222222222222"
  };
  const selectedAccept = {
    scheme: "exact" as const,
    network: "eip155:97",
    asset: request.asset,
    payTo: service.provider as `0x${string}`,
    amount: request.amount,
    maxTimeoutSeconds: 60,
    extra: { name: "U", version: "1", assetTransferMethod: "permit2-exact" as const }
  };
  const purchaseStore = new PostgresX402PurchaseStore(a);
  const key = purchaseKey(run.missionId, serviceId);
  assert.equal(await purchaseStore.create(key, {
    service,
    request,
    requirement: {
      x402Version: 2,
      error: "payment required",
      resource: { url: "http://127.0.0.1:3998/execute/x402" },
      accepts: [selectedAccept]
    },
    selectedAccept
  }), true);
  assert.equal((await new PostgresX402PurchaseStore(b).get(key))?.service.id, serviceId);

  const executionStore = new PostgresX402ExecutionStore(b);
  assert.equal(await executionStore.beginSettlement({
    idempotencyKey,
    requestHash,
    serviceId,
    request,
    settlement: { state: "attempting", startedAt: request.timestamp },
    updatedAt: request.timestamp
  }), true);
  await assert.rejects(executionStore.beginSettlement({
    idempotencyKey,
    requestHash,
    serviceId: `${serviceId}:collision`,
    request: { ...request, serviceId: `${serviceId}:collision` },
    settlement: { state: "attempting", startedAt: request.timestamp },
    updatedAt: request.timestamp
  }), /duplicate key|unique constraint/i);
  const payment = {
    status: "payment-completed" as const,
    rail: "x402" as const,
    transaction: `0x${hash("adapter-transaction")}` as `0x${string}`,
    network: "eip155:97",
    payer: "0x3333333333333333333333333333333333333333" as `0x${string}`,
    recipient: service.provider as `0x${string}`,
    amount: { asset: service.asset, amount: request.amount },
    transferMethod: "permit2" as const
  };
  await executionStore.save({
    idempotencyKey, requestHash, serviceId, request, payment, updatedAt: request.timestamp + 1
  });
  const response = {
    result: "adapter report",
    receipt: {} as never,
    payment,
    requestHash,
    idempotencyKey,
    cached: false
  };
  await executionStore.save({
    idempotencyKey, requestHash, serviceId, request, payment, response,
    updatedAt: request.timestamp + 2
  });
  const restarted = await new PostgresX402ExecutionStore(a).get(idempotencyKey);
  assert.equal(restarted?.response?.result, "adapter report");
  const states = await poolA.query<{ purchase_state: string; execution_state: string }>(`
    SELECT p.state AS purchase_state, e.state AS execution_state
    FROM x402_purchases p JOIN x402_executions e ON e.purchase_id = p.purchase_id
    WHERE p.mission_id = $1 AND p.service_id = $2
  `, [run.missionId, serviceId]);
  assert.deepEqual(states.rows[0], { purchase_state: "completed", execution_state: "completed" });
});

test("Registry functions switch to PostgreSQL service leases without a file fallback", async () => {
  process.env.STORE_BACKEND = "postgres";
  process.env.DATABASE_URL = connectionString;
  const serviceId = `${testScope}:registry-adapter`;
  await registerDynamicService({
    agentId: "agent:registry-adapter",
    service: {
      id: serviceId,
      name: "Registry Adapter",
      description: "integration",
      endpoint: "http://127.0.0.1:3997",
      price: "1",
      currency: "U",
      network: "eip155:97",
      provider: "0x4444444444444444444444444444444444444444"
    },
    ttlSeconds: 30
  });
  assert.equal((await listDynamicServices()).some((service) => service.id === serviceId), true);
  delete process.env.STORE_BACKEND;
  delete process.env.DATABASE_URL;
});

test("external mission ids and agent feedback remain shared across replicas", async () => {
  const missionId = `${testScope}:seed-001`;
  const agentId = `${testScope}:agent`;
  await a.appendServiceFeedback({
    serviceId: `${testScope}:service`,
    agentId,
    missionId,
    value: 87,
    evidence: { taskType: "external-benchmark" },
    createdAt: new Date()
  });
  await b.appendServiceFeedback({
    serviceId: `${testScope}:service`,
    agentId,
    missionId,
    value: 88,
    evidence: { taskType: "external-benchmark", replay: true },
    createdAt: new Date()
  });
  const serviceFeedback = await b.listServiceFeedback(`${testScope}:service`);
  assert.equal(serviceFeedback.length, 1);
  assert.equal(serviceFeedback[0]?.missionId, missionId);
  assert.equal(serviceFeedback[0]?.value, 88);
  await a.appendAgentFeedback({
    agentId,
    reviewer: "integration-reviewer",
    value: 91,
    tags: ["replica"],
    text: "shared",
    createdAt: new Date()
  });
  const restarted = await b.listAgentFeedback(agentId);
  assert.equal(restarted.length, 1);
  assert.equal(restarted[0].text, "shared");
});

test("identity registration and Hunter memory survive a replica boundary", async () => {
  process.env.STORE_BACKEND = "postgres";
  process.env.DATABASE_URL = connectionString;
  const agentId = `${testScope}:persisted-agent`;
  await persistAgentIdentity({
    agentId,
    name: "Persisted Agent",
    description: "integration",
    walletAddress: "0x4444444444444444444444444444444444444444",
    capabilities: [],
    trustModels: ["receipt"],
    active: true,
    registeredAt: 1_900_000_000
  });
  assert.equal((await getPersistedAgentIdentity(agentId))?.name, "Persisted Agent");
  await persistAgentIdentity({
    agentId,
    name: "Persisted Agent Restarted",
    description: "integration restart",
    walletAddress: "0x4444444444444444444444444444444444444444",
    capabilities: [],
    trustModels: ["receipt"],
    active: true,
    registeredAt: 1_900_000_010
  });
  assert.equal((await getPersistedAgentIdentity(agentId))?.registeredAt, 1_900_000_000);
  assert.equal((await listPersistedAgentIdentities()).some((item) => item.agentId === agentId), true);

  const identityKey = `${testScope}:onchain`;
  await upsertOnchainIdentityRecord({
    key: identityKey,
    role: "hunter",
    registryAddress: "0x1111111111111111111111111111111111111111",
    chainId: 97,
    walletAddress: "0x2222222222222222222222222222222222222222",
    agentUri: "https://example.invalid/agent.json",
    txHash: `0x${hash("identity-transaction")}`,
    registeredAt: 1_900_000_000
  });
  assert.equal((await getOnchainIdentityRecord(identityKey))?.txHash, `0x${hash("identity-transaction")}`);

  const memoryMission = `${testScope}:memory`;
  await appendExperience({
    missionId: memoryMission,
    goal: "remember across replicas",
    serviceUsed: `${testScope}:service`,
    taskType: "integration",
    score: 99,
    lesson: "PostgreSQL is shared",
    timestamp: 1_900_000_000
  });
  assert.equal((await readExperiences()).some((item) => item.missionId === memoryMission), true);
  delete process.env.STORE_BACKEND;
  delete process.env.DATABASE_URL;
});
