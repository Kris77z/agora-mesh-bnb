# Agora Mesh — implementation status

Updated: 2026-09-06. Current scope: Passkey lifecycle accepted with operator recovery; independent browser acceptance and submission readiness remain open. This is not a claim of 100% production readiness.

## Confirmed historical evidence

- BNB Testnet Auditor + independent Verifier payments, scoped Authority, Revoke and negative tests.
- Experiment 2: 422-holder block-locked snapshot and actual 0.1 U sellability test.
- Paid Experiment 3: four services, 1.35 U net, mistaken settlement refunded, both Authorities revoked.
- Three paid audit missions: six settlements totaling 2.25 U, one disclosed settlement-response recovery, then Revoke. These were backend/API runs, not three fresh-browser end-to-end runs.
- Fresh offer-v2/lifecycle acceptance on 2026-09-04: one 1.15 U Authority paid Auditor 0.5 U, Slither Verifier 0.25 U, and an independent Sentinel 0.4 U; all receipts are bound, the one stalled Auditor delivery is explicitly disclosed as settlement-recovered, then the Authority was revoked and the negative test rejected.
- Three Agent Advantage comparisons and Slither adjudication are independently AI-reviewed, not independently human-reviewed.
- Original evidence JSON and transaction hashes remain unchanged by the backend hardening below.

## Backend hardening implemented locally

| Area | Implementation / acceptance boundary |
|---|---|
| Authority creation | Encrypted disabled recovery material saved before grant; per-step public journal; active only after all confirmations; duplicate IDs cannot silently overwrite an existing grant |
| Authority revocation | Disabled locally before first revoke; confirmed steps checkpointed and skipped on retry; expired/reverted/network errors do not count as explicit revoked-key rejection |
| Task admission / SSE | A stable missionId is durably admitted before execution; idempotency conflicts reject changed input; SSE disconnects replay the same event log; cancellation is explicit; restart ambiguity fails closed instead of rerunning paid work |
| Persistence | Cross-process local file locks for session/evidence/settlement/run/mission writes; interrupted writes fail closed |
| x402 offer v2 | Signed Permit2/EIP-3009 nonce equals the canonical request hash; exact amount, recipient, token, facilitator and expiry checked before settlement |
| Settlement uncertainty | Durable attempt before payment; ambiguous responses block another debit; Hunter retains original request and only performs unsigned replay |
| Reconciliation | Local command validates chain receipt, calldata, signed request nonce and unique token Transfer; it never broadcasts or invokes a model |
| Paid delivery | Same original request resumes execution or returns cached output, including after price/version/expiry changes |
| Result receipts | New v2 signatures bind request, result, provider and timestamp; legacy signatures remain readable, not retroactively upgraded |
| Historical task recovery | Exact mission/request/payment matching and v2 signature verification; refuses nearby or ambiguous receipts and incomplete audit/verifier pairs |
| Recovery terminal consistency | A recovered paid mission also reconciles the durable run to the exact same result/events; idempotent sync refuses running, cancelled, goal-mismatched or conflicting terminal state |
| Discovery / Compare | Shared x402 eligibility and current identity probes; discovers multiple capabilities on one endpoint; excludes offline, runtime-unavailable and legacy placeholders from paid selection |
| Second audit provider | Sentinel profile implemented with separate port, Keychain-held wallet/facilitator, 0.4 U quote and strict no-fallback audit execution; real paid receipt and structured report verified |
| Service execution boundary | Profile-configurable hard LLM timeout cannot be bypassed by a stuck SDK promise; blank receipt-store env values fall back to profile files instead of a directory |
| ERC-8004 | Normative registration-v1 JSON endpoint and read-only transaction preflight; canonical BSC Testnet registry verified; broadcast remains blocked without a public HTTPS URI and confirmation |
| Multi-replica persistence | PostgreSQL 15 schema and runtime adapters cover Hunter runs/missions/memory, x402 purchase/execution/chain evidence, Authority public lifecycle, Registry leases/reputation, Agent feedback/identity, ERC-8004 registration state and Outbox. File fallback remains default; atomic JSON import and local two-process restart acceptance pass |

Authority management update (2026-09-06): `/authority/manage` now implements a separate browser Passkey wallet flow with backend-generated encrypted Session material, public descriptors, capability-protected lifecycle APIs, event-bound chain confirmation, scoped task execution and revoke/negative-test cleanup. The existing EVM Admin CLI and historical `/authority` evidence remain available. First browser device signing, 0.75 U two-service delivery with recovery, all three revocations, explicit Relay rejection and encrypted Session deletion are now accepted. Final negative verification occurred after the original expiry; this was not an uninterrupted run. See `evidence/PASSKEY_ACCEPTANCE.md`.

## Remaining boundaries — do not mark complete

1. ERC-8004 registration code and durable state are complete, but canonical onchain registration is not complete because no approved public HTTPS registration URI exists.
2. No approved public deployment target is configured. The previous Aliyun target was unauthorized, removed by the owner, and is prohibited. The disabled deployment script must not be re-enabled or retried against that host.
3. Frontend visual polish and remaining fresh-browser acceptance, recorded/uploaded video, submission fields and event submission remain separate delivery work.
4. Local Docker proves application coordination, not managed PostgreSQL cross-AZ failover, DNS promotion, PITR or external secret-manager behavior. Those require the future approved deployment environment.

## Backend handoff

See [BACKEND_HANDOFF.md](BACKEND_HANDOFF.md) for API behavior, offer-v2 migration, recovery commands, local locking limitations, and no-spend verification.

`npm run verify` is the acceptance gate: workspace typechecks, unit/integration tests, frozen evidence validation and frontend build. It does not send transactions. Use Node.js 20.19+ (verified locally with Node 22).

2026-09-04 最新本地门禁通过：Hunter 87、Registry 2、Service Host 48、Shared 26，共 163 项测试；49 份公开证据 JSON 校验通过（含 1.15 U / 3 笔 settlement、双账本恢复终态、Revoke 与负向测试）；Next.js 生产构建成功。仅有 caniuse-lite 数据陈旧提示。

PostgreSQL 独立门禁 14/14 通过：本机 Docker PostgreSQL 15 + 两个应用连接池，覆盖幂等并发、任务抢占、lease takeover/fencing、SSE 回放、x402 原子证据与响应丢失重放、uncertain 人工对账、Outbox 重投、服务 TTL、外部任务号、Agent/链上身份、反馈、Hunter 记忆、数据库断连和 Authority secret-reference 边界。完整 JSON 快照已原子导入并核对 12 个 mission、18 个 x402 execution、32 个交易证据、6 个 Authority、102 条反馈和 35 条经验；两个真实 Hunter 进程读取一致，单副本停止及进程重启后历史仍可用；Registry 也通过“副本 A 注册 Agent、副本 B 立即读取”。它不等价于生产跨可用区数据库故障转移；详见 `database/PRODUCTION_DESIGN.md`。

ERC-8183, mainnet operations, expanded DeFi agents and human review remain optional stretch work, not silently represented as completed.

2026-09-06 Passkey implementation: `npm run verify` passes with 168 tests and 49 frozen evidence files; frontend production build passes. `/authority/manage` is available locally. A new Passkey wallet completed the browser lifecycle: grant, 0.75 U paid delivery with recovery, revoke and verified key deletion. Final evidence and remaining clean-run timing limits are documented in evidence/PASSKEY_ACCEPTANCE.md. Public deployment was explicitly deferred by the owner while no dedicated backend host exists.

## 2026-09-06 local recovery continuation

Browser paid-audit recovery implemented with original receipt binding, no additional Auditor authorization, shared CLI/browser lock and progress polling. Nine related tests, Hunter typecheck and frontend build passed. `scripts/start-local-demo.py` restores missing local services with original Sentinel Keychain identity. Readiness 11/11 passed; two live auditors verified. Fresh browser acceptance remains 0/3; final video/source/deployment remain pending. See `evidence/LOCAL_DEMO.md`.

2026-09-06 later same day: Altana Explorer indexed display visually accepted for both smart accounts (`evidence/altana-explorer/INDEXED_DISPLAY_ACCEPTANCE.md`). Named ranking preferences (balanced / reputation-first / price-first) added to the shared ranking model, Registry compare API and Compare UI; a live probe and browser check demonstrate an explainable provider switch (balanced → Sentinel, reputation-first → feedback-backed Auditor) with an invalid preference rejected by 400 (`evidence/SELECTION_PREFERENCE_CASES_20260906.json`, `evidence/selection-preference/`). Hunter's paid hiring path still uses the balanced default.

## 2026-09-06 owner-paused local acceptance

Owner paused unstable local browser testing. Clean browser acceptance remains 0/3; do not request additional device signing as part of submission preparation. Updated submission copy and Advantage wording, prepared evidence-based English narration and review index; 26-file SHA-256 manifest created. Existing evidence validation passed (64 public JSON files). Public repository API verification was unavailable; final published source revision remains unverified. No new paid run was performed for this preparation. Start at `evidence/SUBMISSION_REVIEW.md`.
