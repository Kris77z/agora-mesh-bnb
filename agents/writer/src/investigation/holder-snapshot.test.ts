import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import {
  ERC20_TRANSFER_TOPIC,
  holderSharePartsPerMillion,
  replayHolderLedger,
  topHolderSharePartsPerMillion,
  type HolderTransferLog
} from "./holder-snapshot.js";

function addressTopic(address: string): string {
  return ethers.zeroPadValue(address, 32);
}

function transfer(input: {
  block: number;
  logIndex: number;
  from: string;
  to: string;
  amount: bigint;
}): HolderTransferLog {
  return {
    blockNumber: ethers.toQuantity(input.block),
    transactionHash: ethers.keccak256(ethers.toUtf8Bytes(`${input.block}:${input.logIndex}`)),
    transactionIndex: "0x0",
    logIndex: ethers.toQuantity(input.logIndex),
    topics: [ERC20_TRANSFER_TOPIC, addressTopic(input.from), addressTopic(input.to)],
    data: ethers.zeroPadValue(ethers.toBeHex(input.amount), 32)
  };
}

test("replayHolderLedger rebuilds mint, transfer, and burn balances in chain order", () => {
  const alice = "0x00000000000000000000000000000000000000A1";
  const bob = "0x00000000000000000000000000000000000000B2";
  const replay = replayHolderLedger([
    transfer({ block: 3, logIndex: 0, from: bob, to: ethers.ZeroAddress, amount: 10n }),
    transfer({ block: 1, logIndex: 0, from: ethers.ZeroAddress, to: alice, amount: 100n }),
    transfer({ block: 2, logIndex: 0, from: alice, to: bob, amount: 40n })
  ]);

  assert.equal(replay.minted, 100n);
  assert.equal(replay.burned, 10n);
  assert.equal(replay.supply, 90n);
  assert.deepEqual(replay.balances.map((holder) => holder.balance), [60n, 30n]);
  assert.equal(replay.participantAddresses.length, 2);
  assert.equal(topHolderSharePartsPerMillion(replay.balances, replay.supply, 1), 666_666);
  assert.equal(holderSharePartsPerMillion(30n, replay.supply), 333_333);
});

test("replayHolderLedger fails closed when the event history starts after a transfer", () => {
  assert.throws(
    () => replayHolderLedger([
      transfer({
        block: 2,
        logIndex: 0,
        from: "0x00000000000000000000000000000000000000A1",
        to: "0x00000000000000000000000000000000000000B2",
        amount: 1n
      })
    ]),
    /history is incomplete or inconsistent/
  );
});
