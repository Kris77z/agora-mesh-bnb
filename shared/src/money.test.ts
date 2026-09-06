import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssetRef, Money } from "./types.js";
import {
  addMoney,
  compareMoney,
  formatMoney,
  parseMoney,
  sameAsset,
  subtractMoney
} from "./money.js";

const TBNB: AssetRef = {
  chainId: 97,
  kind: "native",
  symbol: "tBNB",
  decimals: 18
};

const USDT_18: AssetRef = {
  chainId: 97,
  kind: "erc20",
  address: "0x0000000000000000000000000000000000000001",
  symbol: "USDT",
  decimals: 18
};

const USDT_6: AssetRef = {
  chainId: 1,
  kind: "erc20",
  address: "0x0000000000000000000000000000000000000001",
  symbol: "USDT",
  decimals: 6
};

describe("money", () => {
  it("parses and formats 18-decimal and 6-decimal assets", () => {
    const bnb = parseMoney("1.25", TBNB);
    assert.equal(bnb.amount, "1250000000000000000");
    assert.equal(formatMoney(bnb), "1.25");

    const usdt = parseMoney("100.000001", USDT_6);
    assert.equal(usdt.amount, "100000001");
    assert.equal(formatMoney(usdt), "100.000001");
  });

  it("keeps amounts larger than Number.MAX_SAFE_INTEGER exact", () => {
    const large = parseMoney("123456789012345678901234567890.123456789012345678", USDT_18);
    assert.equal(
      large.amount,
      "123456789012345678901234567890123456789012345678"
    );
    assert.equal(formatMoney(large), "123456789012345678901234567890.123456789012345678");
  });

  it("adds, subtracts, and compares only matching assets", () => {
    const one = parseMoney("1", TBNB);
    const two = parseMoney("2", TBNB);
    assert.equal(addMoney(one, two).amount, "3000000000000000000");
    assert.equal(subtractMoney(two, one).amount, "1000000000000000000");
    assert.equal(compareMoney(one, two), -1);
    assert.equal(compareMoney(two, two), 0);
  });

  it("rejects cross-asset math and excess precision", () => {
    const bnb = parseMoney("1", TBNB);
    const usdt = parseMoney("1", USDT_18);
    assert.equal(sameAsset(TBNB, USDT_18), false);
    assert.throws(() => addMoney(bnb, usdt), /different assets/);
    assert.throws(() => parseMoney("1.0000001", USDT_6), /exceeds USDT precision/);
    assert.throws(
      () => subtractMoney(bnb, { ...bnb, amount: "2000000000000000000" } as Money),
      /negative amount/
    );
  });
});
