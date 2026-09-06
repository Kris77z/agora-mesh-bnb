# Local demo operations

Use Node 22 and run from the repository root:

```sh
npm run build --workspace @rebel/frontend
python3 scripts/start-local-demo.py
```

The foreground launcher starts missing RPC/model bridges, Registry, Auditor, Verifier, Investigator, Sentinel, Hunter and frontend. Existing listening processes are retained and checked by the read-only readiness probe. It does not replace old code in already running processes. Stop a known project process before relaunching to load code changes. Ctrl-C terminates only process groups created by this launcher. Logs stay in ignored `.local-demo/` with private file permissions. The terminal must remain open; this is not public hosting or a reboot service.

Sentinel uses the existing macOS Keychain service names `agora-mesh-sentinel-private-key` and `agora-mesh-sentinel-facilitator-key`, or matching `SENTINEL_PRIVATE_KEY` and `SENTINEL_X402_FACILITATOR_PRIVATE_KEY` process environment variables. Values are captured directly into child environment; never paste them into commands, screenshots or documents. No substitute wallet is generated. All service onchain registration is disabled at startup.

Readiness only checks pages, RPC, relay capabilities and live services. It neither calls a model nor signs or pays. An available model configuration is not a fresh successful model response. Three clean browser runs remain 0/3.

## Paid audit recovery

A failed x402 audit offers **Recover original paid task** in Authority management. The same Authority must remain active. Hunter binds the original mission, request hash, wallet, transaction and idempotency key, fetches the existing paid audit without another payment authorization, validates the receipt and continues independent verification within the remaining Authority allowance. Recovery may pay the Verifier; the Auditor is not charged again. Token-risk and arbitrary failures are not supported by this audit-specific recovery path.

Concurrent recovery uses the same local lock in browser and CLI. The page polls progress; new task submission is blocked while recovery runs in this server. A process crash may leave a lock, which is intentionally not stolen. An operator must verify no writer is active before removing a stale lock. This is local file-store exclusion, not distributed scheduling. Browser live recovery still needs acceptance; tests are not counted as a new paid run.

## Latest check

2026-09-06: readiness 11/11 passed; Sentinel wallet matches historical evidence (`0x1Ef8eEb640e60d5d3Bc3eFe1A4b2fFCd64132c2C`). Three read-only ranking cases all preferred Sentinel. This proves live competing offers, not a change of choice or measured execution advantage. A new Authority includes Sentinel in the disclosed recipient list; previously granted sessions are unchanged.

The Authority page now offers **Set up a new Authority** after a revoked session and defaults new permissions to two hours. This clears only the active tab selection; historical server evidence is preserved. Browser acceptance goal 1 is prepared in `BROWSER_ACCEPTANCE_GOAL_1.txt`. Device recovery/grants and a fresh paid run remain pending.
