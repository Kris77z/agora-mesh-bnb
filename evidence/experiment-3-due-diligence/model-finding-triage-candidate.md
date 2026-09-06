# Experiment 3 Model Finding Triage Candidate

Review status: **Agent-authored candidate; independent human review pending.**

The scoped Kimi Auditor reviewed all three explorer-verified first-party `src/`
source units (19,110 bytes) and returned four findings. The complete 99,694-byte
package, including 18 OpenZeppelin source units, was compiled and checked by
Slither separately. Source-unit-aware deterministic verification marks all four
model findings `partial`: it independently locates each cited source structure
in the exact file, but does not establish exploitability. The notes below add
read-only runtime context without turning them into confirmed vulnerabilities.

Runtime evidence: `runtime-triage-output.json`.

| Finding | Model severity | Runtime context | Candidate assessment |
|---|---:|---|---|
| `unbounded-auto-mint-limit-bypass` | high | latest `autoMintMaxLimit=0`, `nonce=0`; positive `autoMint` amounts therefore fail the configured per-call limit. The owner still has a separate unlimited direct `mint` capability. | `partial`: exact-file rule confirms a per-call limit check that is not consumed in `autoMint`; this is a conditional policy/design risk, not a currently proven exploit with the observed zero limit. Human review must determine whether the variable was intended as a per-call or cumulative cap. |
| `auto-burns-owner-balance` | medium | latest `owner` and `autoOwner` are the same address and hold the same observed 20 U balance. | `partial`: exact-file rule confirms that `onlyAutoOwner` can burn `owner()` balance without allowance. The distinct-hot-wallet scenario is not present at the latest block, so future role separation remains a trust/policy risk. |
| `v2-initializer-unprotected` | medium | latest Initializable slot candidate is version `2`; a read-only arbitrary-caller `initializeV2()` simulation reverts as already initialized; EIP-7598 is already enabled. | `partial`: exact-file rule confirms a public `reinitializer(2)` without an explicit authorization modifier. It is not currently callable; whether the upgrade initialized atomically is a historical question not recoverable from the pruned free RPC state. |
| `front-runnable-v1-initializer` | high | latest arbitrary-caller `initialize("Attacker","ATK")` simulation reverts as already initialized; owner is a nonzero configured address. | `partial`: exact-file rule confirms a public V1 initializer without an explicit authorization modifier. It is not currently callable; the deployment-window risk remains unverified because the deployment transaction sequence has not been reconstructed. |

Important boundary:

- the original report block `128449782` is now pruned on the tested free RPCs;
- latest-state observations are not substituted for historical facts;
- no transaction was signed or broadcast;
- `confirmedCriticalHighFindings=0`; two high-severity findings are recorded separately as partially confirmed source structures;
- the final recommendation remains `high-caution` because privileged mint,
  pause/freeze, proxy admin, incomplete holder data, and quote-only sellability
  remain independently established concerns.
