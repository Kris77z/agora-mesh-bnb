# Experiment 3 Input

Status: locked candidate input.

Task:

> Should the United Stables (`U`) contract used by Apex on BNB Testnet be trusted?

Same-target evidence boundary:

- chain: BNB Smart Chain Testnet (`97`);
- proxy: `0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565`;
- EIP-1967 implementation: `0x6b5C44Cbd4bbDDf11723557BA1B77ec5E33225Cc`;
- verified source unit: `src/StablecoinV2.sol`;
- verified source hash: `sha256:9f1ddcbd5fab6622ba8ab3a761f76b0f352bcbf890cf5f36698b778ebd7ed78c`;
- onchain report block: `128449782`;
- source compiler: Solidity `0.8.28`, using the explorer-provided remappings.

Every component must bind to this implementation/source hash or to the original
onchain report hash, target, and block. Evidence for another address, source, or
block cannot be substituted.

The current output is a same-target candidate. It reuses the paid Experiment 2
Investigator evidence and runs local unpaid source verification. It is not the
plan's final paid end-to-end Experiment 3 run.
