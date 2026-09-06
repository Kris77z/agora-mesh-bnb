import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CommanderBudget } from "@rebel/shared";
import { runCommanderHunter } from "./commander-flow.js";
import type { SingleHunterRunResult } from "./run-types.js";

const TBNB = {
  chainId: 97,
  kind: "native" as const,
  symbol: "tBNB",
  decimals: 18
};

function money(amount: string) {
  return { asset: TBNB, amount };
}

function mockSingleResult(input: {
  amountWei: string;
  content: string;
  taskType?: string;
  serviceId?: string;
  verificationAmountWei?: string;
}): SingleHunterRunResult {
  const taskType = input.taskType ?? "content-generation";
  const serviceId = input.serviceId ?? "writer-v1";
  const result: SingleHunterRunResult = {
    missionId: "mission-test",
    goal: "mock-goal",
    mode: "scripted",
    service: {
      id: serviceId,
      name: serviceId,
      description: "mock",
      endpoint: "http://localhost/mock",
      taskType,
      skills: [taskType],
      price: input.amountWei,
      currency: "tBNB",
      asset: TBNB,
      network: "eip155:97",
      provider: "mock"
    },
    quote: {
      x402Version: 2,
      resource: {
        url: "http://localhost/mock",
        description: "mock"
      },
      accepts: [
        {
          scheme: "native-transfer",
          network: "eip155:97",
          amount: input.amountWei,
          asset: "native",
          payTo: "0x0000000000000000000000000000000000000001",
          maxTimeoutSeconds: 60
        }
      ],
      paymentContext: {
        requestHash: "0xrequest",
        taskType,
        timestamp: Date.now()
      }
    },
    paymentTx: "0xtx",
    execution: {
      result: input.content,
      receipt: {
        requestHash: "0xrequest",
        resultHash: "0xresult",
        provider: "mock",
        timestamp: Date.now(),
        signature: "0xsig"
      },
      payment: {
        status: "payment-completed",
        transaction: "0xtx",
        network: "eip155:97"
      }
    },
    receiptVerified: true,
    evaluation: {
      score: 8,
      summary: "ok"
    },
    finalMessage: "mock complete"
  };
  if (input.verificationAmountWei) {
    const verifier = serviceForVerification(input.verificationAmountWei);
    result.verification = verifier;
  }
  return result;
}

function serviceForVerification(amount: string): NonNullable<SingleHunterRunResult["verification"]> {
  const service = {
    id: "verifier-v1",
    name: "Verifier",
    description: "mock",
    endpoint: "http://localhost/verifier",
    taskType: "finding-verification",
    skills: ["finding-verification"],
    price: amount,
    currency: "tBNB",
    asset: TBNB,
    network: "eip155:97",
    provider: "0x0000000000000000000000000000000000000002"
  };
  const quote = {
    x402Version: 2 as const,
    resource: { url: "http://localhost/verifier", description: "mock" },
    accepts: [
      {
        scheme: "native-transfer" as const,
        network: "eip155:97",
        amount,
        asset: "native" as const,
        payTo: "0x0000000000000000000000000000000000000002",
        maxTimeoutSeconds: 60
      }
    ],
    paymentContext: {
      requestHash: "0xverifier-request",
      taskType: "finding-verification",
      timestamp: Date.now()
    }
  };
  const execution = {
    result: "{}",
    receipt: {
      requestHash: "0xverifier-request",
      resultHash: "0xresult",
      provider: service.provider,
      timestamp: Date.now(),
      signature: "0xsig"
    },
    payment: {
      status: "payment-completed" as const,
      transaction: "0xverifier-tx",
      network: "eip155:97"
    }
  };
  return {
    service,
    quote,
    paymentTx: "0xverifier-tx",
    execution,
    receiptVerified: true,
    report: {
      sourceName: "Vault.sol",
      sourceHash: `sha256:${"a".repeat(64)}`,
      engine: { method: "ast-rule", name: "rules", version: "1" },
      verifications: [],
      summary: { confirmed: 0, rejected: 0, partial: 0, inconclusive: 0, missed: 0 }
    }
  };
}

function mockBudget(overrides: Partial<CommanderBudget> = {}): CommanderBudget {
  return {
    maxTotal: money("100"),
    maxPerPhase: money("100"),
    maxPhases: 6,
    spent: money("0"),
    phaseCount: 0,
    ...overrides
  };
}

describe("runCommanderHunter regression", () => {
  it("charges Auditor and Verifier purchases to the same phase budget", async () => {
    const result = await runCommanderHunter(
      "audit contract",
      {},
      {
        llm: { provider: "openai", apiKey: "test-key", model: "test-model" },
        createMissionId: () => "mission-security-spend",
        buildBudget: () => mockBudget(),
        executePhase: async () =>
          mockSingleResult({
            amountWei: "12",
            verificationAmountWei: "5",
            content: "audit",
            taskType: "smart-contract-audit"
          }),
        runScriptedHunter: async () => {
          throw new Error("runScriptedHunter should not be called");
        },
        runPlanner: async ({ hireAgentSpec }) => {
          await hireAgentSpec.execute({ goal: "audit" });
          return "done";
        }
      }
    );
    assert.equal(result.mode, "commander");
    if (result.mode !== "commander") {
      throw new Error("Expected commander result");
    }
    assert.equal(result.budget.spent.amount, "17");
  });

  it("stops further hiring when budget is exceeded", async () => {
    const events: Array<{ type: string; data?: unknown }> = [];
    const toolOutputs: unknown[] = [];
    const result = await runCommanderHunter(
      "test mission",
      {
        onEvent: (event) => {
          events.push({ type: event.type, data: event.data });
        }
      },
      {
        llm: {
          provider: "openai",
          apiKey: "test-key",
          model: "test-model"
        },
        createMissionId: () => "mission-budget",
        buildBudget: () => mockBudget({ maxTotal: money("10"), maxPerPhase: money("100") }),
        executePhase: async () => mockSingleResult({ amountWei: "12", content: "phase-1" }),
        runScriptedHunter: async () => {
          throw new Error("runScriptedHunter should not be called");
        },
        runPlanner: async ({ hireAgentSpec }) => {
          toolOutputs.push(await hireAgentSpec.execute({ goal: "phase one" }));
          toolOutputs.push(await hireAgentSpec.execute({ goal: "phase two" }));
          return "planner finished";
        }
      }
    );

    assert.equal(result.mode, "commander");
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0].success, true);
    assert.equal(result.budget.spent.amount, "12");
    assert.equal(result.budget.phaseCount, 1);

    const secondTool = toolOutputs[1] as { blocked?: boolean; reason?: string };
    assert.equal(secondTool.blocked, true);
    assert.match(secondTool.reason ?? "", /Total spend reached|Total budget exhausted/);

    const phaseStartedCount = events.filter((event) => event.type === "phase_started").length;
    assert.equal(phaseStartedCount, 1);
  });

  it("keeps running after a failed phase and returns successful latest result", async () => {
    const calls: string[] = [];
    const result = await runCommanderHunter(
      "test mission",
      {},
      {
        llm: {
          provider: "openai",
          apiKey: "test-key",
          model: "test-model"
        },
        createMissionId: () => "mission-fail-continue",
        buildBudget: () => mockBudget(),
        executePhase: async (goal) => {
          calls.push(goal);
          if (calls.length === 1) {
            throw new Error("phase-1-failed");
          }
          return mockSingleResult({ amountWei: "5", content: "phase-2-success", serviceId: "auditor-v1" });
        },
        runScriptedHunter: async () => {
          throw new Error("runScriptedHunter should not be called");
        },
        runPlanner: async ({ hireAgentSpec }) => {
          await hireAgentSpec.execute({ goal: "first attempt" });
          await hireAgentSpec.execute({ goal: "second attempt" });
          return "planner finished";
        }
      }
    );

    assert.equal(result.mode, "commander");
    assert.equal(result.phases.length, 2);
    assert.equal(result.phases[0].success, false);
    assert.match(result.phases[0].error ?? "", /phase-1-failed/);
    assert.equal(result.phases[1].success, true);
    assert.equal(result.execution.result, "phase-2-success");
    assert.equal(result.service.id, "auditor-v1");
  });

  it("falls back to a single phase when planner does not hire any agent", async () => {
    const phaseGoals: string[] = [];
    const events: string[] = [];
    const result = await runCommanderHunter(
      "fallback mission",
      {
        onEvent: (event) => {
          events.push(event.type);
        }
      },
      {
        llm: {
          provider: "openai",
          apiKey: "test-key",
          model: "test-model"
        },
        createMissionId: () => "mission-fallback",
        buildBudget: () => mockBudget(),
        executePhase: async (goal) => {
          phaseGoals.push(goal);
          return mockSingleResult({ amountWei: "7", content: "fallback-result", serviceId: "writer-v1" });
        },
        runScriptedHunter: async () => {
          throw new Error("runScriptedHunter should not be called");
        },
        runPlanner: async () => "planner decided no tool"
      }
    );

    assert.equal(result.mode, "commander");
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0].phase.name, "Fallback Phase");
    assert.equal(result.execution.result, "fallback-result");
    assert.equal(phaseGoals[0], "fallback mission");
    assert.ok(events.includes("phase_started"));
    assert.ok(events.includes("phase_completed"));
  });

  it("localizes fallback phase and final message for zh-CN", async () => {
    const result = await runCommanderHunter(
      "fallback mission",
      {
        locale: "zh-CN"
      },
      {
        llm: {
          provider: "openai",
          apiKey: "test-key",
          model: "test-model"
        },
        createMissionId: () => "mission-fallback-zh",
        buildBudget: () => mockBudget(),
        executePhase: async (goal) => {
          assert.equal(goal, "fallback mission");
          return mockSingleResult({ amountWei: "7", content: "fallback-result", serviceId: "writer-v1" });
        },
        runScriptedHunter: async () => {
          throw new Error("runScriptedHunter should not be called");
        },
        runPlanner: async () => ""
      }
    );

    assert.equal(result.mode, "commander");
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0].phase.name, "回退阶段");
    assert.match(result.finalMessage, /指挥模式已完成/);
  });

  it("marks timed-out phases as failed and allows retry to continue", async () => {
    let callCount = 0;
    const result = await runCommanderHunter(
      "timeout mission",
      {},
      {
        llm: {
          provider: "openai",
          apiKey: "test-key",
          model: "test-model"
        },
        createMissionId: () => "mission-timeout-retry",
        buildBudget: () => mockBudget(),
        phaseTimeoutMs: 20,
        executePhase: async () => {
          callCount += 1;
          if (callCount === 1) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return mockSingleResult({ amountWei: "4", content: "late-phase-result" });
          }
          return mockSingleResult({ amountWei: "6", content: "retry-success", serviceId: "auditor-v1" });
        },
        runScriptedHunter: async () => {
          throw new Error("runScriptedHunter should not be called");
        },
        runPlanner: async ({ hireAgentSpec }) => {
          await hireAgentSpec.execute({ goal: "scan token risk" });
          await hireAgentSpec.execute({ goal: "scan token risk" });
          return "planner finished";
        }
      }
    );

    assert.equal(result.mode, "commander");
    assert.equal(result.phases.length, 2);
    assert.equal(result.phases[0].success, false);
    assert.match(result.phases[0].error ?? "", /timed out/i);
    assert.equal(result.phases[1].success, true);
    assert.equal(result.execution.result, "retry-success");
    assert.equal(result.service.id, "auditor-v1");
  });

  it("stops further hiring when run signal is interrupted", async () => {
    const controller = new AbortController();
    const toolOutputs: unknown[] = [];
    const result = await runCommanderHunter(
      "interrupt mission",
      {
        signal: controller.signal
      },
      {
        llm: {
          provider: "openai",
          apiKey: "test-key",
          model: "test-model"
        },
        createMissionId: () => "mission-interrupt",
        buildBudget: () => mockBudget(),
        executePhase: async () => mockSingleResult({ amountWei: "5", content: "phase-1-success" }),
        runScriptedHunter: async () => {
          throw new Error("runScriptedHunter should not be called");
        },
        runPlanner: async ({ hireAgentSpec }) => {
          toolOutputs.push(await hireAgentSpec.execute({ goal: "first phase" }));
          controller.abort("manual_stop");
          toolOutputs.push(await hireAgentSpec.execute({ goal: "second phase" }));
          return "planner finished";
        }
      }
    );

    const secondTool = toolOutputs[1] as { blocked?: boolean; reason?: string };
    assert.equal(secondTool.blocked, true);
    assert.match(secondTool.reason ?? "", /interrupted/i);

    assert.equal(result.mode, "commander");
    assert.equal(result.phases.length, 1);
    assert.equal(result.phases[0].success, true);
    assert.match(result.finalMessage, /interrupted/i);
  });

  it("throws interruption error when aborted before any phase starts", async () => {
    const controller = new AbortController();
    controller.abort("manual_stop");

    await assert.rejects(
      runCommanderHunter(
        "abort mission",
        {
          signal: controller.signal
        },
        {
          llm: {
            provider: "openai",
            apiKey: "test-key",
            model: "test-model"
          },
          createMissionId: () => "mission-interrupt-early",
          buildBudget: () => mockBudget(),
          executePhase: async () => mockSingleResult({ amountWei: "5", content: "should-not-run" }),
          runScriptedHunter: async () => {
            throw new Error("runScriptedHunter should not be called");
          },
          runPlanner: async () => {
            throw new Error("runPlanner should not be called");
          }
        }
      ),
      /COMMANDER_INTERRUPTED|interrupted/i
    );
  });
});
