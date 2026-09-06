# Experiment 3 Controlled Baseline Protocol

Status: locked input bundle ready; blind execution pending. The
machine-readable operator package is `baseline-input.json`.

The baseline operator must receive exactly the task and evidence boundary in
`input.md`. The comparison clock starts when the operator receives the input and
ends when a final trust recommendation and evidence list are delivered.

Allowed baseline workflow:

1. inspect the BNB Testnet proxy and verified implementation source in a browser;
2. use an ordinary general-purpose LLM without Agora Mesh orchestration;
3. run a locally installed security tool such as Slither;
4. inspect RPC and DEX facts manually;
5. synthesize one recommendation with limitations.

Record without retroactive reconstruction:

- raw prompt and every source supplied to the LLM;
- tool names, versions, commands, and raw outputs;
- start/end timestamps and active human minutes;
- model/API and human labor cost assumptions;
- findings, false-positive triage, verified onchain facts, and coverage gaps;
- final recommendation and all supporting links/artifacts.

Quality scoring remains pending until independent human reviewers produce a
source-hash-bound ground-truth/triage manifest. The baseline must not use the
Agora Mesh candidate output as an input, and the candidate must not be rescored
against a baseline written after seeing its conclusions without recording that
the comparison is non-blind.

Regenerate all three hash-bound blind baseline packages with
`npm run baseline:prepare`. This preparation step does not invoke an LLM and is
not itself a completed baseline.
