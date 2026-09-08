# Altana Explorer indexed-display acceptance — 2026-09-06

Method: read-only browser visit to the official Altana Keystore Explorer (Testnet) at
`https://testnet.altana.network/account/<address>`. No signing, no payment, no state change.
Screenshots in this directory were captured during the visit.

## Account 1 — Passkey wallet `0xc7B8c226fFdac9b5218ab570bc6c1d443275d28c`

Rendered as a Smart account with 1 active key, 3 total keys, 3 chains, 4 events.

Keys table (chain BNB):

| Key | Type | State |
|---|---|---|
| `0x7dc312…603dd0` | Root | Active |
| `0xf0caa7…4bb175` | Session | Expired |
| `0x3d96da…55be3b` | Session | Revoked |

Recent activity (all on BNB): `Key registered` ×3 (with tx fees 0.000660 / 0.00133 / 0.00133 BNB)
and `Key revoked` ×1, matching the Passkey grant/revoke lifecycle in
`../PASSKEY_ACCEPTANCE.md`.

Screenshot: `passkey-account-0xc7B8-keys-20260906.jpg`

## Account 2 — Keystore smart wallet `0x8BA5452112F7E9c339da8E6f38C896B2A0B2E53d`

Rendered as a Smart account with 1 active key, 7 total keys, 3 chains, 13 events
(7 `Registered`, 6 `Revoked`). Root key `0xce32d9…1aa16e` is Active; listed session keys
(`0x4f5b32…e42837`, `0x2694ef…7eef17`, `0x6bbe2d…ed8ef0`, `0x30e96c…e8951e`, …) are Revoked,
matching the historical Authority grant/revoke cycles (stability, offer-v2, experiments).

Screenshots: `keystore-account-0x8BA5-keys-20260906.jpg`,
`keystore-account-0x8BA5-activity-20260906.jpg`

## Boundary

The Keystore Explorer indexes account/key lifecycle events (session registration, revocation,
sync). The U-token service settlement transactions themselves are indexed on BscScan Testnet and
are referenced by hash in the frozen payment evidence; they are not expected to appear as
Keystore events. This acceptance confirms visible indexed display of the wallets, sessions and
their register/revoke transactions in the Altana explorer, which is what the Altana track
requirement and our P0 gap referred to.
