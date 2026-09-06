import { DEFAULT_LANGUAGE_CODE, localizeByLocale, type LanguageCode } from "@rebel/shared";
import { HunterError } from "./errors.js";

function readDetail(details: unknown, key: string): string | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function localizeHunterError(error: HunterError, locale: LanguageCode = DEFAULT_LANGUAGE_CODE): HunterError {
  const message = (() => {
    switch (error.code) {
      case "INTERNAL_ERROR":
        return localizeByLocale(locale, {
          en: "Unexpected hunter failure",
          zh: "Hunter 出现未预期错误"
        });
      case "LLM_KEY_MISSING":
        return localizeByLocale(locale, {
          en: "Missing required LLM API key for the current mode",
          zh: "当前模式缺少必需的 LLM API Key"
        });
      case "NO_SERVICE_AVAILABLE":
        return localizeByLocale(locale, {
          en: "No available service was found in the registry",
          zh: "在注册表中未找到可用服务"
        });
      case "UNSUPPORTED_PAYMENT_SCHEME":
        return localizeByLocale(locale, {
          en: "No supported native-transfer payment quote was found",
          zh: "未找到受支持的 native-transfer 支付报价"
        });
      case "RECEIPT_INVALID":
        return localizeByLocale(locale, {
          en: "Receipt signature verification failed",
          zh: "回执签名验证失败"
        });
      case "SECURITY_SOURCE_REQUIRED":
        return localizeByLocale(locale, {
          en: "A smart-contract audit requires Solidity source, source JSON, or a BSC contract address",
          zh: "智能合约审计需要 Solidity 源码、源码 JSON 或 BSC 合约地址"
        });
      case "SECURITY_SOURCE_API_KEY_MISSING":
        return localizeByLocale(locale, {
          en: "An Etherscan API key is required to resolve verified source from an address",
          zh: "通过地址解析验证源码需要 Etherscan API Key"
        });
      case "SECURITY_SOURCE_UNVERIFIED":
        return localizeByLocale(locale, {
          en: "The contract has no usable verified Solidity source on the configured explorer",
          zh: "该合约在配置的浏览器上没有可用的验证源码"
        });
      case "VERIFIER_UNAVAILABLE":
        return localizeByLocale(locale, {
          en: "No independent finding verifier is available",
          zh: "没有可用的独立发现项验证服务"
        });
      case "AUDIT_REPORT_INVALID":
        return localizeByLocale(locale, {
          en: "The Auditor returned an invalid structured security report",
          zh: "审计方返回的结构化安全报告无效"
        });
      case "VERIFICATION_REPORT_INVALID":
      case "VERIFICATION_SOURCE_MISMATCH":
        return localizeByLocale(locale, {
          en: "The independent verification report is invalid or bound to different source",
          zh: "独立验证报告无效，或绑定的源码不一致"
        });
      case "VERIFIER_RECEIPT_INVALID":
        return localizeByLocale(locale, {
          en: "Verifier receipt signature verification failed",
          zh: "验证方回执签名验证失败"
        });
      case "REACT_INCOMPLETE":
        return localizeByLocale(locale, {
          en: "The ReAct flow ended before payment and execution completed",
          zh: "ReAct 流程在支付和执行完成前结束"
        });
      case "QUOTE_REQUEST_FAILED":
        return localizeByLocale(locale, {
          en: "No service returned a valid quote",
          zh: "没有服务返回有效报价"
        });
      case "PAYMENT_SUBMIT_FAILED":
        return localizeByLocale(locale, {
          en: "Submitting payment proof to the service failed",
          zh: "向服务提交支付证明失败"
        });
      case "COMMANDER_ALL_PHASES_FAILED":
        return localizeByLocale(locale, {
          en: "All commander phases failed",
          zh: "指挥模式的所有阶段都失败了"
        });
      case "COMMANDER_INTERRUPTED":
        return error.message;
      case "COMMANDER_PHASE_TIMEOUT":
        return error.message;
      case "COMMANDER_PHASE_BUDGET_EXCEEDED":
        return localizeByLocale(locale, {
          en: "Auditor and Verifier quotes exceed the remaining phase budget",
          zh: "审计方与验证方报价合计超过当前阶段剩余预算"
        });
      case "COMMANDER_BUDGET_ASSET_MISMATCH":
        return localizeByLocale(locale, {
          en: "Service quote asset does not match the active Commander budget",
          zh: "服务报价资产与当前 Commander 预算资产不一致"
        });
      case "REGISTRY_READ_FAILED":
        return localizeByLocale(locale, {
          en: "Failed to read the service registry",
          zh: "读取服务注册表失败"
        });
      case "REGISTRY_INVALID_JSON":
        return localizeByLocale(locale, {
          en: "The service registry JSON is invalid",
          zh: "服务注册表 JSON 无效"
        });
      case "REGISTRY_INVALID_FORMAT":
        return localizeByLocale(locale, {
          en: "The service registry format is invalid",
          zh: "服务注册表格式无效"
        });
      case "INSUFFICIENT_BALANCE":
        return localizeByLocale(locale, {
          en: "Hunter wallet has insufficient native-token balance",
          zh: "Hunter 钱包的原生代币余额不足"
        });
      case "MISSING_SERVICES":
        return localizeByLocale(locale, {
          en: "Services have not been discovered yet",
          zh: "尚未发现服务"
        });
      case "SERVICE_NOT_FOUND": {
        const serviceId = readDetail(error.details, "serviceId");
        return localizeByLocale(locale, {
          en: serviceId ? `Service not found: ${serviceId}` : "Requested service was not found",
          zh: serviceId ? `未找到服务：${serviceId}` : "未找到请求的服务"
        });
      }
      case "MISSING_QUOTE":
        return localizeByLocale(locale, {
          en: "A quote is required before making payment",
          zh: "付款前必须先获取报价"
        });
      case "MISSING_PAYMENT_CONTEXT":
        return localizeByLocale(locale, {
          en: "Missing service, quote, or payment transaction context",
          zh: "缺少服务、报价或支付交易上下文"
        });
      case "MISSING_EXECUTION":
        return localizeByLocale(locale, {
          en: "Execution result is not available yet",
          zh: "执行结果尚不可用"
        });
      case "UNKNOWN_TOOL":
        return localizeByLocale(locale, {
          en: "The requested tool is not supported",
          zh: "请求的工具不受支持"
        });
      case "TOOL_ARGS_INVALID":
        return localizeByLocale(locale, {
          en: "Tool arguments are not valid JSON",
          zh: "工具参数不是有效的 JSON"
        });
      default:
        return error.message;
    }
  })();

  return new HunterError(error.status, error.code, message, error.details);
}
