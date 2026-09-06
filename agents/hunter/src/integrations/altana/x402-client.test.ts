import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { FileX402PurchaseStore } from "./purchase-store.js";
import type {
  AuthorityRecord,
  ServiceInfo,
  X402ExecuteSuccessResponse,
  X402ExecutionRequest,
  X402PaymentRequirement
} from "@rebel/shared";
import {
  deliverSignedX402WithRetry,
  purchaseServiceWithX402,
  validateX402AuthorityPolicy,
  validateX402AuthorityRemaining
} from "./x402-client.js";

const PROVIDER = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const PAYER = "0x3333333333333333333333333333333333333333";
const TX_HASH = `0x${"ab".repeat(32)}` as const;

test("restarts replay the original purchase without a second signature or debit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agora-purchase-"));
  try {
    const input = { missionId: "restart", service: service(), taskType: "content-generation", taskInput: "Write" };
    let paid = 0;
    let original: X402ExecutionRequest | undefined;
    const deps = {
      now: () => 1_900_000_000,
      purchaseStore: new FileX402PurchaseStore(directory),
      quoteFetch: async (url: string) => Response.json(requirement(url), { status: 402 }),
      paidFetch: async (_url: string, init: RequestInit): Promise<Response> => {
        paid++;
        original = JSON.parse(String(init.body));
        throw new Error("lost response");
      }
    };
    await assert.rejects(() => purchaseServiceWithX402(input, deps), /lost response/);
    const restarted = { ...deps, purchaseStore: new FileX402PurchaseStore(directory), now: () => 1_900_000_999,
      quoteFetch: async (_url: string, init: RequestInit) => {
        assert.deepEqual(JSON.parse(String(init.body)), original);
        assert.equal(new Headers(init.headers).has("X-PAYMENT"), false);
        return Response.json(success(original!));
      }
    };
    const recovered = await purchaseServiceWithX402(input, restarted);
    assert.equal(recovered.request.requestHash, original?.requestHash);
    assert.equal(paid, 1);
    await assert.rejects(() => purchaseServiceWithX402({ ...input, taskInput: "Different task" }, restarted), /different purchase/);
    await assert.rejects(() => purchaseServiceWithX402(input, deps), /Reconcile its requestHash/);
    assert.equal(paid, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("retries gateway failures with the same signature but stops on explicit settlement uncertainty", async () => {
  const init = { method: "POST", headers: { "X-PAYMENT": "one-signature" }, body: "same-body" };
  let calls = 0;
  const response = await deliverSignedX402WithRetry({ url: "http://test", init, attempts: 3, fetchImpl: async (_url, attemptInit) => {
    assert.equal(attemptInit, init);
    calls++;
    return calls === 1 ? new Response("gateway", { status: 502 }) : Response.json({ code: "SETTLEMENT_UNCERTAIN" }, { status: 503 });
  } });
  assert.equal(response.status, 503);
  assert.equal(calls, 2);
});

function service(): ServiceInfo {
  return {
    id: "writer-v1",
    name: "Writer",
    description: "Writes",
    endpoint: "http://localhost:3001",
    taskType: "content-generation",
    price: "100",
    currency: "$U",
    asset: {
      chainId: 97,
      kind: "erc20",
      address: TOKEN,
      symbol: "$U",
      decimals: 6
    },
    paymentRails: ["x402"],
    offerVersion: "1",
    network: "eip155:97",
    provider: PROVIDER
  };
}

function requirement(
  resourceUrl: string,
  payTo: `0x${string}` = PROVIDER
): X402PaymentRequirement {
  return {
    x402Version: 2,
    error: "Payment Required",
    resource: { url: resourceUrl, description: "Writer" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:97",
        asset: TOKEN,
        payTo,
        amount: "100",
        maxTimeoutSeconds: 60,
        extra: {
          name: "$U",
          version: "2",
          assetTransferMethod: "permit2-exact",
          spenderAddress: "0x4444444444444444444444444444444444444444"
        }
      }
    ]
  };
}

function success(request: X402ExecutionRequest, amount = "100"): X402ExecuteSuccessResponse {
  return {
    result: "Completed result",
    receipt: {
      requestHash: request.requestHash,
      resultHash: `0x${"cd".repeat(32)}`,
      provider: PROVIDER,
      timestamp: request.timestamp,
      signature: `0x${"ef".repeat(65)}`
    },
    payment: {
      status: "payment-completed",
      rail: "x402",
      transaction: TX_HASH,
      network: "eip155:97",
      payer: PAYER,
      recipient: PROVIDER,
      amount: {
        asset: service().asset!,
        amount
      },
      transferMethod: "permit2-witness"
    },
    requestHash: request.requestHash,
    idempotencyKey: request.idempotencyKey,
    cached: false
  };
}

test("validates a 402 requirement before the Altana paid retry", async () => {
  let quoteUrl = "";
  let paidCalls = 0;
  let observedRequest: X402ExecutionRequest | undefined;
  const result = await purchaseServiceWithX402(
    {
      missionId: "mission-1",
      service: service(),
      taskType: "content-generation",
      taskInput: "Write a BNB article",
      onRequirement: ({ request }) => {
        observedRequest = request;
      }
    },
    {
      now: () => 1_900_000_000,
      quoteFetch: async (url, init) => {
        quoteUrl = url;
        const request = JSON.parse(String(init.body)) as X402ExecutionRequest;
        return Response.json(requirement(url), { status: 402 });
      },
      paidFetch: async (url, init) => {
        paidCalls += 1;
        const request = JSON.parse(String(init.body)) as X402ExecutionRequest;
        assert.equal(new Headers(init.headers).get("Idempotency-Key"), request.idempotencyKey);
        assert.equal(url, quoteUrl);
        return Response.json(success(request));
      }
    }
  );

  assert.equal(paidCalls, 1);
  assert.equal(result.execution.payment.transaction, TX_HASH);
  assert.equal(result.selectedAccept.amount, "100");
  assert.equal(observedRequest?.requestHash, result.request.requestHash);
  assert.match(quoteUrl, /\/execute\/x402\?requestHash=0x/);
});

test("does not pay a requirement with an unexpected recipient", async () => {
  let paidCalls = 0;
  await assert.rejects(
    purchaseServiceWithX402(
      {
        missionId: "mission-2",
        service: service(),
        taskType: "content-generation",
        taskInput: "Write"
      },
      {
        now: () => 1_900_000_000,
        quoteFetch: async (url) =>
          Response.json(requirement(url, "0x5555555555555555555555555555555555555555"), {
            status: 402
          }),
        paidFetch: async () => {
          paidCalls += 1;
          return new Response(null, { status: 500 });
        }
      }
    ),
    /No x402 quote satisfies the configured payment policy/
  );
  assert.equal(paidCalls, 0);
});

test("rejects a settlement response whose amount differs from the approved quote", async () => {
  await assert.rejects(
    purchaseServiceWithX402(
      {
        missionId: "mission-3",
        service: service(),
        taskType: "content-generation",
        taskInput: "Write"
      },
      {
        now: () => 1_900_000_000,
        quoteFetch: async (url) => Response.json(requirement(url), { status: 402 }),
        paidFetch: async (_url, init) => {
          const request = JSON.parse(String(init.body)) as X402ExecutionRequest;
          return Response.json(success(request, "101"));
        }
      }
    ),
    /settlement amount changed/
  );
});

test("enforces the persisted authority recipient and token limit before signing", () => {
  const authority: AuthorityRecord = {
    authorityId: "authority-1",
    walletAddress: PAYER,
    sessionPublicKey: `0x${"12".repeat(32)}`,
    chainId: 97,
    allowedCalls: [{ to: PROVIDER }],
    spendLimits: [{ asset: service().asset!, limit: "100", period: "day" }],
    expiry: 1_900_000_000,
    status: "active",
    createdAt: 1
  };
  const approved = requirement("http://localhost/resource").accepts[0]!;
  assert.doesNotThrow(() => validateX402AuthorityPolicy(authority, approved));
  assert.throws(
    () => validateX402AuthorityPolicy({ ...authority, allowedCalls: [] }, approved),
    /allowlist/
  );
  assert.throws(
    () =>
      validateX402AuthorityPolicy(
        { ...authority, spendLimits: [{ ...authority.spendLimits[0]!, limit: "99" }] },
        approved
      ),
    /token limit/
  );
});

test("rejects a payment when confirmed spend or in-flight reservations consume the limit", () => {
  const approved = requirement("http://localhost/resource").accepts[0]!;
  const spending = [{
    asset: service().asset!,
    period: "day" as const,
    limit: "100",
    spent: "80",
    remaining: "20",
    evidenceSource: "x402-receipt-store" as const,
    transactions: []
  }];
  assert.doesNotThrow(() => validateX402AuthorityRemaining({ ...approved, amount: "20" }, spending));
  assert.throws(
    () => validateX402AuthorityRemaining({ ...approved, amount: "21" }, spending),
    /remaining token limit/
  );
  assert.throws(
    () => validateX402AuthorityRemaining({ ...approved, amount: "20" }, spending, 1n),
    /remaining token limit/
  );
});

test("retries the exact same signed x402 delivery after a transport failure", async () => {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Idempotency-Key": `0x${"12".repeat(32)}`,
    "X-PAYMENT": "signed-once"
  });
  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify({ requestHash: `0x${"34".repeat(32)}` })
  };
  const observed: Array<{ url: string; init: RequestInit }> = [];
  const response = await deliverSignedX402WithRetry({
    url: "https://auditor.example/execute/x402",
    init,
    attempts: 2,
    fetchImpl: async (url, requestInit) => {
      observed.push({ url, init: requestInit });
      if (observed.length === 1) {
        throw new TypeError("headers timeout");
      }
      return Response.json({ ok: true });
    }
  });

  assert.equal(response.status, 200);
  assert.equal(observed.length, 2);
  assert.equal(observed[0]?.url, observed[1]?.url);
  assert.equal(observed[0]?.init, init);
  assert.equal(observed[1]?.init, init);
  assert.equal(observed[0]?.init.body, observed[1]?.init.body);
  assert.equal(
    new Headers(observed[1]?.init.headers).get("Idempotency-Key"),
    new Headers(observed[0]?.init.headers).get("Idempotency-Key")
  );
  assert.equal(new Headers(observed[1]?.init.headers).get("X-PAYMENT"), "signed-once");
});

test("stops signed x402 delivery after the configured transport attempts", async () => {
  const terminalError = new TypeError("socket closed");
  let calls = 0;
  await assert.rejects(
    deliverSignedX402WithRetry({
      url: "https://auditor.example/execute/x402",
      init: { method: "POST", body: "{}" },
      attempts: 2,
      fetchImpl: async () => {
        calls += 1;
        throw calls === 1 ? new TypeError("headers timeout") : terminalError;
      }
    }),
    (error: unknown) => error === terminalError
  );
  assert.equal(calls, 2);
});
