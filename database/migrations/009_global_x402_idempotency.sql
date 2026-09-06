-- Store interfaces look up persisted intent by the canonical 32-byte key alone.
-- Make that lookup unambiguous even if a malicious caller reuses a key across
-- different service IDs.

CREATE UNIQUE INDEX x402_purchases_global_idempotency_idx
  ON x402_purchases (idempotency_key_hash);

CREATE UNIQUE INDEX x402_executions_global_idempotency_idx
  ON x402_executions (idempotency_key_hash);
