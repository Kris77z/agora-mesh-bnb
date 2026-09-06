import type {
  ExecuteSuccessResponse,
  LanguageCode,
  PaymentRequiredResponse,
  ServiceInfo
} from "@rebel/shared";
import { z } from "zod";
import { HunterError } from "./errors.js";
import {
  filterServicesByTaskType,
  inferTaskTypeFromGoal,
  pickNativeTransferAccept,
  rankServicesByPreference
} from "./scripted-flow.js";
import { discoverServices } from "./tools/discover.js";
import { checkBalanceTool, makePaymentTool } from "./tools/payment.js";
import { reflectAndStoreExperience } from "./tools/reflect.js";
import { requestServiceQuoteWithFallback, submitPaymentAndGetResult } from "./tools/service.js";
import { evaluateResultTool, verifyReceiptTool } from "./tools/verify.js";
import { createGiveFeedbackTool } from "./react-feedback-tool.js";
import type { Experience } from "./memory.js";
import { hunterConfig } from "./config.js";

export interface QuoteAttempt {
  serviceId: string;
  ok: boolean;
  error?: string;
}

export interface HunterRuntimeState {
  goal: string;
  missionId: string;
  locale: LanguageCode;
  services: ServiceInfo[];
  service?: ServiceInfo;
  requestTaskType?: string;
  quote?: PaymentRequiredResponse;
  quoteAttempts?: QuoteAttempt[];
  paymentTx?: string;
  execution?: ExecuteSuccessResponse;
  evaluation?: { score: number; summary: string };
  receiptVerified?: boolean;
  reflection?: Experience;
  feedback?: {
    agentId: string;
    value: number;
    reviewer: string;
  };
}

export interface ReactToolSpec {
  description: string;
  schema: z.ZodTypeAny;
  jsonSchema: Record<string, unknown>;
  execute: (args: unknown) => Promise<unknown>;
}

async function buildQuoteCandidates(
  state: HunterRuntimeState,
  requestedTaskType?: string
): Promise<ServiceInfo[]> {
  if (state.services.length === 0) {
    throw new HunterError(400, "MISSING_SERVICES", "Call discover_services first");
  }

  const eligible = filterServicesByTaskType(state.services, requestedTaskType);
  const ranked = await rankServicesByPreference(eligible);
  if (!state.service) {
    return ranked;
  }

  const selectedServiceEligible =
    !requestedTaskType ||
    !state.service.taskType ||
    state.service.taskType === requestedTaskType;
  if (!selectedServiceEligible) {
    return ranked;
  }
  return [state.service, ...ranked.filter((item) => item.id !== state.service?.id)];
}

function resolveTaskType(state: HunterRuntimeState, requested?: string): string {
  const taskType =
    requested?.trim() ||
    state.service?.taskType ||
    state.requestTaskType ||
    inferTaskTypeFromGoal(state.goal) ||
    "content-generation";
  return taskType;
}

export function createReactTools(state: HunterRuntimeState): Record<string, ReactToolSpec> {
  return {
    discover_services: {
      description: "Read available services from local registry",
      schema: z.object({}),
      jsonSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      execute: async () => {
        state.services = await discoverServices();
        return state.services;
      }
    },
    evaluate_service: {
      description: "Select the most suitable service by id",
      schema: z.object({
        serviceId: z.string()
      }),
      jsonSchema: {
        type: "object",
        properties: {
          serviceId: { type: "string" }
        },
        required: ["serviceId"],
        additionalProperties: false
      },
      execute: async (args) => {
        const { serviceId } = z.object({ serviceId: z.string() }).parse(args);
        const service = state.services.find((item) => item.id === serviceId);
        if (!service) {
          throw new HunterError(404, "SERVICE_NOT_FOUND", `Service not found: ${serviceId}`);
        }
        state.service = service;
        if (service.taskType) {
          state.requestTaskType = service.taskType;
        }
        return {
          selected: service,
          reason: "Service selected by planner."
        };
      }
    },
    request_service: {
      description: "Request a service quote and receive x402 payment requirements",
      schema: z.object({
        taskInput: z.string(),
        taskType: z.string().optional()
      }),
      jsonSchema: {
        type: "object",
        properties: {
          taskInput: { type: "string" },
          taskType: { type: "string" }
        },
        required: ["taskInput"],
        additionalProperties: false
      },
      execute: async (args) => {
        const { taskInput, taskType } = z
          .object({
            taskInput: z.string(),
            taskType: z.string().optional()
          })
          .parse(args);
        const resolvedTaskType = resolveTaskType(state, taskType);
        const candidates = await buildQuoteCandidates(state, resolvedTaskType);
        const quoteResult = await requestServiceQuoteWithFallback({
          services: candidates,
          taskType: resolvedTaskType,
          taskInput,
          locale: state.locale
        });
        state.service = quoteResult.service;
        state.quote = quoteResult.quote;
        state.quoteAttempts = quoteResult.attempts;
        state.requestTaskType = quoteResult.quote.paymentContext.taskType;
        return {
          service: state.service,
          quote: state.quote,
          taskType: state.requestTaskType,
          attempts: state.quoteAttempts
        };
      }
    },
    check_balance: {
      description: `Check Hunter wallet balance on ${hunterConfig.chain.name}`,
      schema: z.object({}),
      jsonSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      execute: async () => checkBalanceTool()
    },
    make_payment: {
      description: `Send native ${hunterConfig.chain.nativeAsset.symbol} transfer according to quote`,
      schema: z.object({}),
      jsonSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      execute: async () => {
        if (!state.quote) {
          throw new HunterError(400, "MISSING_QUOTE", "Call request_service first");
        }
        const accept = pickNativeTransferAccept(state.quote);
        const payment = await makePaymentTool(accept);
        state.paymentTx = payment.txHash;
        return payment;
      }
    },
    submit_payment: {
      description: "Submit tx hash to writer and retrieve result + receipt",
      schema: z.object({
        taskInput: z.string()
      }),
      jsonSchema: {
        type: "object",
        properties: {
          taskInput: { type: "string" }
        },
        required: ["taskInput"],
        additionalProperties: false
      },
      execute: async (args) => {
        const { taskInput } = z.object({ taskInput: z.string() }).parse(args);
        if (!state.service || !state.quote || !state.paymentTx) {
          throw new HunterError(400, "MISSING_PAYMENT_CONTEXT", "Missing service/quote/paymentTx");
        }
        state.execution = await submitPaymentAndGetResult({
          service: state.service,
          paymentTx: state.paymentTx,
          taskType: state.quote.paymentContext.taskType,
          taskInput,
          timestamp: state.quote.paymentContext.timestamp,
          locale: state.locale
        });
        return state.execution;
      }
    },
    verify_receipt: {
      description: "Verify writer receipt signature",
      schema: z.object({}),
      jsonSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      execute: async () => {
        if (!state.execution) {
          throw new HunterError(400, "MISSING_EXECUTION", "submit_payment must be called first");
        }
        const check = verifyReceiptTool(state.execution.receipt, {
          result: state.execution.result,
          provider: state.service?.provider
        });
        state.receiptVerified = check.isValid;
        return check;
      }
    },
    evaluate_result: {
      description: "Evaluate output quality for the current result",
      schema: z.object({}),
      jsonSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      execute: async () => {
        if (!state.execution) {
          throw new HunterError(400, "MISSING_EXECUTION", "submit_payment must be called first");
        }
        state.evaluation = evaluateResultTool(state.execution.result);
        return state.evaluation;
      }
    },
    reflect: {
      description: "Summarize mission lesson and store memory entry",
      schema: z.object({
        score: z.number().min(0).max(100).optional(),
        lessonHint: z.string().optional()
      }),
      jsonSchema: {
        type: "object",
        properties: {
          score: { type: "number", minimum: 0, maximum: 100 },
          lessonHint: { type: "string" }
        },
        additionalProperties: false
      },
      execute: async (args) => {
        if (!state.service || !state.quote || !state.execution) {
          throw new HunterError(
            400,
            "MISSING_EXECUTION_CONTEXT",
            "request_service and submit_payment must be completed before reflect"
          );
        }
        const { score, lessonHint } = z
          .object({
            score: z.number().min(0).max(100).optional(),
            lessonHint: z.string().optional()
          })
          .parse(args);
        const evaluation = state.evaluation ?? evaluateResultTool(state.execution.result);
        state.evaluation = evaluation;
        state.reflection = await reflectAndStoreExperience({
          missionId: state.missionId,
          goal: state.goal,
          serviceUsed: state.service.id,
          taskType: state.quote.paymentContext.taskType,
          score: score ?? evaluation.score,
          result: state.execution.result,
          locale: state.locale,
          evaluationSummary: evaluation.summary,
          lessonHint
        });
        return state.reflection;
      }
    },
    give_feedback: createGiveFeedbackTool(state)
  };
}
