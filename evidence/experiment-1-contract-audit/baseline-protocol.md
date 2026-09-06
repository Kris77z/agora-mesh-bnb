# Controlled Baseline Protocol

Controlled human + ordinary-LLM baseline status: locked input bundle ready;
blind execution pending. The machine-readable operator package is
`baseline-input.json`.

A reproducible Slither-only reference has been captured separately in
`tool-baseline-output.json`. It took 974.817 ms, matched all 3 reviewed
ground-truth findings, and reported 1 additional low-severity finding
(precision 0.75, recall 1.0). This reference does not satisfy or replace the
controlled baseline below because it contains no human workflow or ordinary
LLM step.

The baseline operator receives the same task and `VulnerableVault.sol`, then uses one ordinary LLM chat plus a local Slither invocation. Record:

- start and completion timestamps;
- exact model and static-analysis versions;
- prompts and raw output;
- operator-active minutes;
- any paid model/tool cost;
- findings mapped to `ground-truth.json` without seeing that manifest during the run.

Do not enter precision, recall, speedup, or savings until the raw baseline output has been captured and scored with the same evaluator as the Agent run.

Reproduce the tool-only reference from the repository root with:

```bash
npm run baseline:audit-tool
```

Regenerate all three hash-bound blind baseline packages with
`npm run baseline:prepare`. This preparation step does not invoke an LLM and is
not itself a completed baseline.
