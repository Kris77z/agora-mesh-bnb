import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getChainPreset, resolveChainConfig } from "./chain.js";

describe("chain presets", () => {
  it("defaults to BNB Smart Chain Testnet", () => {
    const chain = getChainPreset();
    assert.equal(chain.preset, "bnb-testnet");
    assert.equal(chain.chainId, 97);
    assert.equal(chain.nativeAsset.symbol, "tBNB");
    assert.equal(chain.nativeAsset.decimals, 18);
  });

  it("keeps Monad available as a legacy preset", () => {
    const chain = getChainPreset("monad-testnet");
    assert.equal(chain.chainId, 10143);
    assert.equal(chain.nativeAsset.symbol, "MON");
  });

  it("applies explicit RPC and chain overrides", () => {
    const chain = resolveChainConfig({
      preset: "bnb-testnet",
      chainId: "97",
      rpcUrl: "https://rpc.example.com"
    });
    assert.equal(chain.rpcUrl, "https://rpc.example.com");
    assert.equal(chain.nativeAsset.chainId, 97);
  });

  it("rejects unsupported presets and malformed overrides", () => {
    assert.throws(() => getChainPreset("unknown"), /Unsupported CHAIN_PRESET/);
    assert.throws(
      () => resolveChainConfig({ preset: "bnb-testnet", chainId: "nope" }),
      /Invalid CHAIN_ID/
    );
    assert.throws(
      () => resolveChainConfig({ preset: "bnb-testnet", rpcUrl: "file:///tmp/rpc" }),
      /Invalid RPC_URL/
    );
  });
});
