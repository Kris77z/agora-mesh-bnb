# Experiment 3 Static Detection Triage Candidate

Review status: **Agent-authored candidate; independent human review pending.**

Source boundary: `sha256:9f1ddcbd5fab6622ba8ab3a761f76b0f352bcbf890cf5f36698b778ebd7ed78c`.
Tool boundary: Slither `0.11.6`, solc `0.8.28`, explorer remappings.

This is a source-reading aid, not ground truth and not a clean-audit statement.
The canonical detector IDs, complete notes, snippets, and source units remain in
`verifier-output.json`.

## Candidate classification

| Detector | Source units / lines | Count | Candidate classification | Reason to verify |
|---|---|---:|---|---|
| `incorrect-exp` | `MathUpgradeable.sol:L117` | 1 | likely false positive | `^ 2` is the intentional XOR seed used by the OpenZeppelin/Uniswap full-precision `mulDiv` modular inverse, not an attempted exponentiation. Confirm dependency version and provenance. |
| `divide-before-multiply` | `MathUpgradeable.sol:L102,L105` | 2 | likely false positive | the function first removes the exact power-of-two factor, shifts high product bits, then multiplies by a modular inverse. Slither's generic precision warning does not model the algorithm's exactness proof. |
| `shadowing-local` | `StablecoinV2.sol:L88,L112,L141,L169,L183,L204,L249` | 7 | naming/readability concern | the EIP-3009/EIP-7598 `bytes32 nonce` parameters shadow the inherited `uint256 public nonce`, but references in each function resolve to the local authorization nonce. Human review should confirm no intended use of the inherited auto-mint/burn nonce was replaced. |
| `shadowing-local` | `Stablecoin.sol:L50,L178,L242` | 3 | likely non-exploitable naming concern | initializer `_symbol`, local `owner`, and `_approve` parameter `owner` resolve explicitly in their scopes. Review for maintainability; no privilege bypass follows from the names alone. |
| `shadowing-local` | `draft-ERC20PermitUpgradeable.sol:L47` | 1 | likely dependency naming false positive | the initializer parameter `name` is intentionally passed to the EIP-712 initializer and does not call the inherited `name()` getter. |
| `missing-zero-check` | `Ownable2StepUpgradeable.sol:L42` | 1 | likely intended cancellation behavior | setting the pending owner to zero does not transfer current ownership; no zero address can call `acceptOwnership`. It effectively clears/cancels a pending transfer. Confirm the exact OpenZeppelin version's documented behavior. |
| `timestamp` | `StablecoinV2.sol:L208-L209` | 1 | expected protocol behavior with boundary risk | authorization validity requires time-window comparison. Miner/validator timestamp latitude matters only near the boundary; callers should leave safety margin. Confirm the intended strict `>` / `<` semantics. |
| `timestamp` | `draft-ERC20PermitUpgradeable.sol:L65` | 1 | expected protocol behavior with boundary risk | ERC-2612 permit expiry is defined by a deadline comparison. This is not independently a vulnerability, though clients should avoid exact-boundary assumptions. |

Candidate totals:

- 17 static detections;
- 6 detections in OpenZeppelin dependency source units;
- 11 detections in first-party `src/` source units;
- 0 detections classified here as a confirmed vulnerability;
- 17 conclusions still require independent human acceptance or rejection.

## Security facts outside these detector warnings

The absence of a confirmed Slither finding does not remove the contract's
privileged-control risk. The exact-block onchain report independently observed an
active owner, EIP-1967 proxy admin/implementation, and runtime capabilities for
mint and pause. Those controls are why the synthesis remains `high-caution` even
if every static detector above is eventually marked false positive or accepted
design.
