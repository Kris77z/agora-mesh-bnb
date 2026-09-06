import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CommanderBudget, Money } from "@rebel/shared";
import {
  applyCommanderPhaseSpend,
  buildCommanderBudget,
  getCommanderBudgetBlockReason
} from "./commander-budget.js";

const TBNB = {
  chainId: 97,
  kind: "native" as const,
  symbol: "tBNB",
  decimals: 18
};

function money(amount: string): Money {
  return { asset: TBNB, amount };
}

function budget(input: {
  maxPhases: number;
  phaseCount: number;
  maxPerPhase: string;
  maxTotal: string;
  spent: string;
}): CommanderBudget {
  return {
    maxPhases: input.maxPhases,
    phaseCount: input.phaseCount,
    maxPerPhase: money(input.maxPerPhase),
    maxTotal: money(input.maxTotal),
    spent: money(input.spent)
  };
}

describe("commander-budget", () => {
  it("buildCommanderBudget returns BNB defaults", () => {
    const result = buildCommanderBudget({});
    assert.equal(result.maxPhases, 6);
    assert.equal(result.maxPerPhase.amount, "20000000000000000");
    assert.equal(result.maxTotal.amount, "60000000000000000");
    assert.equal(result.spent.amount, "0");
    assert.equal(result.maxTotal.asset.symbol, "tBNB");
    assert.equal(result.phaseCount, 0);
  });

  it("buildCommanderBudget ignores invalid env values", () => {
    const result = buildCommanderBudget({
      COMMANDER_MAX_PHASES: "0",
      COMMANDER_MAX_PER_PHASE_AMOUNT: "abc",
      COMMANDER_MAX_TOTAL_AMOUNT: "-1"
    });
    assert.equal(result.maxPerPhase.amount, "20000000000000000");
    assert.equal(result.maxTotal.amount, "60000000000000000");
  });

  it("buildCommanderBudget accepts generic amount overrides", () => {
    const result = buildCommanderBudget({
      COMMANDER_MAX_PHASES: "9",
      COMMANDER_MAX_PER_PHASE_AMOUNT: "120",
      COMMANDER_MAX_TOTAL_AMOUNT: "550"
    });
    assert.equal(result.maxPhases, 9);
    assert.equal(result.maxPerPhase.amount, "120");
    assert.equal(result.maxTotal.amount, "550");
  });

  it("uses a separate $U budget when x402 is enabled", () => {
    const result = buildCommanderBudget({
      X402_ENABLED: "true",
      COMMANDER_X402_MAX_PER_PHASE_AMOUNT: "500000000000000000",
      COMMANDER_X402_MAX_TOTAL_AMOUNT: "1500000000000000000"
    });
    assert.equal(result.maxPerPhase.amount, "500000000000000000");
    assert.equal(result.maxTotal.amount, "1500000000000000000");
    assert.equal(result.maxTotal.asset.kind, "erc20");
    assert.equal(result.maxTotal.asset.symbol, "U");
    assert.equal(result.maxTotal.asset.decimals, 18);
  });

  it("keeps legacy Wei env names as a migration fallback", () => {
    const result = buildCommanderBudget({
      COMMANDER_MAX_PER_PHASE_WEI: "120",
      COMMANDER_MAX_TOTAL_WEI: "550"
    });
    assert.equal(result.maxPerPhase.amount, "120");
    assert.equal(result.maxTotal.amount, "550");
  });

  it("getCommanderBudgetBlockReason checks phase and total limits", () => {
    assert.equal(
      getCommanderBudgetBlockReason({
        budget: budget({
          maxPhases: 2,
          phaseCount: 2,
          maxPerPhase: "10",
          maxTotal: "100",
          spent: "20"
        })
      }),
      "Phase limit reached (2)."
    );
    assert.match(
      getCommanderBudgetBlockReason({
        budget: budget({
          maxPhases: 5,
          phaseCount: 2,
          maxPerPhase: "10",
          maxTotal: "100",
          spent: "100"
        })
      }) ?? "",
      /Total budget exhausted/
    );
  });

  it("localizes budget reasons for zh-CN", () => {
    assert.equal(
      getCommanderBudgetBlockReason({
        budget: budget({
          maxPhases: 2,
          phaseCount: 2,
          maxPerPhase: "10",
          maxTotal: "100",
          spent: "20"
        }),
        locale: "zh-CN"
      }),
      "已达到阶段上限（2）。"
    );

    const total = applyCommanderPhaseSpend({
      budget: budget({
        maxPhases: 6,
        phaseCount: 0,
        maxPerPhase: "100",
        maxTotal: "90",
        spent: "50"
      }),
      phaseSpent: money("40"),
      locale: "zh-CN"
    });
    assert.match(total.stopReason ?? "", /总花费已达到/);
  });

  it("applyCommanderPhaseSpend increments counters", () => {
    const updated = applyCommanderPhaseSpend({
      budget: budget({
        maxPhases: 6,
        phaseCount: 1,
        maxPerPhase: "100",
        maxTotal: "1000",
        spent: "90"
      }),
      phaseSpent: money("10")
    });
    assert.equal(updated.budget.phaseCount, 2);
    assert.equal(updated.budget.spent.amount, "100");
    assert.equal(updated.stopReason, undefined);
  });

  it("applyCommanderPhaseSpend flags per-phase and total overrun", () => {
    const perPhase = applyCommanderPhaseSpend({
      budget: budget({
        maxPhases: 6,
        phaseCount: 0,
        maxPerPhase: "50",
        maxTotal: "1000",
        spent: "0"
      }),
      phaseSpent: money("80")
    });
    assert.match(perPhase.stopReason ?? "", /per-phase limit/);

    const total = applyCommanderPhaseSpend({
      budget: budget({
        maxPhases: 6,
        phaseCount: 0,
        maxPerPhase: "100",
        maxTotal: "90",
        spent: "50"
      }),
      phaseSpent: money("40")
    });
    assert.match(total.stopReason ?? "", /Total spend reached/);
  });

  it("rejects spending a different asset", () => {
    assert.throws(
      () =>
        applyCommanderPhaseSpend({
          budget: budget({
            maxPhases: 6,
            phaseCount: 0,
            maxPerPhase: "100",
            maxTotal: "1000",
            spent: "0"
          }),
          phaseSpent: {
            asset: { ...TBNB, chainId: 56, symbol: "BNB" },
            amount: "1"
          }
        }),
      /different assets/
    );
  });
});
