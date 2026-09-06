# Optional independent-human review handoff

Status: **optional enhancement; official TermiX comparison is complete without it**.

The official BNB Chain TermiX track asks for three real tasks run with the marketplace Agent and without it, including time, cost, output quality and raw outputs; it does not require a human reviewer. Agora Mesh now satisfies that requirement in `agent-advantage-report.json`. The repository also contains an isolated Claude blind review and 24/24 Slither-row adjudication, both correctly labeled as independent AI. This runbook remains available if the team wants an additional human sign-off.

## Reviewer eligibility

Use one person who has not seen Agora Mesh's Agent outputs, ground truth, prior comparisons, or implementation discussion. Before starting, the reviewer records their name or stable pseudonym, UTC start time, ordinary LLM product/model, Slither version, and confirms that screen recording or an equivalent contemporaneous activity log is running.

The reviewer must work from a clean copy containing only the allowed files listed in each `baseline-input.json`. Do not expose any file listed under `forbiddenInputsUntilOutputFrozen` until the corresponding baseline output has been written, hashed, and timestamped.

## Frozen input checks

Run `shasum -a 256` before giving the materials to the reviewer. The expected immutable hashes are:

| Experiment | Artifact | SHA-256 |
|---|---|---|
| 1 | `experiment-1-contract-audit/baseline-input.json` | `fd63aa61dd7801c506f4c7a718f33efe136c45b77c86c27aa56b864b209e6bc3` |
| 1 | `experiment-1-contract-audit/VulnerableVault.sol` | `55f086ff440bb557c4a1af5b9e5c7332937fd4852193a16c4a95d190f55eda69` |
| 2 | `experiment-2-token-risk/baseline-input.json` | `ded1f96420272dc73fd2721eb3e0ba00f3317e4b0aaa03e3c559fa4232c65a74` |
| 2 | `experiment-2-token-risk/baseline-rpc-raw.json` | `6af123da8d877646326d4a09d3b037c0e1d035be07cef8e9cc8ae6b19f4383e3` |
| 3 | `experiment-3-due-diligence/baseline-input.json` | `a26d02fb6b0747f6dff082daa8170371cc92b038079741faf23cdb35d34b09a6` |
| 3 | `experiment-3-due-diligence/verified-source-input.json` | `7980db97f9d11001ca1467bdc093d800e20cbed774549247db1bdebf12c7403f` |

`baseline-rpc-raw.json` is an allowed reproducible direct-RPC artifact for Experiment 2 only after the reviewer independently fixes the same report block; it must not be accompanied by any Agent report.

## Blind execution

For each experiment, follow its `baseline-protocol.md` exactly and use at most one ordinary general-purpose LLM chat plus the tools explicitly allowed by `baseline-input.json`.

1. Start the wall timer and activity log.
2. Record every prompt, tool command, returned output, manual correction, and external source URL.
3. Produce the exact artifact path declared by `expectedOutput.artifact`:
   - `experiment-1-contract-audit/baseline-output.json`
   - `experiment-2-token-risk/baseline-output.json`
   - `experiment-3-due-diligence/baseline-output.json`
4. Include wall duration, human active minutes, model/provider, token or message usage if exposed, tool versions, and the required report fields from the input bundle.
5. Stop editing. Record the output SHA-256 and UTC freeze time before opening any forbidden evidence.

## Post-freeze adjudication

After all three outputs are frozen:

- Experiment 1: reveal `ground-truth.json` (expected SHA-256 `07d485077cee54597a7346c469b13bf6eb5865ed6427580b3dfeb9057f85aa22`) and adjudicate every baseline and Agent finding as TP/FP/FN, with severity and source-line accuracy.
- Experiment 2: reveal the paid report, independent verifier report, executed sellability evidence, and 422-holder snapshot. Score factual accuracy, coverage, block binding, and unsupported claims separately.
- Experiment 3: inspect all 24 normalized Slither detections in `baseline-slither-output-attempt-2.json` (SHA-256 `a0a32ede3084549b8450c8ba554beb467596119c7265178d625e27abcf7cc5fe`). Give each an explicit `true-positive`, `false-positive`, `needs-runtime-evidence`, or `dependency-signal` verdict with source lines and rationale. Then compare the frozen trust decision against the four-Agent paid result.

Record corrections in a new append-only adjudication artifact; never rewrite the frozen baseline output. The final sign-off must state whether the reviewer was independent and human. A model or project contributor must not set that field to `true`.

## Existing non-human reference

`experiment-3-due-diligence/claude-blind-review-candidate.json` is an isolated independent-AI review (SHA-256 `7a1aafeabed633b9ec94a6f7fccb6bcf20b09a807e019f9b5ad59fe3e40eda6b`). It already adjudicates every Slither row in order, but correctly declares `noHumanGroundTruth: true`; keep it as a separate AI baseline.

## Optional acceptance

An additional human-review badge may be added only when all three frozen output files, the post-freeze adjudication file, timing/activity evidence, and reviewer declaration are present and `npm run verify:evidence` validates their hashes and internal totals. Until then, no product or document may claim independent-human review; this does not change the already completed official with/without-Agent comparison.
