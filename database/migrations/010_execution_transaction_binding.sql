-- Bind each confirmed settlement transaction to exactly one x402 execution.
-- Historical imports are backfilled from their payment evidence.

ALTER TABLE x402_executions
  ADD COLUMN settlement_transaction_id uuid
  REFERENCES chain_transactions(transaction_id) ON DELETE RESTRICT;

UPDATE x402_executions e
SET settlement_transaction_id = t.transaction_id
FROM chain_transactions t
WHERE e.payment_evidence->>'transaction' = t.tx_hash
  AND (e.payment_evidence->'amount'->'asset'->>'chainId')::bigint = t.chain_id;

CREATE UNIQUE INDEX x402_execution_settlement_transaction_idx
  ON x402_executions (settlement_transaction_id)
  WHERE settlement_transaction_id IS NOT NULL;
