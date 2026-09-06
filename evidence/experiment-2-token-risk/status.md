# Experiment 2 Status

Status: **paid Agent run and post-run measurement complete; controlled human comparison pending**.

Completed:

- paid Hunter → Investigator mission `ed7c47dd-3941-4976-b020-283e0104dc11`;
- confirmed `0.35 U` Permit2 settlement `0x28499559f40a390a91e385ec7cc9a61f00fb06e42d6b3f9b3cb2ebf9809f4013` with a request-bound signed receipt;
- deterministic BNB RPC report at block `128449782`: account state, bytecode, ERC-20 metadata, owner, EIP-1967 implementation/admin, selectors, opcode signals, and risk score;
- independent `risk-verifier-v1` replay through a different RPC transport, with all 11 checks confirmed and zero mismatches;
- historical PancakeSwap V2/V3 U/WBNB liquidity and bounded recent-Transfer evidence bound to the immutable paid report hash;
- actual `0.1 U` PancakeSwap V2 sellability execution at block `128609428`, protected by 5% maximum slippage; output exceeded `minimumOut` and final Router allowance was zero;
- all 422 BscScan holder-index rows captured and independently read with `balanceOf` at locked block `128634278`;
- the 422 positive balances sum exactly to onchain `totalSupply = 10005250000000000000000000000`, with zero missing supply or read failures;
- post-run coverage increased from the immutable paid report's 5/8 to 8/8. The original paid report remains unchanged;
- Signature Checker, Permit2 allowance, and Session revoked; post-revoke transfer rejected and local encrypted Session material deleted;
- ordinary model + direct-RPC candidate frozen with full operator/model/timing disclosure.

Evidence:

- `paid-run-output.json`
- `security-review-output.json`
- `indexed-enrichment-output.json`
- `holder-snapshot-output.json`
- `sellability-execution-output.json`
- `baseline-rpc-raw.json`
- `baseline-model-raw.json`
- `baseline-output-candidate.json`

Important limitations:

- the complete holder snapshot is exact at block `128634278`; it does not claim balances are unchanged later;
- candidate-set completeness relies on all five BscScan holder pages, while every balance and the final supply reconciliation are verified independently onchain;
- liquidity coverage is scoped to PancakeSwap V2/V3 U/WBNB, not every DEX and quote asset;
- the `0.1 U` execution proves that recorded route/size at its transaction block, not unlimited future sellability;
- the model-only candidate is not an independent-human controlled baseline;
- human ground-truth sign-off remains pending under `evidence/CONTROLLED_REVIEW_HANDOFF.md`.

`npm run verify:evidence` checks the report hashes, independent review, 422 unique ranked holder rows, exact balance sum, sellability limits/transactions/zero allowance, and all enrichment bindings without accessing the network or broadcasting a transaction.
