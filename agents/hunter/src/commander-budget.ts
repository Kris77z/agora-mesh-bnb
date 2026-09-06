import {
  addMoney,
  compareMoney,
  DEFAULT_LANGUAGE_CODE,
  formatMoney,
  localizeByLocale,
  resolveChainConfig,
  type AssetRef,
  type CommanderBudget,
  type LanguageCode
} from "@rebel/shared";
import { U_TOKEN } from "@altananetwork/x402-server";

const DEFAULT_MAX_PHASES = 6;
const DEFAULT_MAX_TOTAL_AMOUNT = "60000000000000000";
const DEFAULT_MAX_PER_PHASE_AMOUNT = "20000000000000000";
const DEFAULT_X402_MAX_TOTAL_AMOUNT = "3000000000000000000";
const DEFAULT_X402_MAX_PER_PHASE_AMOUNT = "1000000000000000000";

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseAmount(raw: string | undefined, fallback: string): string {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? trimmed : fallback;
}

export function formatCommanderMoney(money: CommanderBudget["spent"]): string {
  return `${formatMoney(money, { maxFractionDigits: 4 })} ${money.asset.symbol}`;
}

export function buildCommanderBudget(
  env: NodeJS.ProcessEnv = process.env,
  assetOverride?: AssetRef
): CommanderBudget {
  const chain = resolveChainConfig({ preset: env.CHAIN_PRESET, chainId: env.CHAIN_ID });
  const useX402 = env.X402_ENABLED === "true" && chain.chainId === 97;
  const x402Token = U_TOKEN[97];
  const asset =
    assetOverride ??
    (useX402
      ? {
          chainId: 97,
          kind: "erc20" as const,
          address: x402Token.address,
          symbol: x402Token.symbol,
          decimals: x402Token.decimals
        }
      : chain.nativeAsset);
  const maxTotalAmount = parseAmount(
    useX402
      ? env.COMMANDER_X402_MAX_TOTAL_AMOUNT
      : env.COMMANDER_MAX_TOTAL_AMOUNT ?? env.COMMANDER_MAX_TOTAL_WEI,
    useX402 ? DEFAULT_X402_MAX_TOTAL_AMOUNT : DEFAULT_MAX_TOTAL_AMOUNT
  );
  const maxPerPhaseAmount = parseAmount(
    useX402
      ? env.COMMANDER_X402_MAX_PER_PHASE_AMOUNT
      : env.COMMANDER_MAX_PER_PHASE_AMOUNT ?? env.COMMANDER_MAX_PER_PHASE_WEI,
    useX402 ? DEFAULT_X402_MAX_PER_PHASE_AMOUNT : DEFAULT_MAX_PER_PHASE_AMOUNT
  );
  return {
    maxTotal: { asset, amount: maxTotalAmount },
    maxPerPhase: { asset, amount: maxPerPhaseAmount },
    maxPhases: parsePositiveInt(env.COMMANDER_MAX_PHASES, DEFAULT_MAX_PHASES),
    spent: { asset, amount: "0" },
    phaseCount: 0
  };
}

export function getCommanderBudgetBlockReason(input: {
  budget: CommanderBudget;
  stopReason?: string;
  locale?: LanguageCode;
}): string | null {
  const { budget, stopReason, locale = DEFAULT_LANGUAGE_CODE } = input;
  if (stopReason) {
    return stopReason;
  }
  if (budget.phaseCount >= budget.maxPhases) {
    return localizeByLocale(locale, {
      en: `Phase limit reached (${budget.maxPhases}).`,
      zh: `已达到阶段上限（${budget.maxPhases}）。`
    });
  }
  if (compareMoney(budget.spent, budget.maxTotal) >= 0) {
    return localizeByLocale(locale, {
      en: `Total budget exhausted (${formatCommanderMoney(budget.maxTotal)}).`,
      zh: `总预算已耗尽（${formatCommanderMoney(budget.maxTotal)}）。`
    });
  }
  return null;
}

export function applyCommanderPhaseSpend(input: {
  budget: CommanderBudget;
  phaseSpent: CommanderBudget["spent"];
  stopReason?: string;
  locale?: LanguageCode;
}): { budget: CommanderBudget; stopReason?: string } {
  const { budget, phaseSpent, stopReason, locale = DEFAULT_LANGUAGE_CODE } = input;
  const nextBudget: CommanderBudget = {
    ...budget,
    phaseCount: budget.phaseCount + 1,
    spent: addMoney(budget.spent, phaseSpent)
  };

  if (stopReason) {
    return { budget: nextBudget, stopReason };
  }
  if (compareMoney(phaseSpent, nextBudget.maxPerPhase) > 0) {
    return {
      budget: nextBudget,
      stopReason: localizeByLocale(locale, {
        en: `Phase spend ${formatCommanderMoney(phaseSpent)} exceeds per-phase limit ${formatCommanderMoney(
          nextBudget.maxPerPhase
        )}.`,
        zh: `单阶段花费 ${formatCommanderMoney(phaseSpent)} 超过单阶段上限 ${formatCommanderMoney(
          nextBudget.maxPerPhase
        )}。`
      })
    };
  }
  if (compareMoney(nextBudget.spent, nextBudget.maxTotal) >= 0) {
    return {
      budget: nextBudget,
      stopReason: localizeByLocale(locale, {
        en: `Total spend reached ${formatCommanderMoney(nextBudget.spent)} (limit ${formatCommanderMoney(
          nextBudget.maxTotal
        )}).`,
        zh: `总花费已达到 ${formatCommanderMoney(nextBudget.spent)}（上限 ${formatCommanderMoney(
          nextBudget.maxTotal
        )}）。`
      })
    };
  }
  return { budget: nextBudget };
}
