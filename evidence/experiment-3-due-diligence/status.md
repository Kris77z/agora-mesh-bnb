# Experiment 3 Status

Status: **new paid four-service execution complete after reconciliation; controlled human comparison pending**.

Paid execution:

- Security Auditor: `0.5 U`, transaction `0x026e68b9c8d70d286729f5226924c7649a5d6e810c06b3ecb57974bfeddf6fa5`;
- Finding Verifier: `0.25 U`, transaction `0xa4bf1462a1915eeb634ee18ed3f92ae24806e2d6e1d5c26154a4127a5c99d837`;
- Onchain Investigator: `0.35 U`, transaction `0x935fd6c8627a07f7f84bec0382924237fdcbcc4302ef842c0691a8904bb72cb2`;
- Risk Verifier: `0.25 U`, transaction `0xccb746aa1c086ee6d6bdb0e0a271dfd07148919419632763efbc411edec91972`.

The valid provider payments total exactly `1.35 U`. An earlier orphaned `0.5 U` Auditor settlement (`0x0f55a8d790a6567218d667f1d0408826f60ae2697021598ebc2e5ac16d666a82`) was returned by the Auditor (`0xba0da166b32dfcb5a4072c67ab2f3d69fd050d12940783417688223f42ef017a`). Gross transfers were `1.85 U`; after the `0.5 U` refund, net spend is the intended `1.35 U`.

Execution is persisted across two recoverable mission phases:

- Audit + finding verification: `c311466f-85e4-469c-bbd7-e1ced0a3fe57`;
- Investigation + risk verification: `4d3dca34-439f-469d-99f1-4de40849087d`.

Both the original and supplemental 24-hour Authorities were revoked, final Permit2 allowance is zero, local Session material was deleted, and post-revoke negative tests were rejected.

Quality/evidence completed:

- exact EIP-1967 proxy/implementation and verified multi-file source package binding;
- scoped first-party Auditor findings and deterministic Verifier evidence;
- Slither `0.11.6` compiler-backed run with Solidity `0.8.28`;
- independent onchain report replay plus complete 422-holder and executed-sellability evidence inherited from Experiment 2 for the same target;
- deterministic Hunter `high-caution` synthesis;
- isolated Claude blind AI candidate (`caution`) with an ordered verdict for all 24 raw Slither detections;
- `paid-run-final-output.json` binds the four intended payments, refund reconciliation, missions, and Authority cleanup.

Important limitations:

- the successful LLM audit scope contains the three verified first-party source units; dependencies are covered by compilation/static analysis rather than a successful whole-package LLM pass;
- Slither signals are not automatically equivalent to exploitable vulnerabilities;
- the Claude artifact is an independent AI candidate, not a human ground-truth sign-off;
- the controlled human + ordinary-LLM baseline and final human false-positive/ground-truth adjudication remain pending under `evidence/CONTROLLED_REVIEW_HANDOFF.md`.

`npm run verify:evidence` now checks all four receipt-store payments, mission persistence, exact spend/refund arithmetic, target bindings, both revoke outcomes, zero allowance, deleted Session material, and the non-human baseline disclosures.
