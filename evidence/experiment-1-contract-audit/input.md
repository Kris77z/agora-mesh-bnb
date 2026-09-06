# Experiment 1 — Smart Contract Audit Input

Use the exact source in `VulnerableVault.sol` for both workflows.

Task:

> Audit this benchmark Solidity contract for loss-of-funds vulnerabilities and validate every finding independently.

Timing starts when the operator submits the task and ends when the final evidence-bound report is available. Agent cost is the sum of confirmed x402 payments. The controlled baseline must record its own model/tool cost and operator time separately.

The historical paid run used the same Solidity source but passed the surrounding task text to the source hasher. The ground-truth manifest retains that legacy input hash explicitly; future runs use the Solidity-only hash.
