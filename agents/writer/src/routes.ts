import type { Request, Response } from "express";
import {
  DEFAULT_LANGUAGE_CODE,
  buildCaip2Network,
  calculateRequestHash,
  type ErrorResponse,
  type ExecuteRequest,
  type ExecuteSuccessResponse,
  type LanguageCode,
  type PaymentRequiredResponse
} from "@rebel/shared";
import { writerConfig } from "./config.js";
import { assertSkillRuntimeAvailable, executeTask } from "./executor.js";
import { localizeWriterError } from "./error-messages.js";
import { asWriterError } from "./errors.js";
import { commitPaymentTx, rollbackPaymentTx, verifyNativeTransfer } from "./payment.js";
import { createReceipt } from "./receipt.js";
import { getSkillPriceWei, resolveSkillForTaskType } from "./skill-loader.js";

function parseExecuteRequest(raw: unknown): ExecuteRequest {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const body = raw as Record<string, unknown>;
  return {
    taskType: typeof body.taskType === "string" ? body.taskType : undefined,
    taskInput: typeof body.taskInput === "string" ? body.taskInput : undefined,
    timestamp:
      typeof body.timestamp === "number" && Number.isFinite(body.timestamp)
        ? body.timestamp
        : undefined,
    paymentTx: typeof body.paymentTx === "string" ? body.paymentTx : undefined,
    locale: body.locale === "zh-CN" ? "zh-CN" : undefined
  };
}

function resolveLocale(input: ExecuteRequest): LanguageCode {
  return input.locale ?? DEFAULT_LANGUAGE_CODE;
}

export async function executeHandler(req: Request, res: Response): Promise<void> {
  const requestBody = parseExecuteRequest(req.body);
  const requestLocale = resolveLocale(requestBody);
  try {
    const body = requestBody;
    const requestedTaskType = body.taskType?.trim() || undefined;
    const skill = resolveSkillForTaskType(requestedTaskType);
    assertSkillRuntimeAvailable(skill);
    const taskType = skill.canonicalTaskType;
    const taskInput = body.taskInput ?? "";
    const locale = requestLocale;
    const timestamp = Math.floor(body.timestamp ?? Date.now() / 1000);
    const amountWei = getSkillPriceWei(skill, writerConfig.priceWei);

    const requestHash = calculateRequestHash({
      taskType,
      taskInput,
      timestamp,
      providerAddress: writerConfig.writerAddress
    });

    if (!body.paymentTx) {
      const paymentRequired: PaymentRequiredResponse = {
        x402Version: 2,
        resource: {
          url: "/execute",
          description: `${skill.config.name} Service`
        },
        accepts: [
          {
            scheme: "native-transfer",
            network: buildCaip2Network(writerConfig.chainId),
            amount: amountWei,
            asset: "native",
            payTo: writerConfig.writerAddress,
            maxTimeoutSeconds: writerConfig.paymentTimeoutSeconds
          }
        ],
        paymentContext: {
          requestHash,
          taskType,
          timestamp
        }
      };

      res.status(402).json(paymentRequired);
      return;
    }

    await verifyNativeTransfer(body.paymentTx);

    try {
      const result = await executeTask({ taskType, taskInput, locale });
      const receipt = await createReceipt({ requestHash, result });
      commitPaymentTx(body.paymentTx);

      const response: ExecuteSuccessResponse = {
        result,
        receipt,
        payment: {
          status: "payment-completed",
          transaction: body.paymentTx,
          network: buildCaip2Network(writerConfig.chainId)
        }
      };

      res.status(200).json(response);
    } catch (error) {
      rollbackPaymentTx(body.paymentTx);
      throw error;
    }
  } catch (error) {
    const writerError = asWriterError(error);
    const localizedError = localizeWriterError(writerError, requestLocale ?? DEFAULT_LANGUAGE_CODE);
    const payload: ErrorResponse = {
      code: localizedError.code,
      message: localizedError.message,
      details: localizedError.details
    };
    res.status(localizedError.status).json(payload);
  }
}
