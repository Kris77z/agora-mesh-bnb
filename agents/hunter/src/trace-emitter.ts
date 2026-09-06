import type { HunterTraceEvent, HunterTraceEventType, LanguageCode } from "@rebel/shared";

export interface HunterRunOptions {
  /** Stable id assigned and durably admitted before any paid work begins. */
  missionId?: string;
  onEvent?: (event: HunterTraceEvent) => void;
  signal?: AbortSignal;
  locale?: LanguageCode;
}

export function emitTrace(
  options: HunterRunOptions | undefined,
  type: HunterTraceEventType,
  data?: unknown
): void {
  options?.onEvent?.({
    type,
    at: new Date().toISOString(),
    data
  });
}

export function toToolSummary(toolName: string, result: unknown): unknown {
  if (toolName === "discover_services" && Array.isArray(result)) {
    return {
      count: result.length
    };
  }
  if (
    (toolName === "request_service" || toolName === "submit_payment") &&
    result &&
    typeof result === "object"
  ) {
    const asRecord = result as Record<string, unknown>;
    return {
      keys: Object.keys(asRecord)
    };
  }
  return result;
}
