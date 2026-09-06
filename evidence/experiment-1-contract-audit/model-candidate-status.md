# Experiment 1 Ordinary-Model Candidate

Status: measured candidate; controlled human baseline remains pending.

- Direct ordinary model: `kimi/kimi-k2.6`.
- Model wall time: `272005.084 ms`.
- Usage: `12,099` tokens.
- Frozen output: 3 findings, all 3 category-matched after freeze, with 0 candidate false positives and 0 candidate false negatives.
- Severity agreement: 1/3 (`33.33%`).
- The LLM context excluded Agent output and ground truth, but the orchestrator was not an independent human and had prior project context.
- Provider invoice cost and independent human labor cost are unavailable.

Canonical artifacts are `baseline-model-raw.json` and
`baseline-output-candidate.json`. These do not complete the plan's controlled
human + ordinary-LLM comparison.
