# Agora Mesh — current demo and fresh-browser acceptance

Updated: 2026-09-06. Canonical strategy: TermiX primary, Altana secondary. Public deployment remains deferred by owner instruction.

## Before each live session

Run `node --import tsx scripts/check-demo-readiness.ts` from the repository root with Node 22. Read `evidence/DEMO_READINESS_LATEST.json`; fix failed probes before asking the owner to sign. Passing probes do not establish model availability or end-to-end completion.

Use the localhost origin consistently. Keep the original tab through revoke; its management capability is tab-scoped. Do not display environment files, private keys or raw signed-request errors in recordings. Check that Auditor and Verifier are live, and that two genuinely independent audit providers are eligible before demonstrating competition. Do not count static placeholders or archived Sentinel receipts as live offers.

## Paused acceptance — three fresh browser runs

Owner decision on 2026-09-06: pause this local acceptance flow due to instability. Do not request more device signatures as part of material preparation. Resume only when the owner chooses to restart testing.

For each resumed run use a fresh browser context and a new Authority. The owner creates/recovers the Passkey on the same origin. Fund only the agreed testnet budget and fees. Use a 2-hour session to leave recovery/revoke time; do not extend an already-signed session. Record all timestamps, including human active time, waiting, retries and operator interventions.

1. Enter a goal and budget in `/authority/manage`; owner reviews exact recipients and completes device grants.
2. Submit the goal from the page. Use `VulnerableVault.sol` for the first audit acceptance. Do not use an operator API/script to submit this step.
3. Observe selection, payment and signed report; independent Verifier must complete. Both payers must match this Passkey wallet.
4. Inspect report, receipts, actual spend and remaining wallet balance.
5. Owner performs revoke steps in the page, then rejection verification and deletion. Complete this before the original expiry.
6. Freeze wallet/Authority/mission IDs, transaction hashes, start/end times, failure/recovery log and final absent-session check. Count a clean pass only if no operator journal edits, API reconciliation or manual report recovery were needed.

Current clean-pass count: **0/3**. The first assisted lifecycle is retained as recovery evidence and does not replace this gate.

## Recording outline (about 3 minutes, confirm final event limit)

Use `DEMO_NARRATION_EN.md` for the current evidence-based narration. Present historical results as recorded evidence; do not imply the paused live flow has passed.

- 0:00–0:25: one goal, bounded budget, Hunter hires specialist agents. Explain security-first scope.
- 0:25–0:55: Marketplace/Compare with two live independent providers; show concrete selection reasons and a budget/requirement change. Do not stage an unsupported ranking switch.
- 0:55–1:35: real browser task and 0.5 U + 0.25 U receipts. If using the archived recovered mission `f95f0637-cbd2-4c03-b72c-cf7498a453f3`, label it recovered playback, not a fresh live run.
- 1:35–2:10: user permissions, device revoke, zero allowance, explicit rejection and deleted Session. Open the corresponding Altana account/session and visible transactions.
- 2:10–2:45: Advantage: quality/coverage and independent verification; show full elapsed time and cost units. No faster/cheaper claim is supported by current measurements.
- 2:45–3:00: evidence links and scope. Only include a public demo link after deployment and external verification.

## Submission assets still required

Altana Explorer indexed-display screenshots/links; completed three-run ledger; final Advantage evidence and comparable cost/time records; uploaded demo video; public repository access and final commit; publicly accessible full demo. `git remote` alone does not verify repository visibility or published final changes.

The older backend-only shot list is preserved in `DEMO_RUNBOOK_BACKEND_ARCHIVE.md`; do not use it as the current browser acceptance script.
