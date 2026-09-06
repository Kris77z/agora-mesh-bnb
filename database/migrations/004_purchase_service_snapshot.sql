-- Hunter must be able to resume an original purchase after restart even if the
-- live Registry offer changes or disappears.

ALTER TABLE x402_purchases ADD COLUMN service jsonb NOT NULL DEFAULT '{}'::jsonb;
