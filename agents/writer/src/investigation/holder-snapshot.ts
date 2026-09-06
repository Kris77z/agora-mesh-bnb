import { ethers } from "ethers";

const ZERO_ADDRESS = ethers.ZeroAddress.toLowerCase();
export const ERC20_TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

export interface HolderTransferLog {
  blockNumber: string;
  transactionHash: string;
  transactionIndex?: string;
  logIndex: string;
  topics: string[];
  data: string;
}

export interface ReplayedHolderBalance {
  address: string;
  balance: bigint;
}

export interface HolderLedgerReplay {
  balances: ReplayedHolderBalance[];
  participantAddresses: string[];
  minted: bigint;
  burned: bigint;
  supply: bigint;
}

function checkedQuantity(value: string, label: string): bigint {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} is not a valid JSON-RPC quantity`);
  }
  return BigInt(value);
}

function addressFromTopic(topic: string, label: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(topic)) {
    throw new Error(`${label} is not a 32-byte topic`);
  }
  return ethers.getAddress(`0x${topic.slice(-40)}`);
}

function compareLogs(left: HolderTransferLog, right: HolderTransferLog): number {
  const leftParts = [left.blockNumber, left.transactionIndex ?? "0x0", left.logIndex]
    .map((value, index) => checkedQuantity(value, `left log order field ${index}`));
  const rightParts = [right.blockNumber, right.transactionIndex ?? "0x0", right.logIndex]
    .map((value, index) => checkedQuantity(value, `right log order field ${index}`));
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index]! < rightParts[index]!) return -1;
    if (leftParts[index]! > rightParts[index]!) return 1;
  }
  return 0;
}

export function replayHolderLedger(logs: readonly HolderTransferLog[]): HolderLedgerReplay {
  const balances = new Map<string, bigint>();
  const checksummed = new Map<string, string>();
  const participants = new Set<string>();
  let minted = 0n;
  let burned = 0n;

  for (const [index, log] of [...logs].sort(compareLogs).entries()) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)) {
      throw new Error(`Transfer log ${index} has an invalid transaction hash`);
    }
    if (log.topics.length < 3) {
      throw new Error(`Transfer log ${index} has fewer than three topics`);
    }
    if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) {
      throw new Error(`Transfer log ${index} does not have the ERC-20 Transfer signature`);
    }
    const from = addressFromTopic(log.topics[1]!, `Transfer log ${index} sender`);
    const to = addressFromTopic(log.topics[2]!, `Transfer log ${index} recipient`);
    const amount = checkedQuantity(log.data, `Transfer log ${index} value`);
    const fromKey = from.toLowerCase();
    const toKey = to.toLowerCase();

    if (fromKey === ZERO_ADDRESS) {
      minted += amount;
    } else {
      participants.add(fromKey);
      checksummed.set(fromKey, from);
      const prior = balances.get(fromKey) ?? 0n;
      if (prior < amount) {
        throw new Error(
          `Transfer log ${index} would make ${from} negative; the history is incomplete or inconsistent`
        );
      }
      balances.set(fromKey, prior - amount);
    }

    if (toKey === ZERO_ADDRESS) {
      burned += amount;
    } else {
      participants.add(toKey);
      checksummed.set(toKey, to);
      balances.set(toKey, (balances.get(toKey) ?? 0n) + amount);
    }
  }

  return {
    balances: [...balances.entries()]
      .filter(([, balance]) => balance > 0n)
      .map(([address, balance]) => ({ address: checksummed.get(address)!, balance }))
      .sort((left, right) => left.balance === right.balance ? 0 : left.balance > right.balance ? -1 : 1),
    participantAddresses: [...participants]
      .map((address) => checksummed.get(address)!)
      .sort((left, right) => left.localeCompare(right)),
    minted,
    burned,
    supply: minted - burned
  };
}

export function holderSharePartsPerMillion(balance: bigint, totalSupply: bigint): number {
  if (balance < 0n || totalSupply <= 0n || balance > totalSupply) {
    throw new Error("Holder balance and total supply cannot produce a valid concentration share");
  }
  return Number((balance * 1_000_000n) / totalSupply);
}

export function topHolderSharePartsPerMillion(
  balances: readonly ReplayedHolderBalance[],
  totalSupply: bigint,
  count: number
): number {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error("Top-holder count must be a positive safe integer");
  }
  const total = balances.slice(0, count).reduce((sum, holder) => sum + holder.balance, 0n);
  return holderSharePartsPerMillion(total, totalSupply);
}
