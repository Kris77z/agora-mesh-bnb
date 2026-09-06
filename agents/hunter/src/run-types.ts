import type {
  CommanderBudget,
  CommanderPhaseResult,
  ExecuteSuccessResponse,
  PaymentRequiredResponse,
  ServiceInfo,
  TokenRiskVerificationReport,
  VerificationReport,
  X402ExecuteSuccessResponse,
  X402PaymentRequirement
} from "@rebel/shared";
import type { Experience } from "./memory.js";

interface BaseHunterRunResult {
  missionId: string;
  goal: string;
  service: ServiceInfo;
  quote: PaymentRequiredResponse | X402PaymentRequirement;
  paymentTx: string;
  execution: ExecuteSuccessResponse | X402ExecuteSuccessResponse;
  receiptVerified: boolean;
  evaluation: {
    score: number;
    summary: string;
  };
  reflection?: Experience;
  verification?: {
    service: ServiceInfo;
    quote: PaymentRequiredResponse | X402PaymentRequirement;
    paymentTx: string;
    execution: ExecuteSuccessResponse | X402ExecuteSuccessResponse;
    receiptVerified: boolean;
    report: VerificationReport;
  };
  riskReview?: {
    service: ServiceInfo;
    quote: PaymentRequiredResponse | X402PaymentRequirement;
    paymentTx: string;
    execution: ExecuteSuccessResponse | X402ExecuteSuccessResponse;
    receiptVerified: boolean;
    report: TokenRiskVerificationReport;
  };
  finalMessage: string;
}

export interface SingleHunterRunResult extends BaseHunterRunResult {
  mode: "scripted" | "react";
}

export interface CommanderHunterRunResult extends BaseHunterRunResult {
  mode: "commander";
  phases: CommanderPhaseResult[];
  budget: CommanderBudget;
}

export type HunterRunResult = SingleHunterRunResult | CommanderHunterRunResult;
