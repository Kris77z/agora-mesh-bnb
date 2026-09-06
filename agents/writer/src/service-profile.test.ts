import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
const run = promisify(execFile);

test("Sentinel is a separate audit profile with x402 identity and no mock paid fallback", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agora-profile-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const script = `
    import { writerConfig } from './src/config.ts';
    import { getWriterServicesInfo } from './src/identity.ts';
    import { resolveSkillForTaskType } from './src/skill-loader.ts';
    import { assertSkillRuntimeAvailable } from './src/executor.ts';
    let unavailable = false;
    try { assertSkillRuntimeAvailable(resolveSkillForTaskType('smart-contract-audit')); }
    catch { unavailable = true; }
    console.log(JSON.stringify({ services: getWriterServicesInfo(), unavailable, model: writerConfig.llm.model, receiptStorePath: writerConfig.x402.receiptStorePath }));
  `;
  const env = {
    PATH: process.env.PATH, INIT_CWD: directory, CHAIN_PRESET: "bnb-testnet", SERVICE_PROFILE: "sentinel",
    X402_ENABLED: "true", SENTINEL_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    SENTINEL_X402_FACILITATOR_PRIVATE_KEY: `0x${"22".repeat(32)}`, SENTINEL_LLM_MODEL: "isolated-test-model",
    X402_RECEIPT_STORE_PATH: ""
  };
  const result = await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env });
  const output = JSON.parse(result.stdout);
  assert.equal(output.services.length, 1);
  assert.equal(output.services[0].id, "sentinel-audit-v1");
  assert.equal(output.services[0].endpoint, "http://localhost:3006");
  assert.equal(output.services[0].price, "400000000000000000");
  assert.deepEqual(output.services[0].paymentRails, ["x402"]);
  assert.equal(output.unavailable, true);
  assert.equal(output.model, "isolated-test-model");
  assert.equal(output.receiptStorePath, path.join(directory, "registry/x402-sentinel-receipts.json"));
  await assert.rejects(() => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...env, SENTINEL_PRIVATE_KEY: "" }
  }), /persistent Service Profile private key/);
  await assert.rejects(() => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...env, AUDITOR_PRIVATE_KEY: env.SENTINEL_PRIVATE_KEY }
  }), /distinct from Auditor/);
});
