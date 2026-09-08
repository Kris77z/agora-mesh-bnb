# Remaining work — 2026-09-06

Decision: TermiX first, Altana second. Keep ERC-8183/four-category DeFi expansion outside the critical path. Public deployment is deferred, not completed.

| Priority | Deliverable | Acceptance criterion | Current gap |
|---|---|---|---|
| P0 | Self-service error recovery | User can reconcile status or resume a paid order in the product, without operator journal edits or CLI recovery; ambiguous signed outcomes never trigger blind rebroadcast | In-product paid-audit recovery implemented and unit-tested; fresh live recovery not yet accepted. Ambiguous wallet sends and stale crash locks still need reconciliation |
| P0 | Three fresh browser runs | Fresh context/Authority, browser goal submission, real service receipts, revoke/rejection before expiry, no operator intervention | PAUSED by owner due to local instability; 0/3 clean runs; prior assisted lifecycle retained separately |
| P0 | Altana indexed-display proof | Wallet, Session/Keystore and relevant transactions visibly inspectable in Altana Explorer, linked in submission | DONE 2026-09-06: both smart accounts visually verified in the Keystore Explorer (keys, states, register/revoke events); screenshots and boundary note in `altana-explorer/INDEXED_DISPLAY_ACCEPTANCE.md` |
| P1 | Two live competing auditors | Both independent offers live and eligible; two documented goals/budgets produce explainable choices using the actual ranking path | DONE 2026-09-06: named ranking preferences (balanced / reputation-first / price-first) added to the shared ranking model, Registry compare API and Compare UI; live probe shows balanced → Sentinel (price+latency) and reputation-first → Auditor (83% feedback-backed reputation), invalid preference rejected with 400. Evidence: `SELECTION_PREFERENCE_CASES_20260906.json`, `selection-preference/*.jpg`. Hunter's paid hiring path still uses the balanced default; goal-level preference plumbing into paid missions remains optional follow-up |
| P1 | Advantage evidence | Three matched tasks, comparable elapsed/active time, actual cost units and auditable quality; no unsupported faster/cheaper claims | Existing 3/3 reports preserved, no new matched speed/cost benchmark; human active time absent |
| P0 for submission | Public demo + submission package | Externally usable full stack, public source/final commit, uploaded video, completed form | Dedicated host unavailable; deployment deferred by owner; final links/commit not verified |

Completed now: first assisted Passkey lifecycle and Session deletion; network/receipt-classifier fixes; submission draft updated; current recording runbook written; read-only preflight script added and executed. Preflight does not spend funds or exercise an LLM.

Next work order: product recovery/status visibility and repeatable local startup; second live provider plus selection examples; fresh browser acceptance with the owner; Altana indexed display; matched Advantage reruns and final recording. Deployment resumes only when a suitable host is available. A new paid run requires a fresh user-granted Authority; the old key has been deleted.

Official requirements checked against https://www.bnbchain.org/en/hackathons/smart-money-era?tab=tracks on 2026-09-06. TermiX judges will hire directly and require at least three with/without-agent task comparisons. Altana requires visible live transactions in its explorer and in-product user revoke. Three fresh browser runs are our project acceptance gate, not an extra official rule.

2026-09-06 continuation: recovery endpoint/UI added with original-order/payment binding and cross-process lock shared with CLI; browser duplicate recovery is coalesced and new task submission is blocked during recovery. 9 related tests, Hunter typecheck and frontend production build passed. Local launcher restored Investigator and original Keychain-backed Sentinel; readiness 11/11 passed. No new model execution, signing or service payment performed. See LOCAL_DEMO.md and LIVE_AUDITOR_SELECTION_20260906.json.

Owner steering: local execution and new browser/device acceptance are paused. Work now prioritizes evidence indexing, claim review, narration and submission preparation. No new paid or signing tests are part of that work.
