# Production PostgreSQL design

Status: architecture and local concurrency gate implemented. No production
environment is selected or contacted by this repository.

## Topology

The write path is a single PostgreSQL 15+ primary in one availability zone with
at least one streaming standby in a second zone. Use a managed multi-AZ service
where possible. The database endpoint must fail over to the promoted primary;
application processes do not choose a writer by inspecting replication state.

Hunter, Registry and each Service profile run two or more stateless API/worker
replicas behind a load balancer. Every replica shares the writer endpoint. Read
replicas may serve explicitly stale history views only; admission, leases,
Authority, x402, Registry availability and Outbox always use the writer.

Mutable application state includes Hunter runs, mission projections and memory;
x402 intents, executions and chain evidence; Authority public lifecycle state;
service leases and reputation; Agent identity/feedback; and ERC-8004 registration
state. Static catalogs and frozen experiment artifacts remain read-only files.
Session private keys remain outside PostgreSQL.

```text
Load balancer
  ├─ Hunter API/SSE x N ─┐
  ├─ Registry API x N ───┼─ pooler/writer endpoint ─ PostgreSQL primary
  └─ Service workers x N ┘                         └─ cross-AZ standby
                                                        └─ PITR archive
```

## Consistency contract

- Transactions use `READ COMMITTED`; rows that allocate work use
  `FOR UPDATE SKIP LOCKED`.
- `run_idempotency(scope,key_hash)` is the admission serialization point.
- Each lease takeover increments `fencing_token`. Event, renewal and terminal
  writes match the current owner and token, so a paused old worker cannot commit.
- `run_events(mission_id,sequence)` is the durable SSE cursor.
- `service_feedback(service_id,agent_id,mission_id)` is one logical review;
  retrying a lost HTTP response updates that review instead of inflating ranking.
- Canonical x402 idempotency hashes are globally unique in purchase and execution
  journals, so a key-only recovery lookup can never select another service's row.
- x402 payment confirmation, chain evidence and the corresponding Outbox row
  commit in one transaction. `settlement_uncertain` never goes back to quoted or
  settlement-attempting; a reconciliation operation supplies chain evidence.
- A confirmed chain transaction is linked to exactly one x402 execution. An
  execution cannot change transaction hash after payment, and another execution
  cannot reuse that transaction as its own settlement proof.
- Token amounts and block numbers cross the TypeScript boundary as decimal
  strings and persist as `NUMERIC(78,0)`.
- Database failure rejects admission, lease writes and payments. A cached history
  response must be marked stale and is never settlement evidence.

## Roles and secrets

- `agora_migrator`: owns schema objects and runs reviewed migrations only.
- `agora_runtime`: connect/schema usage plus table DML and sequence usage; no DDL,
  role creation, database creation, bypass-RLS or superuser rights.
- A separate backup/monitoring identity is provisioned by infrastructure, not by
  application environment files.
- Session private keys and full payment signatures never enter PostgreSQL.
  `authorities.encrypted_material_ref` accepts only an opaque `kms://`,
  `secret://` or `keychain://` reference.

All production connections require TLS certificate verification. Secrets are
injected by the target secret manager and rotated; the local compose passwords
are deliberately unusable as production defaults.

## Capacity and pooling

Start with an external transaction pooler or managed equivalent. Reserve
connections for migrations and operations, then calculate each process limit as:

```text
floor((database_max_connections - reserved_connections) / max_process_replicas)
```

The repository default of 8 is for local development, not a production target.
Alert on pool wait, statement timeout, lock timeout, deadlocks, long transactions,
lease takeover rate and Outbox age. Do not use session-level state on pooled
runtime connections.

## Availability, backup and recovery

- Initial target: database RPO <= 5 minutes, RTO <= 30 minutes.
- Continuous WAL archive/PITR and daily snapshots, retained per the target
  environment's compliance needs.
- Quarterly restore drill into an isolated database, including row counts,
  checksums and a read-only mission/payment evidence verification.
- Failover drill: stop the writer, verify endpoint promotion, ensure in-flight
  transactions fail and retry safely, wait for lease expiry, then confirm exactly
  one new fencing owner. Never automatically repeat an uncertain payment.

## Migration and rollback

Migrations are immutable, checksummed and serialized by an advisory lock. Runtime
startup checks the latest version but never applies DDL. For file-to-PostgreSQL
cutover: stop admission/workers, validate and back up JSON, import only public and
business state, reconcile counts/hashes/amount totals, start one replica, run a
no-spend test, then enable the second replica and takeover gate. Do not dual-write.

The repository implements that import as `npm run db:import:files`. It is dry-run
by default, rejects a non-empty target, and requires
`AGORA_FILE_IMPORT_CONFIRM=I_CONFIRM_FROZEN_FILE_IMPORT` to write. The entire
snapshot and its `file_imports` ledger row commit in one transaction. The Session
store is explicitly excluded; derived Hunter insights are rebuilt from imported
experiences. Reapplying the exact source digest verifies the immutable import
ledger without rewriting or confusing later runtime rows with the original baseline.

Rollback stops every worker and restores the frozen pre-cutover source. It must
not merge two independently advanced payment histories.

## What local Docker proves

`docker-compose.postgres.yml` runs one PostgreSQL writer. Two independent pools in
the 14-test integration suite model separate application replicas and prove database
serialization, leasing, fencing, identity/memory sharing and recovery semantics.
Two actual Hunter processes also passed shared-history, single-replica-stop and
process-restart checks against the imported snapshot; two Registry processes
passed cross-replica Agent registration/read. This does not prove
cross-zone database failover, WAL durability, provider DNS behavior or PITR;
those remain deployment-environment acceptance tests.
