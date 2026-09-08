# Agora Mesh — submission draft

Updated: 2026-09-06

This file contains reviewable submission copy derived from the implemented product and frozen evidence. Fields marked `OWNER INPUT` must not be invented or submitted by an automated agent.

## Project

**Name:** Agora Mesh — Autonomous Agent Economy on BNB

**Tagline:** Give one bounded goal; Hunter discovers, compares, hires, pays, and verifies specialist agents on BNB.

**Short description:**

Agora Mesh is a security-first agent marketplace where the AI agent is the buyer. A user grants Hunter one time-limited, recipient-allowlisted and spend-capped Authority. Hunter then discovers specialist services, ranks them on capability, reputation, price and latency, pays them through request-bound x402, verifies their signed results with an independent agent, and returns an auditable report with BNB Testnet transaction evidence. The user can revoke the Authority at any time, after which payments fail closed.

**Problem:**

Most agent marketplaces still make humans coordinate every provider and payment, while autonomous wallets often ask users to trust a broad private key. This leaves a gap between useful multi-agent automation and safe economic agency.

**Solution:**

Agora Mesh separates the admin wallet from a disposable session signer and enforces an onchain allowlist, token cap, expiry and revoke path. Service quotes bind the request hash, asset, amount, recipient, chain and deadline. Auditor and Verifier use separate identities and wallets. Task traces expose selection, settlement, signed results and verification outcomes. The local product includes grant/revoke controls, but uninterrupted self-service completion remains unverified.

## What is implemented

- BNB Smart Chain Testnet is the default network; Monad remains a legacy preset.
- Marketplace discovery, deterministic ranking, Agent detail, Compare, task trace and reputation evidence.
- Altana scoped Authority with separate session signer, allowlisted recipients, `$U` cap, expiry and onchain revoke.
- Request-bound x402 settlement with durable idempotency, original-request replay, and fail-closed handling of uncertain payments. Fresh 2026-09-04 offer-v2 acceptance settled 1.15 U across Auditor, Verifier and Sentinel; one stalled Auditor delivery was recovered against the original settlement without a second debit.
- Independent Security Auditor, Slither-backed Verification Agent, Onchain Investigator and risk replay service.
- Three measured Agent Advantage experiments with immutable raw inputs/outputs, timings, costs, quality rubrics and reviewer provenance.
- Full 422-holder block-locked snapshot, PancakeSwap V2/V3 evidence and an executed `0.1 U` sellability test with 5% maximum slippage and final router allowance zero.
- Three consecutive fresh paid audit runs under one 24-hour / 2.25 U Authority, followed immediately by revoke and a rejected post-revoke payment.

## Current delivery boundary

The first local Passkey lifecycle is complete: user device grant, a 0.75 U Auditor/Verifier task started by the operator through the scoped API, original-order delivery recovery, user device revoke and confirmed encrypted Session deletion. Final rejected-key verification ran after the original expiry. This is not a fully self-service or uninterrupted browser run; three fresh browser runs remain outstanding (0/3) and are paused at the owner’s request because local execution is unstable. Historical backend/API runs do not replace them. Public deployment is deferred because no dedicated backend host is available. Vercel/Cloudflare frontend hosting alone does not deploy the current long-running Slither/Agent backend.

## Submission status

This is a working prototype with historical onchain evidence, not a certified publicly usable submission. Local browser acceptance is paused; public deployment, uploaded video and final public source revision remain outstanding. Altana Explorer indexed display for both smart accounts was visually accepted on 2026-09-06 (`evidence/altana-explorer/INDEXED_DISPLAY_ACCEPTANCE.md`). The latest live-offer probes found Auditor and Sentinel available. A requirement-driven provider switch is now demonstrated on the live ranking path: with balanced weights the cheaper, faster Sentinel wins; when the buyer selects the reputation-first preference, the feedback-backed Smart Contract Auditor (83% reputation) wins instead, with all component scores and reweighted weights visible (`evidence/SELECTION_PREFERENCE_CASES_20260906.json`, `evidence/selection-preference/`). Hunter's paid hiring path currently uses the balanced default.

## Proof points

### Latest Passkey evidence (2026-09-06)

- Wallet: `0xc7B8c226fFdac9b5218ab570bc6c1d443275d28c`.
- Authority: `browser-cbb87207-05c8-4e4b-b053-e538b849c291`; 1.15 U cap, three service recipients, 1-hour expiry.
- Completed recovered mission: `f95f0637-cbd2-4c03-b72c-cf7498a453f3`; Auditor 0.5 U + Verifier 0.25 U. The recorded post-run balance was 0.40 U; a later 0.75 U test funding top-up is a separate event, not service revenue or another completed run.
- All three revoke transactions confirmed; allowance zero; old key explicitly rejected; Session material absent from encrypted store.
- Altana account: https://testnet.altana.network/account/0xc7B8c226fFdac9b5218ab570bc6c1d443275d28c . Indexed display visually accepted 2026-09-06: Smart account, Root key Active, one Session Expired, one Session Revoked, 4 BNB events. See `evidence/altana-explorer/INDEXED_DISPLAY_ACCEPTANCE.md`.
- Evidence: `evidence/PASSKEY_SECOND_RUN_20260906.json`, `evidence/PASSKEY_FINAL_REVOCATION_20260906.json`, `evidence/PASSKEY_ACCEPTANCE.md`.
- Limitations: operator-assisted recovery; negative check completed after expiry; not a speed/cost benchmark or a clean-browser stability pass.

### Latest offer-v2 acceptance

- Authority: `agora-v2-sentinel-20260904-01`.
- Three real settlements: Auditor 0.5 U, Verifier 0.25 U, Sentinel 0.4 U; total 1.15 U.
- Auditor delivery mode: `settlement-recovered`; no duplicate debit.
- Authority revoked, allowance cleared, negative payment test rejected.
- Evidence: `evidence/stability/auditor-verifier-paid-acceptance.json`, `evidence/stability/sentinel-paid-acceptance.json`, `registry/authority-evidence.json`.
- Altana Keystore account: https://testnet.altana.network/account/0x8BA5452112F7E9c339da8E6f38C896B2A0B2E53d . Indexed display visually accepted 2026-09-06: Smart account, 7 keys (Root Active, sessions Revoked), 13 register/revoke events on BNB. See `evidence/altana-explorer/INDEXED_DISPLAY_ACCEPTANCE.md`.


### Stability Authority

- Authority: `agora-termix-stability-20260902`
- Hunter wallet: `0x8BA5452112F7E9c339da8E6f38C896B2A0B2E53d`
- Allowed recipients only:
  - Auditor: `0x3Bd3Fd38ecC72378946c790780c8C1216e4c5527`
  - Verifier: `0x7EA7fBf92d5355957C187976BFE7c5788B2F70bb`
- Limit / confirmed spend: `2.25 U / 2.25 U`
- Six unique service settlements across three consecutive missions.
- Checker, Permit2 allowance and session were revoked; Permit2 allowance is zero.
- A post-revoke `1` base-unit U payment was rejected and encrypted session material was deleted.

Primary artifact: `evidence/stability/three-consecutive-paid-runs.json`

### Agent Advantage

- 3/3 real tasks measured with Agora Mesh and without marketplace hiring.
- Experiment 1: contract audit with reviewed ground truth and Slither-backed verification.
- Experiment 2: token risk with independent RPC replay, 422-holder snapshot and executed sellability evidence.
- Experiment 3: four paid specialist services, `1.35 U` net spend, orphan-payment refund reconciliation and two revoked Authorities.
- Automated operators and independent AI reviewers are explicitly disclosed; no artifact claims an independent human review.

Primary artifacts: `evidence/agent-advantage-report.json` and `evidence/AGENT_ADVANTAGE_REPORT.md`.

## Architecture

```text
User goal + bounded Authority
           |
         Hunter
           |
  discover -> rank -> x402 quote
           |
 Altana session payment on BNB Testnet
           |
 Auditor / Investigator -> signed result
           |
 Verifier / risk replay -> evidence-bound verdict
           |
 report + trace + receipts + reputation
```

## Technology

BNB Smart Chain Testnet, Altana scoped sessions, Permit2, x402/B402, ERC-8004 integration, TypeScript, Node.js, Express, Next.js 15, React 19, ethers/viem, Slither 0.11.6 and PancakeSwap testnet contracts.

## Links

- Canonical demo: `OWNER INPUT — approved dedicated deployment target required`. The former Aliyun deployment was unauthorized and removed; it must not be retried.
- Local demo: `http://localhost:3000` when the local stack is running. No temporary public URL is currently certified for submission.
- Source repository: `OWNER INPUT — public repository URL and final commit`
- Demo video: `OWNER INPUT — uploaded video URL`

## Track framing

**TermiX:** a high-value security marketplace with three real with/without-marketplace-Agent comparisons, transparent ranking and evidence-backed result quality.

**Altana:** a real scoped Agent wallet flow with allowlist, spend cap, expiry, session payments, public Authority evidence, revoke, allowance cleanup and a negative payment test.

PancakeSwap evidence is a non-blocking extension of token-risk investigation. ERC-8183 and four deep DeFi-agent breadth are deliberately outside the core submission.

## Owner-only fields

- Team member names and contact details.
- Event account, wallet ownership declaration and eligibility attestations.
- Public repository URL / final commit.
- Uploaded video URL.
- Final choice of tracks and any legal or originality checkbox.
- Final form review and submission.
