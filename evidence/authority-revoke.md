# Authority Revoke Evidence

- Network: BNB Smart Chain Testnet (chain ID 97)
- Authority: `altana-x402-30c0de11-256b-47c2-86e6-db6d8a303a0e`
- Wallet: `0x8BA5452112F7E9c339da8E6f38C896B2A0B2E53d`
- U token: `0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565`
- Permit2: `0x000000000022D473030F116dDEE9F6B43aC78BA3`
- Executed at: `2026-09-01T06:11:02Z`

## Confirmed transactions

1. Signature checker revoked: `0xb933a21a18e6e9ed44b05d0d4788028e3a30b73fdece6ef57b3d102826c8a839`
2. U allowance for Permit2 set to zero: `0x0f657becff2e5843696be849fbf397ba27f31b1eca3621793b53aeeda45064f5`
3. Session revoked: `0x9a05f49ecd61d169653b13d0096c4b6a29a05d268495a99c85fd9c0d40c88e1b`

Independent JSON-RPC reads returned receipt status `0x1` for all three transactions. The ERC-20 `allowance(wallet, Permit2)` read returned `0`.

## Negative payment test

After the session revoke transaction confirmed, the script attempted a one-base-unit U transfer to the approved Auditor recipient. Altana Relay rejected `wallet_prepareCalls` because the revoked key hash was unknown. No U was transferred; the wallet balance remained 8.5 U.

The encrypted Session record was then deleted. The public evidence store contains the revoked Authority metadata and no `signerPrivateKey` field. `/authority` reports `revoked`, `negativeTest.rejected: true`, and `sessionMaterialDeleted: true`.
