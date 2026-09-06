# Passkey browser acceptance

Updated: 2026-09-06. Status: first Passkey browser lifecycle completed with recovery, confirmed revoke, explicit Relay rejection and verified Session deletion.

## Implemented

- `/authority/manage`: device Passkey wallet creation/recovery, wallet balance check, budget (up to 10 testnet U), expiry (1–24 hours), exact configured service recipients.
- Admin signing uses Altana SDK 0.8.0's browser WebAuthn path. No raw admin-key import and no injected-wallet digest-signing emulation.
- Backend prepares the Session signer and persists it encrypted before the browser grants any authority. Only public Session descriptors reach the browser.
- A per-Authority HMAC capability protects mutations and scoped task submission/status. It is stored in the browser tab's sessionStorage; the public Passkey handle is in localStorage. Session private keys never enter either browser store.
- Grant/checker/allowance and revoke steps record pending intent before signing. Confirmation requires matching events plus onchain state, expiry, role, cap, call allowlist and exact allowance.
- Uncertain steps cannot be broadcast automatically a second time. The page accepts the transaction hash for reconciliation.
- Task managers and idempotency namespaces are scoped per Authority. AsyncLocalStorage selects the wallet/session for the whole execution without mutating global demo configuration. PostgreSQL reads reject a different run scope.
- Revoke disables local use first, requires the three confirmed browser transactions, then reuses the existing negative-test and encrypted-key deletion lifecycle.
- Budget and receipt-derived spending are visible. Marketplace CTA links to the new flow; the historical Authority page links to Altana Keystore.

## Next device acceptance

1. Open `http://localhost:3000/authority/manage` in Chrome. Create a Passkey with the device's normal confirmation. Record the resulting public wallet address.
2. Fund that new wallet with testnet BNB and U; funding is separate from historical wallets and must not be represented as already completed.
3. Prepare a 1-hour / 1.15 U Authority. Check the displayed recipients before confirming the three device-signing steps.
4. Run one real audit or token-risk goal. Check that payer equals the new Passkey wallet and that every settled service is in its allowlist. Inspect the report and confirmed spend.
5. Complete the three revoke transactions, then run the rejected-key check. Confirm zero allowance, rejected post-revoke operation and deleted Session material.
6. Repeat under fresh Authorities/browser acceptance conditions before claiming three successful browser E2E runs.

## Boundaries still open

- The owner supplied a screenshot of the created Passkey wallet `0xc7B8c226fFdac9b5218ab570bc6c1d443275d28c`. Funding and the first Session grant are confirmed below. Checker approval, allowance, service payment and revoke remain pending; mocked/no-spend tests do not establish those outcomes.
- A rejected or interrupted signing ceremony may leave a pending journal step without a transaction hash. It remains disabled; operator reconciliation is required. Do not clear the journal and retry blindly.
- Passkey recovery restores the wallet; recovering a lost tab management capability across devices is not implemented. Keep the original tab through revoke. The CLI remains available for historical wallet operations.
- A new public hostname changes the WebAuthn relying-party context; production onboarding/recovery must be accepted on the final HTTPS origin.
- Public deployment is deferred per owner instruction. Free frontend hosting alone does not cover the current long-running backend, Slither and persistent stores.
- Sentinel remains separately deployed/configured; its historical receipt does not imply that a second audit provider is currently online.

## Evidence presentation

### First browser Session grant — 2026-09-06

Authority `browser-cbb87207-05c8-4e4b-b053-e538b849c291`, transaction `0xc4d06adaa1ac2038387668a20491afe22fb3cf664070d9ae721a9a1b262cf833`, receipt status 1. Reconciliation through the real browser router returned HTTP 200 after verifying the matching Authorized event, registered key, role/expiry, exact 1.15 U daily cap and call permissions. The pending grant journal was cleared without another broadcast. The Authority remains inactive until checker and allowance are confirmed.

Root cause: Porto's `Key.toRelay` in SDK 0.8.0 adds the deployed BNB-testnet orchestrator (`0xcb5cef3c54aa90e9a7ad602a258d3d360cc862b9`) to session call permissions. The original exact-count check omitted this entry. Validation now requires this pinned target along with the original configured calls; extra/substituted targets and wildcard permissions remain rejected. Six browser tests and Hunter typecheck pass. A local direct-curl RPC bridge on port 8767 is used for backend reads because the previous Node RPC/TLS path was intermittent.

### First wallet funding — 2026-09-06

`PASSKEY_FUNDING_20260906.json` records confirmed chain-97 funding from the existing project test wallet. Final balances at 07:21:35 UTC were 0.003 tBNB and 1.15 U. The Controller registration fee read before funding was 0.000660597652966818 tBNB per key; initial admin plus Session registration requires two such fees, with additional gas/relay fees.

- Native transaction: `0x4fa89e1a67730c0eda4ae5c2fcdc280eff91ce8487cc9c218140018e4234d963`.
- U transaction: `0x148bcb5dbfb36d2cf2cd298e78bfed15dea270cba47e23d91dba60de79b2e89c`.
- Owner action next: prepare the 1-hour / 1.15 U session in the original browser and perform the device-confirmed grant steps. Funding does not itself grant any agent permissions.

`AGENT_ADVANTAGE_REPORT.md` retains the original three measurements. Experiment 3 is now explicitly decomposed into 201.690 seconds of recorded mission intervals and 1,890.705 seconds between them, while retaining 2,092.395 seconds as the full delivery window. This is an explanation of the existing measurement, not a new speed benchmark.

## Local verification result

2026-09-06: `npm run verify` passed with Hunter 92, Registry 2, Service Host 48 and Shared 26 tests (168 total), 49 existing evidence artifacts validated, TypeScript checks and Next.js production build successful. Five new tests cover receipt event binding, management capability isolation, policy bounds, concurrent paying-wallet context, and the HTTP pending-transaction gate. Browser smoke check confirmed the page renders in Chrome; it did not create a credential or broadcast a payment.

The frontend build emitted npm mirror/SWC lockfile patch warnings but completed successfully. The local frontend and Hunter were restarted after the final build; Registry and the Auditor/Verifier/Investigator service processes are available. The current new-session allowlist contains those three service wallets.

## Active browser Authority and first paid task — 2026-09-06

The owner completed checker approval (`0xf6bca5bd130e6c20766f8c0c4bcf2009e93dd7a7f97b4fd8d388155b8ed77e31`) and exact allowance (`0x3e0c0c7b570f24a5a5deaaa420be8a4cfea5b34fa2fe69e5d2fcd47a6daf740d`). Lifecycle is complete and Authority active.

First task `909455c9-3225-4b69-8d1b-3745557f5967` failed before signing with `AUTHORITY_SPENDING_UNAVAILABLE`: the payment path still used the unreachable original RPC. No payment was signed in that run. Runtime RPC for Hunter, Auditor and Verifier was changed to the working local bridge.

Second task `f95f0637-cbd2-4c03-b72c-cf7498a453f3` audits `VulnerableVault.sol`. Auditor payment `0xd5f55bdb98d667c83259b2307111c6894a7acc34c4162fab64e0f0d7e97de0cc` has receipt status 1. The U Transfer event binds payer `0xc7B8c226fFdac9b5218ab570bc6c1d443275d28c`, recipient `0x3Bd3Fd38ecC72378946c790780c8C1216e4c5527` and amount 0.5 U. Report generation is still in progress at this checkpoint. This is not yet a completed E2E acceptance.

### Paid delivery completed with recovery

The first model attempt timed out after 300 seconds. A localhost-only Moonshot curl bridge (`scripts/local-moonshot-proxy.py`, port 8768) restored API connectivity for the Auditor runtime. An unsigned replay of the original paid request returned the report with the same 0.5 U transaction; no second Auditor charge was created. `PASSKEY_AUDITOR_RECOVERY_20260906.json` stores that response.

Browser-scoped recovery in `resume-paid-audit.ts` now validates the mission Authority and uses its scoped durable run store and AsyncLocalStorage paying context. Independent Verifier payment `0x62d181a134a12f436ddd83ea64c2382c0e29012e5a0268075fda5cee0b03176f` was confirmed on chain: 0.25 U from the new Passkey wallet to its configured Verifier. Both signed service receipts verified. Slither 0.11.6 returned four confirmed findings and one missed finding; these are tool classifications, not proofs that every claimed exploit is viable.

The recovered mission `f95f0637-cbd2-4c03-b72c-cf7498a453f3` is completed in both mission and scoped run stores. Total paid 0.75 U; remaining allowance/budget 0.40 U. `PASSKEY_SECOND_RUN_20260906.json` and `PASSKEY_ACTIVE_STATE_20260906.json` capture final delivery and spending. This acceptance includes recovery and must not be presented as a failure-free run. Device revocation and rejected-key verification remain outstanding. Hunter typecheck, bridge syntax check and diff whitespace checks passed.

### Browser Relay fetch failure during revocation

The owner reported `wallet_getCapabilities` failing in the browser before signing the first revoke step. SDK source confirms capabilities are read before preparing the signable request. Onchain checker approval remained present. The unsent `revokeChecker` intent was reconciled and cleared while preserving local Authority invalidation and the revoke lifecycle; see `PASSKEY_REVOKE_PREFLIGHT_RECOVERY_20260906.json`. No revoke transaction is claimed.

The frontend now routes SDK Relay/RPC requests through `/api/altana/relay` and `/api/altana/rpc`, with fixed upstreams, method allowlists, same-origin checks and no automatic retry of signed requests. A capabilities preflight runs before opening a pending journal step. This is a local Node/curl deployment path, not a claim of serverless hosting compatibility. Production build passed; live capability probe returned chain 97, unsupported method returned 400, and cross-origin request returned 403. Owner must reload the original tab to use the new client bundle before continuing device revocation.

### Read-only RPC resilience during revoke

A subsequent `eth_getBalance` returned HTTP 502. The owner explicitly confirmed that device verification had not occurred. The unsent revoke intent was cleared while preserving invalid local Authority state (`PASSKEY_REVOKE_BALANCE_RECOVERY_20260906.json`). Read-only RPC now uses bounded attempts across two fixed BNB-testnet endpoints; explicitly allowlisted Relay reads retry, while prepared/signed/mixed requests receive exactly one transport attempt. Three regression tests cover fallback, no signed-request replay and no replay of application errors. Production build passed and the live same-origin balance query succeeded after restart. Revocation still awaits the owner's device steps.

### Unsigned Relay preparation recovery

The next browser error was `wallet_prepareCalls` HTTP 502. SDK `submitCalls` explicitly awaits prepareCalls before signCalls and sendPreparedCalls; that failed request had not reached signing. The unsent intent was reconciled with the local Authority still disabled. Transport now retries unsigned preparation on connection failure, while signed submission and mixed batches remain single-attempt. Four transport tests and production build passed. A live prepareCalls probe with the same wallet, public admin key and revokeChecker calldata returned success without signing or sending (`PASSKEY_REVOKE_PREPARE_PROBE_20260906.json`). This verifies the actual prepare path, not only capabilities/health. Device confirmation and completed revocation remain outstanding.

### Signed allowance-submit reconciliation

Checker revocation succeeded: `0x202e584aacc1e2a19673a6affa5614e63fe2c28541d808ababd267d4b9492f69`, chain checker list empty. The subsequent `wallet_sendPreparedCalls` for revokeAllowance returned 502. The visible original request had intent nonce 3 and quote ttl 1788685463. After ttl plus 120 seconds, the onchain nonce remained 3, allowance remained 0.40 U, and Relay history contained only the checker revoke and original grants. The pending allowance step was reconciled for fresh preparation of the same zero-allowance operation; the captured signature was not replayed. Evidence: `PASSKEY_REVOKE_SUBMIT_RECONCILIATION_20260906.json`.

Transport now permits bounded reconnect only for curl codes proving failure before HTTP send (DNS, connection or TLS handshake/certificate). Signed timeouts, HTTP failures and lost responses still receive no replay. Five transport tests and frontend production build passed. No second or third revoke transaction is claimed yet.

## Final accepted lifecycle

`PASSKEY_FINAL_REVOCATION_20260906.json` records all three revoke transactions, explicit rejected-key result, deleted Session material and an independent store absence check. Chain reads confirmed allowance 0, invalid Keystore Session and remaining wallet balance 0.40 U. Total service spend remains 0.75 U. The owner can refresh the original page to see revoked status; no further device signature is required for this Authority.

The final blocker was a classifier bug: its loose `50[234]` check matched `502` inside the actual Session key hash, incorrectly rejecting a valid unknown-key response as transport failure. The classifier now excludes hex values and URLs from transport diagnostics and matches HTTP status codes as complete tokens. Regression coverage includes the actual hash, `.network` Relay URL, genuine HTTP 502 and network timeout; all nine lifecycle tests and Hunter typecheck passed. The real `/finish-revoke` returned HTTP 200 after restart, with `negativeTest.rejected=true` and `sessionMaterialDeleted=true`.

Timing limitation: the final successful negative check ran at Unix 1788686379, after the Session's original expiry 1788686276. It demonstrates the old key is rejected after the confirmed onchain revoke, but does not isolate revocation from expiry. A future clean run should complete the negative test before expiry to establish that timing distinction. This first run also required model-delivery recovery and several network/reconciliation fixes; it is not one of three uninterrupted browser E2E passes.
