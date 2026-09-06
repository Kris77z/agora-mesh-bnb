import { randomUUID } from "node:crypto";
import type { HunterRunRequestMode, HunterTraceEvent, LanguageCode } from "@rebel/shared";
import { HunterError, asHunterError } from "./errors.js";
import type { HunterRunResult } from "./run-types.js";
import type { HunterRunRecord, HunterRunStore, RunAdmission } from "./run-store.js";
import type { HunterRunOptions } from "./trace-emitter.js";

type ExecuteRun = (
  goal: string,
  options: HunterRunOptions,
  requestMode: HunterRunRequestMode
) => Promise<HunterRunResult>;

export interface RunSubmission {
  admission: RunAdmission;
  activeHere: boolean;
}

export class HunterRunManager {
  readonly ownerId = randomUUID();
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private recoveryRunning = false;
  private readonly recoveryTimer?: NodeJS.Timeout;

  constructor(
    private readonly store: HunterRunStore,
    private readonly execute: ExecuteRun,
    private readonly onTerminal: (record: HunterRunRecord) => Promise<void>
  ) {
    if (store.claimAvailable) {
      void this.recoverAvailable();
      this.recoveryTimer = setInterval(() => void this.recoverAvailable(), 500);
      this.recoveryTimer.unref?.();
    }
  }

  get distributed(): boolean {
    return this.store.distributed === true;
  }

  private async recoverAvailable(): Promise<void> {
    if (!this.store.claimAvailable || this.recoveryRunning) return;
    this.recoveryRunning = true;
    try {
      const claimed = await this.store.claimAvailable(this.ownerId);
      for (const record of claimed) this.start(record);
    } catch (error) {
      console.error(`[hunter] run recovery poll failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.recoveryRunning = false;
    }
  }

  async submit(input: {
    idempotencyKey: string;
    goal: string;
    requestMode: HunterRunRequestMode;
    locale: LanguageCode;
  }): Promise<RunSubmission> {
    const admission = await this.store.admit({ ...input, ownerId: this.ownerId });
    if (admission.kind === "conflict") return { admission, activeHere: false };
    if (admission.kind === "created") this.start(admission.record);
    return { admission, activeHere: this.active.has(admission.record.missionId) };
  }

  private start(initial: HunterRunRecord): void {
    if (this.active.has(initial.missionId)) return;
    const controller = new AbortController();
    let writes: Promise<unknown> = Promise.resolve();
    let persistenceFailure: unknown;
    const leaseHeartbeat = this.store.renewLease
      ? setInterval(() => {
          writes = writes.then(async () => {
            if (persistenceFailure || !this.store.renewLease) return;
            try {
              if (!await this.store.renewLease(initial)) {
                throw new Error("Hunter run lease renewal was rejected");
              }
            } catch (error) {
              persistenceFailure = error;
              controller.abort("run_lease_lost");
            }
          });
        }, this.store.leaseHeartbeatMs ?? 10_000)
      : undefined;
    leaseHeartbeat?.unref?.();
    const append = (event: HunterTraceEvent): void => {
      writes = writes.then(async () => {
        if (persistenceFailure) return;
        try {
          await this.store.update(initial.missionId, (current) => {
            if (current.status !== "running") return current;
            if (current.events.length >= 2_000) {
              controller.abort("trace_limit_exceeded");
              throw new Error("Hunter run exceeded the durable trace limit");
            }
            return { ...current, events: [...current.events, event] };
          });
        } catch (error) {
          persistenceFailure = error;
          controller.abort("run_store_unavailable");
        }
      });
    };

    const lifecycle = (async () => {
      let terminal: HunterRunRecord;
      try {
        const result = await this.execute(initial.goal, {
          missionId: initial.missionId,
          locale: initial.locale,
          signal: controller.signal,
          onEvent: append
        }, initial.requestMode);
        await writes;
        if (persistenceFailure) throw new HunterError(503, "RUN_STORE_UNAVAILABLE", "Run state could not be persisted safely");
        terminal = await this.store.update(initial.missionId, (current) => ({
          ...current,
          status: "completed",
          result
        }));
      } catch (error) {
        await writes;
        const rawFailure = asHunterError(error);
        const failure = error instanceof HunterError
          ? rawFailure
          : new HunterError(500, "INTERNAL_ERROR", "Hunter execution failed; inspect server logs");
        if (!(error instanceof HunterError)) {
          console.error(`[hunter] run ${initial.missionId} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        terminal = await this.store.update(initial.missionId, (current) => ({
          ...current,
          status: current.cancelRequested ? "cancelled" : "failed",
          error: {
            code: current.cancelRequested ? "RUN_CANCELLED" : failure.code,
            message: current.cancelRequested ? "Run was cancelled" : failure.message
          }
        }));
      }
      await this.onTerminal(terminal);
    })();
    const done = lifecycle.catch(() => undefined).finally(() => {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      this.active.delete(initial.missionId);
    });
    this.active.set(initial.missionId, { controller, done });
  }

  async get(missionId: string): Promise<{ record?: HunterRunRecord; activeHere: boolean }> {
    return { record: await this.store.get(missionId), activeHere: this.active.has(missionId) };
  }

  async wait(missionId: string): Promise<HunterRunRecord | undefined> {
    await this.active.get(missionId)?.done;
    return this.store.get(missionId);
  }

  async cancel(missionId: string): Promise<{ record?: HunterRunRecord; accepted: boolean }> {
    const active = this.active.get(missionId);
    const current = await this.store.get(missionId);
    if (!current) return { accepted: false };
    if (current.status !== "running") return { record: current, accepted: false };
    if (this.store.requestCancellation) {
      const record = await this.store.requestCancellation(missionId);
      active?.controller.abort("user_cancelled");
      return { record, accepted: Boolean(record) };
    }
    if (!active || current.ownerId !== this.ownerId) return { record: current, accepted: false };
    const record = await this.store.update(missionId, (value) => ({ ...value, cancelRequested: true }));
    active.controller.abort("user_cancelled");
    return { record, accepted: true };
  }

  shutdown(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    for (const active of this.active.values()) active.controller.abort("shutdown");
  }
}
