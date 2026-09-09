# Submission review — 2026-09-06

Start with [submission copy](SUBMISSION_DRAFT.md), [Agent Advantage report](AGENT_ADVANTAGE_REPORT.md), and [recording narration](DEMO_NARRATION_EN.md).

## Claims and their evidence

| Claim | Evidence | Boundary |
|---|---|---|
| Three task comparisons | agent-advantage-report.json; each experiment’s baseline-output.json and paid/agent output | Automated/AI review, not independent human review; legacy JSON status is internal, not organizer approval |
| Auditor + Verifier payments from Passkey wallet | PASSKEY_SECOND_RUN_20260906.json | 0.75 U; operator submitted task and recovered delivery |
| Owner revoked first Passkey session; local key deleted | PASSKEY_FINAL_REVOCATION_20260906.json | Final rejection happened after expiry |
| Real second auditor payment | stability/sentinel-paid-acceptance.json | Historical backend acceptance, not a fresh browser run |
| Two providers live at probe time | LIVE_AUDITOR_SELECTION_20260906.json | Snapshot only; all recorded cases chose Sentinel |
| Nominal test funds restored | PASSKEY_TOPUP_20260906.json | Funding transfer, not a service purchase or completed task |
| In-product paid audit recovery | Local implementation and tests in LOCAL_DEMO.md | Fresh real recovery acceptance still pending |
| Publicly usable full demo | https://agora-mesh-bnb.vercel.app, backend on the dedicated host | Pages, service discovery and health checks verified; a paid browser hiring run is not part of this check |

## Experiment reading order

1. Contract audit: `experiment-1-contract-audit/input.md`, `agent-output.md`, `baseline-output.json`, `ground-truth.json`, `tool-baseline-output.json`.
2. Token risk: `experiment-2-token-risk/input.md`, `paid-run-output.json`, `baseline-output.json`, `security-review-output.json`, `holder-snapshot-output.json`, `sellability-execution-output.json`.
3. Due diligence: `experiment-3-due-diligence/input.md`, `paid-run-final-output.json`, `baseline-output.json`, `slither-adjudication.json`, `orphan-payment-refund-output.json`, `authority-revoke-output.json`.

## Actual remaining gates

- Stable public full-stack URL: https://agora-mesh-bnb.vercel.app (website) with https://43-165-167-118.sslip.io serving `/api/*`; resolved.
- Fresh browser acceptance: paused by owner, 0/3.
- Altana Explorer account/session/transaction visible indexing: visually verified 2026-09-06 for both smart accounts (see `altana-explorer/INDEXED_DISPLAY_ACCEPTANCE.md`); resolved.
- Final source revision: local working tree is not frozen or published as a final release.
- Video: narration ready; recording/export/upload missing.
- Team details and final submission: owner review required; no form has been submitted.
- Marketplace selection change: demonstrated 2026-09-06 via named ranking preferences on the live compare path (balanced → Sentinel; reputation-first → Auditor); see `SELECTION_PREFERENCE_CASES_20260906.json` and `selection-preference/`. Matched model/tool dollar costs / user hands-on time: still not measured.

Official reference: https://www.bnbchain.org/en/hackathons/smart-money-era?tab=tracks (checked 2026-09-06). TermiX requires three with/without comparisons with time, cost, quality and outputs, and will hire services itself. Altana requires real transactions visible in its explorer and in-product permission control. These organizer requirements remain distinct from our internal three-clean-browser-run gate.

Validation: `npm run verify:evidence` passed on 2026-09-06, checking 64 public evidence JSON files. This validates artifact consistency, not public availability, current balances, browser stability or organizer acceptance.
