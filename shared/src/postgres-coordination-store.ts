import { randomUUID } from "node:crypto";
import pg, { type PoolClient, type QueryResultRow } from "pg";

const { Pool } = pg;

export const POSTGRES_SCHEMA_VERSION = "010";

export interface PostgresStoreConfig {
  connectionString: string;
  applicationName: string;
  maxConnections?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}

export function createPostgresPool(config: PostgresStoreConfig): pg.Pool {
  return new Pool({
    connectionString: config.connectionString,
    application_name: config.applicationName,
    max: config.maxConnections ?? 8,
    statement_timeout: config.statementTimeoutMs ?? 15_000,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    options: `-c lock_timeout=${config.lockTimeoutMs ?? 3_000}`
  });
}

export async function assertPostgresSchemaCurrent(pool: pg.Pool): Promise<void> {
  const result = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1"
  );
  if (result.rows[0]?.version !== POSTGRES_SCHEMA_VERSION) {
    throw new Error(
      `PostgreSQL schema mismatch: expected ${POSTGRES_SCHEMA_VERSION}, found ${result.rows[0]?.version ?? "none"}`
    );
  }
}

export class StaleLeaseError extends Error {
  constructor(missionId: string) {
    super(`Run lease is missing, expired, or fenced for mission ${missionId}`);
    this.name = "StaleLeaseError";
  }
}

export interface PostgresRun {
  missionId: string;
  scope: string;
  ownerId: string;
  goal: string;
  requestMode: "single" | "scripted" | "react" | "commander";
  locale: string;
  requestHash: string;
  status: "created" | "running" | "completed" | "failed" | "cancelled";
  result?: unknown;
  error?: unknown;
  cancelRequested: boolean;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  fencingToken: string;
  version: string;
  createdAt: string;
  updatedAt: string;
}

export type PostgresRunAdmission =
  | { kind: "created" | "replay"; run: PostgresRun }
  | { kind: "conflict"; run: PostgresRun };

interface RunRow extends QueryResultRow {
  mission_id: string;
  scope: string;
  owner_id: string;
  goal: string;
  request_mode: PostgresRun["requestMode"];
  locale: string;
  request_hash: string;
  status: PostgresRun["status"];
  result: unknown | null;
  error: unknown | null;
  cancel_requested: boolean;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  fencing_token: string;
  version: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertUintString(name: string, value: string | undefined): void {
  if (value !== undefined && !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${name} must be an unsigned base-10 integer string`);
  }
}

function mapRun(row: RunRow): PostgresRun {
  return {
    missionId: row.mission_id,
    scope: row.scope,
    ownerId: row.owner_id,
    goal: row.goal,
    requestMode: row.request_mode,
    locale: row.locale,
    requestHash: row.request_hash,
    status: row.status,
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.error === null ? {} : { error: row.error }),
    cancelRequested: row.cancel_requested,
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: iso(row.lease_expires_at) }),
    fencingToken: row.fencing_token,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

async function inTransaction<T>(pool: pg.Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface PurchaseInput {
  purchaseId?: string;
  missionId: string;
  serviceId: string;
  idempotencyKeyHash: string;
  requestHash: string;
  chainId: number;
  assetKind: "native" | "erc20";
  assetAddress?: string;
  assetSymbol: string;
  assetDecimals: number;
  amount: string;
  recipient: string;
  request: unknown;
  requirement: unknown;
  selectedAccept: unknown;
  service?: unknown;
}

export interface ChainTransactionInput {
  transactionId?: string;
  chainId: number;
  txHash: string;
  purpose: string;
  fromAddress?: string;
  toAddress?: string;
  assetAddress?: string;
  amount?: string;
  calldataHash?: string;
  blockNumber?: string;
  blockHash?: string;
  confirmations?: number;
  metadata?: unknown;
}

export class PostgresCoordinationStore {
  constructor(readonly pool: pg.Pool) {}

  async admitRun(input: {
    scope: string;
    keyHash: string;
    requestHash: string;
    ownerId: string;
    goal: string;
    requestMode: PostgresRun["requestMode"];
    locale: string;
    missionId?: string;
  }): Promise<PostgresRunAdmission> {
    return inTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${input.scope}:${input.keyHash}`
      ]);
      const existing = await client.query<RunRow>(`
        SELECT r.* FROM run_idempotency i
        JOIN runs r ON r.mission_id = i.mission_id
        WHERE i.scope = $1 AND i.key_hash = $2
      `, [input.scope, input.keyHash]);
      if (existing.rowCount) {
        const run = mapRun(existing.rows[0]);
        return { kind: run.requestHash === input.requestHash ? "replay" : "conflict", run };
      }
      const missionId = input.missionId ?? randomUUID();
      const inserted = await client.query<RunRow>(`
        INSERT INTO runs (
          mission_id, scope, owner_id, goal, request_mode, locale, request_hash
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [
        missionId, input.scope, input.ownerId, input.goal,
        input.requestMode, input.locale, input.requestHash
      ]);
      await client.query(`
        INSERT INTO run_idempotency(scope, key_hash, mission_id, request_hash)
        VALUES ($1, $2, $3, $4)
      `, [input.scope, input.keyHash, missionId, input.requestHash]);
      return { kind: "created", run: mapRun(inserted.rows[0]) };
    });
  }

  async getRun(missionId: string): Promise<PostgresRun | undefined> {
    const result = await this.pool.query<RunRow>("SELECT * FROM runs WHERE mission_id = $1", [missionId]);
    return result.rows[0] ? mapRun(result.rows[0]) : undefined;
  }

  async claimRuns(scope: string, workerId: string, limit: number, leaseMs: number): Promise<PostgresRun[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("claim limit must be 1-100");
    if (!Number.isInteger(leaseMs) || leaseMs < 100) throw new Error("leaseMs must be at least 100");
    const result = await this.pool.query<RunRow>(`
      WITH candidates AS (
        SELECT mission_id
        FROM runs
        WHERE scope = $1
          AND (status = 'created'
            OR (status = 'running' AND lease_expires_at <= clock_timestamp()))
        ORDER BY created_at, mission_id
        FOR UPDATE SKIP LOCKED
        LIMIT $3
      )
      UPDATE runs r
      SET status = 'running',
          lease_owner = $2,
          lease_expires_at = clock_timestamp() + ($4::double precision * interval '1 millisecond'),
          fencing_token = r.fencing_token + 1,
          version = r.version + 1,
          updated_at = clock_timestamp()
      FROM candidates c
      WHERE r.mission_id = c.mission_id
      RETURNING r.*
    `, [scope, workerId, limit, leaseMs]);
    return result.rows.map(mapRun);
  }

  async claimRun(scope: string, missionId: string, workerId: string, leaseMs: number): Promise<PostgresRun | undefined> {
    if (!Number.isInteger(leaseMs) || leaseMs < 100) throw new Error("leaseMs must be at least 100");
    const result = await this.pool.query<RunRow>(`
      UPDATE runs
      SET status = 'running',
          lease_owner = $3,
          lease_expires_at = clock_timestamp() + ($4::double precision * interval '1 millisecond'),
          fencing_token = fencing_token + 1,
          version = version + 1,
          updated_at = clock_timestamp()
      WHERE scope = $1 AND mission_id = $2
        AND (status = 'created'
          OR (status = 'running' AND lease_expires_at <= clock_timestamp()))
      RETURNING *
    `, [scope, missionId, workerId, leaseMs]);
    return result.rows[0] ? mapRun(result.rows[0]) : undefined;
  }

  async renewRunLease(missionId: string, workerId: string, fencingToken: string, leaseMs: number): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE runs
      SET lease_expires_at = clock_timestamp() + ($4::double precision * interval '1 millisecond'),
          version = version + 1,
          updated_at = clock_timestamp()
      WHERE mission_id = $1 AND status = 'running'
        AND lease_owner = $2 AND fencing_token = $3
        AND cancel_requested = false
        AND lease_expires_at > clock_timestamp()
    `, [missionId, workerId, fencingToken, leaseMs]);
    return result.rowCount === 1;
  }

  async appendRunEvent(input: {
    missionId: string;
    workerId: string;
    fencingToken: string;
    eventType: string;
    payload: unknown;
  }): Promise<string> {
    return inTransaction(this.pool, async (client) => {
      const updated = await client.query<{ sequence: string }>(`
        UPDATE runs
        SET next_event_sequence = next_event_sequence + 1,
            version = version + 1,
            updated_at = clock_timestamp()
        WHERE mission_id = $1 AND status = 'running'
          AND lease_owner = $2 AND fencing_token = $3
          AND cancel_requested = false
          AND lease_expires_at > clock_timestamp()
        RETURNING (next_event_sequence - 1)::text AS sequence
      `, [input.missionId, input.workerId, input.fencingToken]);
      if (!updated.rowCount) throw new StaleLeaseError(input.missionId);
      const sequence = updated.rows[0].sequence;
      await client.query(`
        INSERT INTO run_events(mission_id, sequence, event_type, payload, fencing_token)
        VALUES ($1, $2, $3, $4::jsonb, $5)
      `, [
        input.missionId, sequence, input.eventType,
        JSON.stringify(input.payload ?? null), input.fencingToken
      ]);
      return sequence;
    });
  }

  async listRunEvents(missionId: string, afterSequence = "0"): Promise<Array<{
    sequence: string;
    eventType: string;
    payload: unknown;
    occurredAt: string;
  }>> {
    const result = await this.pool.query<{
      sequence: string;
      event_type: string;
      payload: unknown;
      occurred_at: Date | string;
    }>(`
      SELECT sequence::text, event_type, payload, occurred_at
      FROM run_events
      WHERE mission_id = $1 AND sequence > $2
      ORDER BY sequence
    `, [missionId, afterSequence]);
    return result.rows.map((row) => ({
      sequence: row.sequence,
      eventType: row.event_type,
      payload: row.payload,
      occurredAt: iso(row.occurred_at)
    }));
  }

  async finishRun(input: {
    missionId: string;
    workerId: string;
    fencingToken: string;
    status: "completed" | "failed" | "cancelled";
    result?: unknown;
    error?: unknown;
  }): Promise<PostgresRun> {
    const result = await this.pool.query<RunRow>(`
      UPDATE runs
      SET status = $4,
          result = $5::jsonb,
          error = $6::jsonb,
          lease_owner = NULL,
          lease_expires_at = NULL,
          version = version + 1,
          updated_at = clock_timestamp()
      WHERE mission_id = $1 AND status = 'running'
        AND lease_owner = $2 AND fencing_token = $3
        AND (cancel_requested = false OR $4 = 'cancelled')
        AND lease_expires_at > clock_timestamp()
      RETURNING *
    `, [
      input.missionId, input.workerId, input.fencingToken, input.status,
      input.result === undefined ? null : JSON.stringify(input.result),
      input.error === undefined ? null : JSON.stringify(input.error)
    ]);
    if (!result.rowCount) throw new StaleLeaseError(input.missionId);
    return mapRun(result.rows[0]);
  }

  async requestRunCancellation(missionId: string): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE runs SET cancel_requested = true, version = version + 1, updated_at = clock_timestamp()
      WHERE mission_id = $1 AND status IN ('created', 'running')
    `, [missionId]);
    return result.rowCount === 1;
  }

  async listRunIdempotency(missionId: string): Promise<{ keyHash: string; requestHash: string } | undefined> {
    const result = await this.pool.query<{ key_hash: string; request_hash: string }>(`
      SELECT key_hash, request_hash FROM run_idempotency WHERE mission_id = $1
    `, [missionId]);
    return result.rows[0] ? {
      keyHash: result.rows[0].key_hash,
      requestHash: result.rows[0].request_hash
    } : undefined;
  }

  async createPurchase(input: PurchaseInput): Promise<{ created: boolean; purchaseId: string }> {
    assertUintString("purchase amount", input.amount);
    const purchaseId = input.purchaseId ?? randomUUID();
    const result = await this.pool.query<{ purchase_id: string }>(`
      INSERT INTO x402_purchases (
        purchase_id, mission_id, service_id, idempotency_key_hash, request_hash,
        chain_id, asset_kind, asset_address, asset_symbol, asset_decimals,
        amount, recipient, request, requirement, selected_accept, service
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb
      )
      ON CONFLICT (mission_id, service_id) DO NOTHING
      RETURNING purchase_id
    `, [
      purchaseId, input.missionId, input.serviceId, input.idempotencyKeyHash,
      input.requestHash, input.chainId, input.assetKind, input.assetAddress ?? null,
      input.assetSymbol, input.assetDecimals, input.amount, input.recipient,
      JSON.stringify(input.request), JSON.stringify(input.requirement), JSON.stringify(input.selectedAccept),
      JSON.stringify(input.service ?? {})
    ]);
    if (result.rowCount) return { created: true, purchaseId: result.rows[0].purchase_id };
    const existing = await this.pool.query<{ purchase_id: string; request_hash: string }>(`
      SELECT purchase_id, request_hash FROM x402_purchases
      WHERE mission_id = $1 AND service_id = $2
    `, [input.missionId, input.serviceId]);
    if (!existing.rowCount || existing.rows[0].request_hash !== input.requestHash) {
      throw new Error("x402 purchase idempotency conflict");
    }
    return { created: false, purchaseId: existing.rows[0].purchase_id };
  }

  async beginExecutionSettlement(input: {
    executionId?: string;
    serviceId: string;
    idempotencyKeyHash: string;
    requestHash: string;
    purchaseId?: string;
    request: unknown;
  }): Promise<boolean> {
    const result = await this.pool.query(`
      INSERT INTO x402_executions (
        execution_id, service_id, idempotency_key_hash, request_hash, purchase_id, request
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (service_id, idempotency_key_hash) DO NOTHING
    `, [
      input.executionId ?? randomUUID(), input.serviceId, input.idempotencyKeyHash,
      input.requestHash, input.purchaseId ?? null, JSON.stringify(input.request)
    ]);
    return result.rowCount === 1;
  }

  async markSettlementUncertain(serviceId: string, idempotencyKeyHash: string, error: string): Promise<boolean> {
    return inTransaction(this.pool, async (client) => {
      const updated = await client.query<{ purchase_id: string | null }>(`
        UPDATE x402_executions
        SET state = 'settlement_uncertain', last_error = $3, updated_at = clock_timestamp()
        WHERE service_id = $1 AND idempotency_key_hash = $2
          AND state = 'settlement_attempting'
        RETURNING purchase_id
      `, [serviceId, idempotencyKeyHash, error]);
      if (!updated.rowCount) return false;
      if (updated.rows[0].purchase_id) {
        await client.query(`
          UPDATE x402_purchases SET state = 'settlement_uncertain', updated_at = clock_timestamp()
          WHERE purchase_id = $1 AND state IN ('quoted', 'settlement_attempting')
        `, [updated.rows[0].purchase_id]);
      }
      return true;
    });
  }

  async recordConfirmedPayment(input: {
    serviceId: string;
    idempotencyKeyHash: string;
    paymentEvidence: unknown;
    transaction: ChainTransactionInput;
  }): Promise<{ transactionId: string; replay: boolean }> {
    assertUintString("transaction amount", input.transaction.amount);
    assertUintString("transaction block number", input.transaction.blockNumber);
    return inTransaction(this.pool, async (client) => {
      const execution = await client.query<{
        execution_id: string;
        purchase_id: string | null;
        state: string;
        payment_evidence: unknown | null;
        settlement_transaction_id: string | null;
      }>(`
        SELECT execution_id, purchase_id, state, payment_evidence, settlement_transaction_id
        FROM x402_executions
        WHERE service_id = $1 AND idempotency_key_hash = $2
        FOR UPDATE
      `, [input.serviceId, input.idempotencyKeyHash]);
      if (!execution.rowCount) throw new Error("x402 execution does not exist");
      const replay = ["paid", "execution_pending", "completed"].includes(execution.rows[0].state);
      const transactionId = input.transaction.transactionId ?? randomUUID();
      const tx = await client.query<{
        transaction_id: string;
        from_address: string | null;
        to_address: string | null;
        asset_address: string | null;
        amount: string | null;
      }>(`
        INSERT INTO chain_transactions (
          transaction_id, chain_id, tx_hash, purpose, from_address, to_address,
          asset_address, amount, calldata_hash, block_number, block_hash,
          status, confirmations, metadata, confirmed_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          'confirmed', $12, $13::jsonb, clock_timestamp()
        )
        ON CONFLICT (chain_id, tx_hash) DO UPDATE
          SET confirmations = GREATEST(chain_transactions.confirmations, EXCLUDED.confirmations)
        RETURNING transaction_id, from_address, to_address, asset_address, amount::text
      `, [
        transactionId, input.transaction.chainId, input.transaction.txHash,
        input.transaction.purpose, input.transaction.fromAddress ?? null,
        input.transaction.toAddress ?? null, input.transaction.assetAddress ?? null,
        input.transaction.amount ?? null, input.transaction.calldataHash ?? null,
        input.transaction.blockNumber ?? null, input.transaction.blockHash ?? null,
        input.transaction.confirmations ?? 0,
        JSON.stringify(input.transaction.metadata ?? {})
      ]);
      const transaction = tx.rows[0];
      const sameOptionalAddress = (actual: string | null, expected: string | undefined) =>
        expected === undefined || actual?.toLowerCase() === expected.toLowerCase();
      if (
        !sameOptionalAddress(transaction.from_address, input.transaction.fromAddress) ||
        !sameOptionalAddress(transaction.to_address, input.transaction.toAddress) ||
        !sameOptionalAddress(transaction.asset_address, input.transaction.assetAddress) ||
        (input.transaction.amount !== undefined && transaction.amount !== input.transaction.amount)
      ) {
        throw new Error("Chain transaction is already bound to conflicting payment evidence");
      }
      if (
        execution.rows[0].settlement_transaction_id &&
        execution.rows[0].settlement_transaction_id !== transaction.transaction_id
      ) {
        throw new Error("x402 execution is already bound to a different settlement transaction");
      }
      if (!replay) {
        await client.query(`
          UPDATE x402_executions
          SET state = 'paid', payment_evidence = $3::jsonb, last_error = NULL,
              settlement_transaction_id = $4,
              updated_at = clock_timestamp()
          WHERE service_id = $1 AND idempotency_key_hash = $2
            AND state IN ('settlement_attempting', 'settlement_uncertain')
        `, [
          input.serviceId, input.idempotencyKeyHash,
          JSON.stringify(input.paymentEvidence), transaction.transaction_id
        ]);
        if (execution.rows[0].purchase_id) {
          await client.query(`
            UPDATE x402_purchases
            SET state = 'paid', payment_evidence = $2::jsonb, updated_at = clock_timestamp()
            WHERE purchase_id = $1
              AND state IN ('quoted', 'settlement_attempting', 'settlement_uncertain')
          `, [execution.rows[0].purchase_id, JSON.stringify(input.paymentEvidence)]);
        }
      } else if (!execution.rows[0].settlement_transaction_id) {
        await client.query(`
          UPDATE x402_executions SET settlement_transaction_id = $3
          WHERE service_id = $1 AND idempotency_key_hash = $2
            AND settlement_transaction_id IS NULL
        `, [input.serviceId, input.idempotencyKeyHash, transaction.transaction_id]);
      }
      await client.query(`
        INSERT INTO outbox(aggregate_type, aggregate_id, topic, payload, dedupe_key)
        VALUES ('x402_execution', $1, 'x402.payment.confirmed', $2::jsonb, $3)
        ON CONFLICT (dedupe_key) DO NOTHING
      `, [
        execution.rows[0].execution_id,
        JSON.stringify({
          serviceId: input.serviceId,
          idempotencyKeyHash: input.idempotencyKeyHash,
          transactionId: transaction.transaction_id
        }),
        `x402-payment-confirmed:${execution.rows[0].execution_id}`
      ]);
      return { transactionId: transaction.transaction_id, replay };
    });
  }

  async listX402ExecutionEvidence(serviceIds?: string[]): Promise<Array<{
    serviceId: string;
    idempotencyKeyHash: string;
    requestHash: string;
    request: unknown;
    payment?: unknown;
    response?: unknown;
    state: string;
    updatedAt: string;
  }>> {
    const result = await this.pool.query<{
      service_id: string;
      idempotency_key_hash: string;
      request_hash: string;
      request: unknown;
      payment_evidence: unknown | null;
      response: unknown | null;
      state: string;
      updated_at: Date | string;
    }>(`
      SELECT service_id, idempotency_key_hash, request_hash, request,
             payment_evidence, response, state, updated_at
      FROM x402_executions
      WHERE ($1::text[] IS NULL OR service_id = ANY($1))
      ORDER BY updated_at, execution_id
    `, [serviceIds?.length ? serviceIds : null]);
    return result.rows.map((row) => ({
      serviceId: row.service_id,
      idempotencyKeyHash: row.idempotency_key_hash,
      requestHash: row.request_hash,
      request: row.request,
      ...(row.payment_evidence === null ? {} : { payment: row.payment_evidence }),
      ...(row.response === null ? {} : { response: row.response }),
      state: row.state,
      updatedAt: iso(row.updated_at)
    }));
  }

  async latestConfirmedX402Payment(serviceIds?: string[]): Promise<{
    transaction: string;
    timestamp: number;
  } | undefined> {
    const result = await this.pool.query<{
      transaction: string;
      updated_at: Date | string;
    }>(`
      SELECT payment_evidence->>'transaction' AS transaction, updated_at
      FROM x402_executions
      WHERE payment_evidence->>'transaction' ~ '^0x[0-9A-Fa-f]{64}$'
        AND ($1::text[] IS NULL OR service_id = ANY($1))
      ORDER BY updated_at DESC, execution_id DESC
      LIMIT 1
    `, [serviceIds?.length ? serviceIds : null]);
    const row = result.rows[0];
    return row ? {
      transaction: row.transaction,
      timestamp: Math.floor(new Date(row.updated_at).getTime() / 1_000)
    } : undefined;
  }

  async upsertServiceLease(input: {
    serviceId: string;
    agentId: string;
    endpoint: string;
    capability: unknown;
    ttlMs: number;
    runtimeAvailable?: boolean;
  }): Promise<void> {
    await this.pool.query(`
      INSERT INTO service_leases (
        service_id, agent_id, endpoint, capability, runtime_available, expires_at
      ) VALUES ($1, $2, $3, $4::jsonb, $5, clock_timestamp() + ($6::double precision * interval '1 millisecond'))
      ON CONFLICT (service_id) DO UPDATE SET
        agent_id = EXCLUDED.agent_id,
        endpoint = EXCLUDED.endpoint,
        capability = EXCLUDED.capability,
        runtime_available = EXCLUDED.runtime_available,
        expires_at = EXCLUDED.expires_at,
        version = service_leases.version + 1,
        updated_at = clock_timestamp()
    `, [
      input.serviceId, input.agentId, input.endpoint, JSON.stringify(input.capability),
      input.runtimeAvailable ?? true, input.ttlMs
    ]);
  }

  async listAvailableServices(): Promise<Array<{ serviceId: string; capability: unknown }>> {
    const result = await this.pool.query<{ service_id: string; capability: unknown }>(`
      SELECT service_id, capability FROM service_leases
      WHERE runtime_available = true AND expires_at > clock_timestamp()
      ORDER BY service_id
    `);
    return result.rows.map((row) => ({ serviceId: row.service_id, capability: row.capability }));
  }

  async appendServiceFeedback(input: {
    feedbackId?: string;
    serviceId: string;
    agentId: string;
    missionId: string;
    value: number;
    evidence: unknown;
    createdAt: string | Date;
  }): Promise<string> {
    const feedbackId = input.feedbackId ?? randomUUID();
    const result = await this.pool.query<{ feedback_id: string }>(`
      INSERT INTO service_feedback (
        feedback_id, service_id, agent_id, mission_id, value, evidence, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      ON CONFLICT (service_id, agent_id, mission_id) DO UPDATE SET
        value = EXCLUDED.value,
        evidence = EXCLUDED.evidence,
        created_at = EXCLUDED.created_at
      RETURNING feedback_id
    `, [
      feedbackId, input.serviceId, input.agentId, input.missionId, input.value,
      JSON.stringify(input.evidence), input.createdAt
    ]);
    return result.rows[0].feedback_id;
  }

  async listServiceFeedback(serviceId?: string): Promise<Array<{
    feedbackId: string;
    serviceId: string;
    agentId: string;
    missionId: string;
    value: number;
    evidence: unknown;
    createdAt: string;
  }>> {
    const result = await this.pool.query<{
      feedback_id: string;
      service_id: string;
      agent_id: string;
      mission_id: string;
      value: number;
      evidence: unknown;
      created_at: Date | string;
    }>(`
      SELECT feedback_id, service_id, agent_id, mission_id, value, evidence, created_at
      FROM service_feedback
      WHERE ($1::text IS NULL OR service_id = $1)
      ORDER BY created_at, feedback_id
    `, [serviceId ?? null]);
    return result.rows.map((row) => ({
      feedbackId: row.feedback_id,
      serviceId: row.service_id,
      agentId: row.agent_id,
      missionId: row.mission_id,
      value: row.value,
      evidence: row.evidence,
      createdAt: iso(row.created_at)
    }));
  }

  async appendAgentFeedback(input: {
    feedbackId?: string;
    agentId: string;
    reviewer: string;
    value: number;
    tags: string[];
    text?: string;
    createdAt: string | Date;
  }): Promise<string> {
    const feedbackId = input.feedbackId ?? randomUUID();
    await this.pool.query(`
      INSERT INTO agent_feedback (
        feedback_id, agent_id, reviewer, value, tags, text, created_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
    `, [
      feedbackId, input.agentId, input.reviewer, input.value,
      JSON.stringify(input.tags), input.text ?? null, input.createdAt
    ]);
    return feedbackId;
  }

  async listAgentFeedback(agentId: string): Promise<Array<{
    feedbackId: string;
    agentId: string;
    reviewer: string;
    value: number;
    tags: string[];
    text?: string;
    createdAt: string;
  }>> {
    const result = await this.pool.query<{
      feedback_id: string;
      agent_id: string;
      reviewer: string;
      value: number;
      tags: string[];
      text: string | null;
      created_at: Date | string;
    }>(`
      SELECT feedback_id, agent_id, reviewer, value, tags, text, created_at
      FROM agent_feedback
      WHERE agent_id = $1
      ORDER BY created_at, feedback_id
    `, [agentId]);
    return result.rows.map((row) => ({
      feedbackId: row.feedback_id,
      agentId: row.agent_id,
      reviewer: row.reviewer,
      value: row.value,
      tags: row.tags,
      ...(row.text === null ? {} : { text: row.text }),
      createdAt: iso(row.created_at)
    }));
  }

  async saveAuthority(input: {
    authorityId: string;
    walletAddress: string;
    sessionPublicKey: string;
    chainId: number;
    allowedCalls: unknown;
    spendLimits: unknown;
    expiresAt: string | Date;
    status: "active" | "expired" | "revoked" | "invalid";
    encryptedMaterialRef?: string;
  }): Promise<void> {
    if (input.encryptedMaterialRef && !/^(kms|secret|keychain):\/\/[A-Za-z0-9._:/@-]+$/.test(input.encryptedMaterialRef)) {
      throw new Error("Authority material must be an opaque KMS, secret-manager, or keychain reference");
    }
    await this.pool.query(`
      INSERT INTO authorities (
        authority_id, wallet_address, session_public_key, chain_id,
        allowed_calls, spend_limits, expires_at, status, encrypted_material_ref
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
      ON CONFLICT (authority_id) DO UPDATE SET
        wallet_address = EXCLUDED.wallet_address,
        session_public_key = EXCLUDED.session_public_key,
        chain_id = EXCLUDED.chain_id,
        allowed_calls = EXCLUDED.allowed_calls,
        spend_limits = EXCLUDED.spend_limits,
        expires_at = EXCLUDED.expires_at,
        status = EXCLUDED.status,
        encrypted_material_ref = EXCLUDED.encrypted_material_ref,
        updated_at = clock_timestamp()
    `, [
      input.authorityId, input.walletAddress, input.sessionPublicKey, input.chainId,
      JSON.stringify(input.allowedCalls), JSON.stringify(input.spendLimits), input.expiresAt,
      input.status, input.encryptedMaterialRef ?? null
    ]);
  }

  async recordAuthorityStep(input: {
    authorityId: string;
    step: "grantSession" | "approveChecker" | "approveAllowance" |
      "revokeChecker" | "revokeAllowance" | "revokeSession";
    attempt: number;
    state: "pending" | "broadcast" | "confirmed" | "failed" | "uncertain";
    publicEvidence?: unknown;
  }): Promise<boolean> {
    const result = await this.pool.query(`
      INSERT INTO authority_steps (
        authority_id, step, attempt, state, public_evidence,
        completed_at
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb,
        CASE WHEN $4 IN ('confirmed', 'failed') THEN clock_timestamp() ELSE NULL END
      )
      ON CONFLICT (authority_id, step, attempt) DO NOTHING
    `, [
      input.authorityId, input.step, input.attempt, input.state,
      JSON.stringify(input.publicEvidence ?? {})
    ]);
    return result.rowCount === 1;
  }

  async enqueueOutbox(input: {
    aggregateType: string;
    aggregateId: string;
    topic: string;
    payload: unknown;
    dedupeKey: string;
  }): Promise<boolean> {
    const result = await this.pool.query(`
      INSERT INTO outbox(aggregate_type, aggregate_id, topic, payload, dedupe_key)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      ON CONFLICT (dedupe_key) DO NOTHING
    `, [
      input.aggregateType, input.aggregateId, input.topic,
      JSON.stringify(input.payload), input.dedupeKey
    ]);
    return result.rowCount === 1;
  }

  async claimOutbox(workerId: string, limit: number, leaseMs: number): Promise<Array<{
    id: string;
    topic: string;
    payload: unknown;
    dedupeKey: string;
    attempts: number;
  }>> {
    const result = await this.pool.query<{
      id: string;
      topic: string;
      payload: unknown;
      dedupe_key: string;
      attempts: number;
    }>(`
      WITH candidates AS (
        SELECT id FROM outbox
        WHERE published_at IS NULL
          AND available_at <= clock_timestamp()
          AND (locked_until IS NULL OR locked_until <= clock_timestamp())
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT $2
      )
      UPDATE outbox o
      SET locked_by = $1,
          locked_until = clock_timestamp() + ($3::double precision * interval '1 millisecond'),
          attempts = o.attempts + 1
      FROM candidates c
      WHERE o.id = c.id
      RETURNING o.id::text, o.topic, o.payload, o.dedupe_key, o.attempts
    `, [workerId, limit, leaseMs]);
    return result.rows.map((row) => ({
      id: row.id,
      topic: row.topic,
      payload: row.payload,
      dedupeKey: row.dedupe_key,
      attempts: row.attempts
    }));
  }

  async markOutboxPublished(id: string, workerId: string): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE outbox
      SET published_at = clock_timestamp(), locked_by = NULL, locked_until = NULL, last_error = NULL
      WHERE id = $1 AND locked_by = $2 AND published_at IS NULL
    `, [id, workerId]);
    return result.rowCount === 1;
  }

  async markOutboxFailed(id: string, workerId: string, error: string, retryMs: number): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE outbox
      SET locked_by = NULL, locked_until = NULL, last_error = $3,
          available_at = clock_timestamp() + ($4::double precision * interval '1 millisecond')
      WHERE id = $1 AND locked_by = $2 AND published_at IS NULL
    `, [id, workerId, error, retryMs]);
    return result.rowCount === 1;
  }
}
