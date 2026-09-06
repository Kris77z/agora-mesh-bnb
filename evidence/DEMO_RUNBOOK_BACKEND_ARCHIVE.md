# Agora Mesh demo runbook

Updated: 2026-09-03

This runbook uses frozen, already-confirmed BNB Testnet evidence. It does not create a new Authority or broadcast a transaction.

## Recording setup

1. Use a fresh browser profile at 1440×900 or larger and zoom 100%.
2. Record from the local stack until a dedicated deployment target is explicitly approved. Do not use or retry the removed Aliyun deployment or advertise an unverified tunnel URL.
3. Pre-open BscScan tabs for the grant, one Auditor payment, one Verifier payment and revoke transaction.
4. Confirm these endpoints return 200: `/`, `/marketplace`, `/compare`, `/advantage`, `/authority`, `/api/hunter/health`, `/api/hunter/authority`, `/api/registry/services`.
5. Do not expose `.env`, terminal history, API tokens, private keys, signatures or encrypted session records.

## Three-minute shot list

### 0:00–0:20 — thesis

Show the landing page and say:

> Most agent marketplaces still make the human choose and pay every provider. Agora Mesh lets Hunter become the buyer while its wallet remains bounded by the user.

### 0:20–0:45 — marketplace and decision

Open `/marketplace`, then `/compare`.

Point out that capability, reputation, price and latency are the same normalized inputs Hunter uses. Explain that Marketplace is a transparency layer, not a human shopping cart.

### 0:45–1:20 — autonomous paid execution

Open task `0eb3cf2c-0635-4809-beab-07c75693f7f0`.

Show the sequence: discover → rank → request-bound x402 quote → 0.5 U Auditor payment → signed audit result → 0.25 U independent Verifier payment → Slither-backed verdict.

Open these explorer links from the task:

- Auditor: `0x96fe0f6a5d247e37cf8c2d5c99a71a131f6a7df61ddc52c0aac707503327bf8c`
- Verifier: `0x91507121186f5005b9fcaf2e48140a109c515b7e298b219db1e4e301a770ce3d`

### 1:20–1:55 — bounded authority

Open `/authority` and show:

- status `REVOKED`;
- only Auditor and Verifier recipients;
- daily limit `2.25 U` and spent at revoke `2.25 U`;
- six confirmed service transactions;
- grant `0x52e19ca97d58d82f492869f43b8c11d1406134c86a7e37d5732932c825aff602`;
- session revoke `0xef88f75fbf3701e05c836bf2f5a5bec23c9c05af9a23ad804d8221ae0d5673e2`;
- Permit2 allowance revoke `0xbffd28346ddb0712fb34f99893f4159905a84f2ee37537e039bec3b7ee9feac4`;
- rejected post-revoke negative test and deleted session material.

Say that the user approved one bounded Authority, provisioned through backend transactions; Hunter made the six service payments within it and was rejected after revoke. This is archived backend/API evidence, not a demonstration of completed browser-wallet signing integration.

### 1:55–2:40 — Agent Advantage

Open `/advantage`.

- Experiment 1: 3/3 ground-truth bugs, independent Slither verifier, signed receipts.
- Experiment 2: independent RPC replay, exact 422-holder snapshot and executed 0.1 U PancakeSwap sellability test.
- Experiment 3: four paid services, `1.35 U` net, orphan settlement refunded and both Authorities revoked.

State the disclosure clearly: testnet U is nominal and not equated to USD; baseline operators are automated or independent AI, not mislabeled as human.

### 2:40–3:00 — close

Return to the landing page and say:

> Agora Mesh turns agent collaboration into auditable machine commerce: autonomous enough to buy, bounded enough to trust, and verifiable on BNB.

## Fallbacks

- If live RPC is slow, use the frozen task, Authority and Advantage pages; they remain backed by transaction hashes and checked artifacts.
- If a service is unavailable, do not simulate a new payment. Show the archived task and signed receipts.
- Record locally; add a public URL only after an independently approved deployment and fresh acceptance check. The former host is prohibited, not awaiting recovery.
- ERC-8004 registration is not part of this recording until a separate transaction is explicitly authorized and confirmed.

## Final checks

- `npm run verify` passes.
- Authority page shows exactly six stability payments totaling 2.25 U.
- No page claims an independent human review.
- Explorer links use BNB Testnet.
- Video stays under the event limit and contains no secrets.
