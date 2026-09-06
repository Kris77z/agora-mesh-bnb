import type { AssetRef, Money } from "./types.js";

const INTEGER_AMOUNT = /^\d+$/;
const DISPLAY_AMOUNT = /^(\d+)(?:\.(\d+))?$/;

function assertDecimals(decimals: number): void {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`Invalid asset decimals: ${decimals}`);
  }
}

export function assertAmount(amount: string): void {
  if (!INTEGER_AMOUNT.test(amount)) {
    throw new Error(`Amount must be a non-negative integer string: ${amount}`);
  }
}

export function sameAsset(a: AssetRef, b: AssetRef): boolean {
  if (
    a.chainId !== b.chainId ||
    a.kind !== b.kind ||
    a.symbol !== b.symbol ||
    a.decimals !== b.decimals
  ) {
    return false;
  }
  if (a.kind === "native") {
    return true;
  }
  return a.address?.toLowerCase() === b.address?.toLowerCase();
}

export function assertAsset(asset: AssetRef): void {
  if (!Number.isSafeInteger(asset.chainId) || asset.chainId <= 0) {
    throw new Error(`Invalid asset chainId: ${asset.chainId}`);
  }
  if (!asset.symbol.trim()) {
    throw new Error("Asset symbol is required");
  }
  assertDecimals(asset.decimals);
  if (asset.kind === "erc20" && !/^0x[0-9a-fA-F]{40}$/.test(asset.address ?? "")) {
    throw new Error("ERC-20 asset requires a 20-byte address");
  }
  if (asset.kind === "native" && asset.address !== undefined) {
    throw new Error("Native asset must not include an address");
  }
}

export function assertMoney(money: Money): void {
  assertAsset(money.asset);
  assertAmount(money.amount);
}

export function parseMoney(displayAmount: string, asset: AssetRef): Money {
  assertAsset(asset);
  const match = DISPLAY_AMOUNT.exec(displayAmount.trim());
  if (!match) {
    throw new Error(`Invalid display amount: ${displayAmount}`);
  }
  const whole = match[1];
  const fraction = match[2] ?? "";
  if (fraction.length > asset.decimals) {
    throw new Error(
      `Amount ${displayAmount} exceeds ${asset.symbol} precision (${asset.decimals} decimals)`
    );
  }
  const raw = `${whole}${fraction.padEnd(asset.decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return { asset, amount: raw || "0" };
}

export function formatMoney(
  money: Money,
  options: { maxFractionDigits?: number; trimTrailingZeros?: boolean } = {}
): string {
  assertMoney(money);
  const { decimals } = money.asset;
  if (decimals === 0) {
    return money.amount;
  }

  const padded = money.amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const maxFractionDigits = options.maxFractionDigits ?? decimals;
  if (!Number.isSafeInteger(maxFractionDigits) || maxFractionDigits < 0) {
    throw new Error(`Invalid maxFractionDigits: ${maxFractionDigits}`);
  }
  let fraction = padded.slice(-decimals).slice(0, maxFractionDigits);
  if (options.trimTrailingZeros ?? true) {
    fraction = fraction.replace(/0+$/, "");
  }
  return fraction ? `${whole}.${fraction}` : whole;
}

function assertSameMoneyAsset(a: Money, b: Money): void {
  assertMoney(a);
  assertMoney(b);
  if (!sameAsset(a.asset, b.asset)) {
    throw new Error("Cannot operate on different assets");
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameMoneyAsset(a, b);
  return {
    asset: a.asset,
    amount: (BigInt(a.amount) + BigInt(b.amount)).toString()
  };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameMoneyAsset(a, b);
  const result = BigInt(a.amount) - BigInt(b.amount);
  if (result < 0n) {
    throw new Error("Money subtraction cannot produce a negative amount");
  }
  return { asset: a.asset, amount: result.toString() };
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameMoneyAsset(a, b);
  const left = BigInt(a.amount);
  const right = BigInt(b.amount);
  return left < right ? -1 : left > right ? 1 : 0;
}
