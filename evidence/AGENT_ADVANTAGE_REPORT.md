# Agent Advantage Report

Status: **three documented comparisons available; submission eligibility and judging outcome are not certified**.

The official challenge requires three real tasks run with an agent hired through the marketplace and without that marketplace-agent workflow, with time, cost, output quality, and raw outputs attached. It does not require a human reviewer. This report presents the automated/operator baselines with their individual methodology disclosures while explicitly stating that no independent human review was performed.

| Experiment | With Agora Mesh | Without marketplace agent | Agent quality | Baseline quality | Result |
|---|---:|---:|---:|---:|---|
| Contract audit | 307.1s · 0.75 testnet U | 272.0s · $0.0474 est. | 100/100 | 86.67/100 | +13.33 quality; independent verifier and onchain receipts added |
| Token risk | 59.8s · 0.35 testnet U | 39.9s · $0.0381 est. | 100/100 | 85/100 | +15 quality; coverage improved from 5/8 to 8/8 |
| Full due diligence | 2092.4s · 1.35 testnet U net | 185.7s · $0.6478 | 95/100 | 90/100 | +5 quality; four paid agents plus runtime/market/payment evidence |

## Disclosure

- Baseline reviewers are an automated operator or an independent AI; none is described as human.
- Agent costs are nominal BNB Testnet U payments. Testnet U has no real monetary value and is not asserted to equal USD.
- Estimated Kimi costs use recorded tokens and disclosed list-price equivalents; Claude cost came from the isolated CLI run.
- Raw outputs, transaction hashes, rubrics, hashes, limitations, and every one of the 24 Slither adjudications are stored beside this report.

## Delivery-time interpretation (2026-09-06)

These measurements establish an evidence-quality tradeoff, not a speed or USD cost win. All three recorded Agent delivery times exceed their baselines. Testnet U payments cannot be compared economically with USD API costs. User hands-on time and a matched Agent-side model/tool USD cost are not yet measured.

Experiment 3's 2,092.395 seconds is the full elapsed delivery window across two persisted missions, not model inference time:

- Audit/finding verification mission `c311466f-85e4-469c-bbd7-e1ced0a3fe57`: 138.116 seconds (2026-09-02 03:51:24.703–03:53:42.819 UTC).
- Interval before supplemental mission: 1,890.705 seconds, including operational recovery/supplement preparation; the trace does not measure each activity separately.
- Investigation/risk verification mission `4d3dca34-439f-469d-99f1-4de40849087d`: 63.574 seconds (04:25:13.524–04:26:17.098 UTC).

The two mission intervals sum to 201.690 seconds. This excludes the inter-phase interval and is diagnostic only; it does not replace the 2,092.395-second benchmark or justify claiming a new optimized result. Source: the `createdAt`/`completedAt` fields and trace timestamps in `registry/missions.json`.

Next matched measurement: lock source/block and tool access; capture end-to-end time including retries, hands-on time, model token cost, tool cost and service price separately; grade blinded outputs using the same rubric. Retain old runs and append a new experiment rather than overwriting them.
