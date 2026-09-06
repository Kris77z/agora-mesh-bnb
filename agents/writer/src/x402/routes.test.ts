import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileX402ExecutionStore } from "./receipt-store.js";
import {
  buildX402ResourceUrl,
  calculateX402IdempotencyKey,
  calculateX402RequestHash,
  type X402ExecutionRequest
} from "@rebel/shared";
import type { HandleResult } from "@altananetwork/x402-server";
import {
  handleX402Core,
  type X402CoreRequest,
  type X402RouteDependencies
} from "./routes.js";
import type { StoredX402Execution, X402ExecutionStore } from "./receipt-store.js";

const NOW = 1_800_000_000;
const PROVIDER = "0x0000000000000000000000000000000000000001";
const PAYER = "0x0000000000000000000000000000000000000002" as const;
const TOKEN = "0x0000000000000000000000000000000000000003" as const;
const TX_HASH = `0x${"ab".repeat(32)}` as const;

class MemoryStore implements X402ExecutionStore {
  readonly records = new Map<string, StoredX402Execution>();

  async get(key: string) {
    return this.records.get(key);
  }

  async save(record: StoredX402Execution) {
    this.records.set(record.idempotencyKey, record);
  }

  async beginSettlement(record: StoredX402Execution) {
    const previous = this.records.get(record.idempotencyKey);
    if (previous?.settlement || previous?.payment || previous?.response) return false;
    this.records.set(record.idempotencyKey, record);
    return true;
  }
}

function fixture(options: { execute?: () => Promise<string> } = {}) {
  const store = new MemoryStore();
  let settlementCount = 0;
  let executionCount = 0;
  const runtime: X402RouteDependencies["runtime"] = {
    chainId: 97,
    publicEndpoint: "https://seller.example",
    providerAddress: PROVIDER,
    payTo: PROVIDER,
    priceAmount: "20",
    paymentTimeoutSeconds: 300,
    offerVersion: "1",
    asset: { chainId: 97, kind: "erc20", address: TOKEN, symbol: "U", decimals: 18 }
  };
  const deps: X402RouteDependencies = {
    runtime,
    merchantFactory: {
      get(input) {
        return {
          async requirePayment(header): Promise<HandleResult> {
            if (!header) {
              return {
                status: 402,
                body: {
                  x402Version: 2,
                  error: "payment required",
                  resource: { url: input.resourceUrl },
                  accepts: []
                }
              };
            }
            settlementCount += 1;
            return {
              status: 200,
              receipt: {
                txHash: TX_HASH,
                payer: PAYER,
                amount: 20n,
                token: TOKEN,
                rail: "permit2-witness"
              }
            };
          }
        };
      }
    },
    store,
    resolveService: () => ({
      serviceId: "auditor-v1",
      taskType: "smart-contract-audit",
      name: "Auditor"
    }),
    async execute() {
      executionCount += 1;
      if (options.execute) {
        return options.execute();
      }
      return "audit-result";
    },
    async createResultReceipt(input) {
      return {
        requestHash: input.requestHash,
        resultHash: `0x${"cd".repeat(32)}`,
        provider: PROVIDER,
        timestamp: NOW,
        signature: "0xsignature"
      };
    },
    now: () => NOW
  };
  return {
    deps,
    store,
    get settlementCount() {
      return settlementCount;
    },
    get executionCount() {
      return executionCount;
    }
  };
}

function request(runtime: X402RouteDependencies["runtime"]): {
  body: X402ExecutionRequest;
  core: X402CoreRequest;
} {
  const requestHash = calculateX402RequestHash({
    missionId: "mission-1",
    chainId: runtime.chainId,
    serviceId: "auditor-v1",
    offerVersion: runtime.offerVersion,
    taskType: "smart-contract-audit",
    taskInput: "contract source",
    timestamp: NOW,
    expiresAt: NOW + 60,
    paymentNonce: `0x${"12".repeat(32)}`,
    assetAddress: TOKEN,
    amount: runtime.priceAmount,
    providerAddress: runtime.providerAddress,
    resourcePath: "/execute/x402"
  });
  const idempotencyKey = calculateX402IdempotencyKey({
    missionId: "mission-1",
    serviceId: "auditor-v1",
    requestHash
  });
  const body: X402ExecutionRequest = {
    missionId: "mission-1",
    serviceId: "auditor-v1",
    offerVersion: runtime.offerVersion,
    taskType: "smart-contract-audit",
    taskInput: "contract source",
    timestamp: NOW,
    expiresAt: NOW + 60,
    paymentNonce: `0x${"12".repeat(32)}`,
    asset: TOKEN,
    amount: runtime.priceAmount,
    requestHash,
    idempotencyKey
  };
  return {
    body,
    core: {
      body,
      queryRequestHash: requestHash,
      idempotencyHeader: idempotencyKey
    }
  };
}

describe("Writer x402 route", () => {
  it("round-trips HTTP 402 -> paid delivery -> fresh-runtime unsigned replay with a durable store", async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), "agora-http-x402-"));
    const first = fixture();
    let deps = { ...first.deps, store: new FileX402ExecutionStore(path.join(directory, "receipts.json")) };
    const server = createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const url = new URL(req.url!, "http://localhost");
        const response = await handleX402Core({
          body: JSON.parse(Buffer.concat(chunks).toString()), queryRequestHash: url.searchParams.get("requestHash"),
          idempotencyHeader: req.headers["idempotency-key"] as string, paymentHeader: req.headers["x-payment"] as string
        }, deps);
        res.writeHead(response.status, { ...response.headers, "Content-Type": "application/json" });
        res.end(JSON.stringify(response.body));
      } catch {
        res.writeHead(500); res.end();
      }
    });
    context.after(async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    deps.runtime.publicEndpoint = `http://127.0.0.1:${address.port}`;
    const input = request(deps.runtime);
    const url = buildX402ResourceUrl(deps.runtime.publicEndpoint, input.body.requestHash);
    const init = { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": input.body.idempotencyKey }, body: JSON.stringify(input.body) };
    assert.equal((await fetch(url, init)).status, 402);
    const paid = await fetch(url, { ...init, headers: { ...init.headers, "X-PAYMENT": "test-facilitator-only" } });
    assert.equal(paid.status, 200);
    assert.equal(paid.headers.get("X-Payment-Transaction"), TX_HASH);
    await paid.json();
    const restarted = fixture();
    deps = { ...restarted.deps, store: new FileX402ExecutionStore(path.join(directory, "receipts.json")) };
    deps.runtime.offerVersion = "new-version";
    deps.runtime.priceAmount = "999";
    const replay = await fetch(url, init);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { cached: boolean }).cached, true);
    assert.equal(first.settlementCount, 1);
    assert.equal(restarted.settlementCount, 0);
    assert.equal(restarted.executionCount, 0);
  });

  it("returns a request-bound 402 challenge before payment", async () => {
    const context = fixture();
    const input = request(context.deps.runtime);
    const response = await handleX402Core(input.core, context.deps);
    assert.equal(response.status, 402);
    const body = response.body as { resource: { url: string } };
    assert.equal(
      body.resource.url,
      buildX402ResourceUrl(context.deps.runtime.publicEndpoint, input.body.requestHash)
    );
    assert.equal(context.settlementCount, 0);
    assert.equal(context.executionCount, 0);
  });

  it("settles once and serves cached output on an idempotent retry", async () => {
    const context = fixture();
    const input = request(context.deps.runtime);
    const paid = await handleX402Core(
      { ...input.core, paymentHeader: "signed-payment" },
      context.deps
    );
    assert.equal(paid.status, 200);
    assert.equal((paid.body as { cached: boolean }).cached, false);
    assert.equal(context.settlementCount, 1);
    assert.equal(context.executionCount, 1);
    assert.deepEqual(
      (await context.store.get(input.body.idempotencyKey))?.request,
      input.body
    );

    const retry = await handleX402Core(input.core, context.deps);
    assert.equal(retry.status, 200);
    assert.equal((retry.body as { cached: boolean }).cached, true);
    assert.equal(context.settlementCount, 1);
    assert.equal(context.executionCount, 1);
  });

  it("joins an in-flight paid execution without settling or executing twice", async () => {
    let markStarted!: () => void;
    let releaseExecution!: (result: string) => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const context = fixture({
      execute: async () => {
        markStarted();
        return new Promise<string>((resolve) => {
          releaseExecution = resolve;
        });
      }
    });
    const input = request(context.deps.runtime);
    const first = handleX402Core(
      { ...input.core, paymentHeader: "signed-payment" },
      context.deps
    );
    await started;

    const retry = handleX402Core(
      { ...input.core, paymentHeader: "same-signed-payment" },
      context.deps
    );
    releaseExecution("audit-result");
    const [firstResponse, retryResponse] = await Promise.all([first, retry]);

    assert.equal(firstResponse.status, 200);
    assert.equal(retryResponse.status, 200);
    assert.equal(context.settlementCount, 1);
    assert.equal(context.executionCount, 1);
    assert.equal(
      (retryResponse.body as { payment: { transaction: string } }).payment.transaction,
      TX_HASH
    );
  });

  it("retries delivery without charging again after settlement", async () => {
    const context = fixture();
    const input = request(context.deps.runtime);
    await context.store.save({
      idempotencyKey: input.body.idempotencyKey,
      requestHash: input.body.requestHash,
      serviceId: input.body.serviceId,
      request: input.body,
      payment: {
        status: "payment-completed",
        rail: "x402",
        transaction: TX_HASH,
        network: "eip155:97",
        payer: PAYER,
        recipient: PROVIDER as `0x${string}`,
        amount: { asset: context.deps.runtime.asset, amount: "20" },
        transferMethod: "permit2-witness"
      },
      updatedAt: NOW
    });
    const response = await handleX402Core(input.core, context.deps);
    assert.equal(response.status, 200);
    assert.equal(context.settlementCount, 0);
    assert.equal(context.executionCount, 1);
  });

  it("delivers old paid offers after a price/version change without needing an available model", async () => {
    const context = fixture();
    const input = request(context.deps.runtime);
    await handleX402Core({ ...input.core, paymentHeader: "signed-payment" }, context.deps);
    context.deps.runtime.priceAmount = "999";
    context.deps.runtime.offerVersion = "2";
    context.deps.now = () => NOW + 9999;
    context.deps.resolveService = () => { throw new Error("Model is unavailable"); };
    assert.equal((await handleX402Core(input.core, context.deps)).status, 200);
    assert.equal(context.settlementCount, 1);
  });

  it("journals intent before settlement and blocks recharging after an ambiguous response", async () => {
    const context = fixture();
    const input = request(context.deps.runtime);
    let sends = 0;
    context.deps.merchantFactory = { get: () => ({ requirePayment: async () => {
      sends++;
      assert.equal((await context.store.get(input.body.idempotencyKey))?.settlement?.state, "attempting");
      throw new Error("relay response lost after transfer");
    } }) };
    await assert.rejects(() => handleX402Core({ ...input.core, paymentHeader: "signed" }, context.deps), /outcome is unknown/);
    assert.equal((await context.store.get(input.body.idempotencyKey))?.settlement?.state, "uncertain");
    await assert.rejects(() => handleX402Core({ ...input.core, paymentHeader: "new-signature" }, { ...context.deps }), /may have settled/);
    assert.equal(sends, 1);
    assert.equal(context.executionCount, 0);
  });

  it("treats a signed 402 as uncertain, not permission to pay again", async () => {
    const context = fixture();
    const input = request(context.deps.runtime);
    context.deps.merchantFactory = { get: () => ({ requirePayment: async () => ({
      status: 402, body: { x402Version: 2, error: "settle timeout", accepts: [] }
    }) }) };
    await assert.rejects(() => handleX402Core({ ...input.core, paymentHeader: "signed" }, context.deps), /outcome is unknown/);
    assert.equal((await context.store.get(input.body.idempotencyKey))?.settlement?.state, "uncertain");
  });

  it("retains confirmed payment after model failure and retries only execution", async () => {
    let calls = 0;
    const context = fixture({ execute: async () => {
      if (++calls === 1) throw new Error("model key=should-not-be-stored");
      return "recovered audit";
    } });
    const input = request(context.deps.runtime);
    await assert.rejects(() => handleX402Core({ ...input.core, paymentHeader: "signed" }, context.deps), /model/);
    const stored = await context.store.get(input.body.idempotencyKey);
    assert.equal(stored?.payment?.transaction, TX_HASH);
    assert.equal(JSON.stringify(stored).includes("should-not-be-stored"), false);
    assert.equal((await handleX402Core(input.core, context.deps)).status, 200);
    assert.equal(context.settlementCount, 1);
  });

  it("rejects a facilitator receipt with the wrong token without executing", async () => {
    const context = fixture();
    const input = request(context.deps.runtime);
    context.deps.merchantFactory = { get: () => ({ requirePayment: async () => ({
      status: 200, receipt: { txHash: TX_HASH, payer: PAYER, token: PAYER, amount: 20n, rail: "permit2-witness" }
    }) }) };
    await assert.rejects(() => handleX402Core({ ...input.core, paymentHeader: "signed" }, context.deps), /outcome is unknown/);
    assert.equal(context.executionCount, 0);
  });

  it("rejects hash, idempotency, and stale-quote mismatches", async () => {
    const context = fixture();
    const input = request(context.deps.runtime);
    await assert.rejects(
      () => handleX402Core({ ...input.core, queryRequestHash: `0x${"00".repeat(32)}` }, context.deps),
      /requestHash/i
    );
    await assert.rejects(
      () => handleX402Core({ ...input.core, idempotencyHeader: `0x${"00".repeat(32)}` }, context.deps),
      /Idempotency-Key/i
    );
    const stale = fixture();
    stale.deps.now = () => NOW + 301;
    await assert.rejects(() => handleX402Core(input.core, stale.deps), /payment window/i);
  });
});
