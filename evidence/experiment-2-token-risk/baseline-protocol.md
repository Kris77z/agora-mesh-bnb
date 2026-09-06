# Controlled Baseline Protocol

Controlled human + ordinary-LLM baseline status: locked input bundle ready;
blind execution pending. The machine-readable operator package is
`baseline-input.json`.

The baseline must use the exact task, target, chain, and observation block from
`input.md` and `paid-run-output.json`. The operator may use one ordinary LLM chat,
the BSC explorer, and direct JSON-RPC calls, but cannot inspect the Agora Mesh
report, `security-review-output.json`, or `ground-truth-candidate.json` until the
raw baseline output is frozen.

Record:

- start and completion timestamps;
- exact model, explorer, and RPC endpoints;
- prompts, direct RPC methods, and raw output;
- operator-active minutes and paid model/tool cost;
- every asserted fact with its source and observation block;
- risk signals, recommendation, and explicit unavailable dimensions.

After the output is frozen, an independent reviewer maps it to the same fact and
risk-signal manifest used for the Agent run. Do not report speedup, savings,
precision, recall, or a completed comparison before that review is signed.

`security-review-output.json` is an independent validation of the Agent result;
it is not the without-Agent baseline and must not be counted as one.

Regenerate all three hash-bound blind baseline packages with
`npm run baseline:prepare`. This preparation step does not invoke an LLM and is
not itself a completed baseline.
