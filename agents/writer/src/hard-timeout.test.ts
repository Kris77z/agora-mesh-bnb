import assert from "node:assert/strict";
import test from "node:test";
import { withHardTimeout } from "./hard-timeout.js";

test("hard timeout rejects and aborts an operation that ignores cancellation", async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(
    withHardTimeout(10, async (received) => {
      signal = received;
      return new Promise<string>(() => undefined);
    }, "model request"),
    /model request timed out after 10 ms/
  );
  assert.equal(signal?.aborted, true);
});

test("hard timeout returns a prompt result and clears cancellation", async () => {
  const value = await withHardTimeout(1_000, async () => "done", "model request");
  assert.equal(value, "done");
});
