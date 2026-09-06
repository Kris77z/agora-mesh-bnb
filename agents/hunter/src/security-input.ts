import { createHash } from "node:crypto";
import path from "node:path";
import { ethers } from "ethers";
import type { HexAddress, SecurityTaskInput } from "@rebel/shared";
import { hunterConfig } from "./config.js";
import { HunterError } from "./errors.js";

const ADDRESS_PATTERN = /0x[a-fA-F0-9]{40}/;

interface EtherscanSourceEntry {
  SourceCode?: unknown;
  ContractName?: unknown;
  ContractFileName?: unknown;
}

interface EtherscanSourceResponse {
  status?: unknown;
  message?: unknown;
  result?: unknown;
}

export interface SecuritySourceResolverOptions {
  chainId?: number;
  apiKey?: string;
  timeoutMs?: number;
  maxSourceBytes?: number;
  fetchImpl?: typeof fetch;
}

function sha256Source(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function stripSolidityFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:solidity|sol)?\s*\n([\s\S]*?)\n```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function extractEmbeddedSolidity(value: string): string | undefined {
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:solidity|sol)\s*\n([\s\S]*?)\n```/i)?.[1]?.trim();
  if (fenced && looksLikeSolidity(fenced)) {
    return fenced;
  }

  const stripped = stripSolidityFence(trimmed);
  if (
    /^(?:\/\/|\/\*|pragma\s+solidity\b|(?:abstract\s+)?(?:contract|interface|library)\s+)/i.test(stripped)
  ) {
    return looksLikeSolidity(stripped) ? stripped : undefined;
  }

  const pragmaIndex = stripped.search(/\bpragma\s+solidity\b/i);
  const declarationIndex = stripped.search(
    /\b(?:abstract\s+)?(?:contract|interface|library)\s+[A-Za-z_][A-Za-z0-9_]*\b/
  );
  const start = pragmaIndex >= 0
    ? pragmaIndex
    : declarationIndex >= 0
      ? declarationIndex
      : -1;
  if (start < 0) return undefined;

  const candidate = stripped.slice(start);
  const finalBrace = candidate.lastIndexOf("}");
  const source = (finalBrace >= 0 ? candidate.slice(0, finalBrace + 1) : candidate).trim();
  return looksLikeSolidity(source) ? source : undefined;
}

function looksLikeSolidity(value: string): boolean {
  return (
    /\bpragma\s+solidity\b/.test(value) ||
    /\b(?:abstract\s+)?(?:contract|interface|library)\s+[A-Za-z_][A-Za-z0-9_]*\b/.test(value)
  );
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function combineStandardJsonSources(value: unknown): {
  source: string;
  sourceName: string;
  sources: Record<string, string>;
  remappings?: string[];
} | undefined {
  const object = readObject(value);
  const sources = readObject(object?.sources);
  if (!sources) {
    return undefined;
  }
  const entries = Object.entries(sources)
    .map(([name, sourceEntry]) => {
      const content = readObject(sourceEntry)?.content;
      return typeof content === "string" && content.trim() ? { name, content: content.trim() } : undefined;
    })
    .filter((entry): entry is { name: string; content: string } => Boolean(entry))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) {
    return undefined;
  }
  const settings = readObject(object?.settings);
  const remappings = Array.isArray(settings?.remappings)
    ? settings.remappings.filter((item): item is string =>
        typeof item === "string" && Boolean(item.trim())
      )
    : [];
  return {
    sourceName: entries[0]!.name,
    source: entries.map((entry) => `// File: ${entry.name}\n${entry.content}`).join("\n\n"),
    sources: Object.fromEntries(entries.map((entry) => [entry.name, entry.content])),
    ...(remappings.length > 0 ? { remappings } : {})
  };
}

function parseExplorerSource(rawSource: string, entry: EtherscanSourceEntry): {
  source: string;
  sourceName: string;
  sources?: Record<string, string>;
  remappings?: string[];
} {
  const trimmed = rawSource.trim();
  const jsonCandidate = trimmed.startsWith("{{") && trimmed.endsWith("}}")
    ? trimmed.slice(1, -1)
    : trimmed;
  try {
    const combined = combineStandardJsonSources(JSON.parse(jsonCandidate));
    if (combined) {
      const contractFileName =
        typeof entry.ContractFileName === "string" ? entry.ContractFileName.trim() : "";
      const contractName = typeof entry.ContractName === "string" ? entry.ContractName.trim() : "";
      const sourceUnits = Object.keys(combined.sources);
      const primarySource =
        (contractFileName && combined.sources[contractFileName] ? contractFileName : undefined) ??
        sourceUnits.find((sourceUnit) => path.basename(sourceUnit) === `${contractName}.sol`) ??
        combined.sourceName;
      return { ...combined, sourceName: primarySource };
    }
  } catch {
    // A single-file verified contract is returned as raw Solidity rather than JSON.
  }
  if (!looksLikeSolidity(trimmed)) {
    throw new HunterError(
      422,
      "SECURITY_SOURCE_INVALID",
      "Explorer returned verified metadata without usable Solidity source"
    );
  }
  const contractFileName = typeof entry.ContractFileName === "string" ? entry.ContractFileName.trim() : "";
  const contractName = typeof entry.ContractName === "string" ? entry.ContractName.trim() : "";
  return {
    source: trimmed,
    sourceName: contractFileName || `${contractName || "VerifiedContract"}.sol`
  };
}

function parseInlineInput(rawInput: string):
  | { source: string; sourceName: string }
  | { contractAddress: HexAddress }
  | undefined {
  const stripped = stripSolidityFence(rawInput);
  try {
    const parsed = JSON.parse(stripped) as unknown;
    const combined = combineStandardJsonSources(parsed);
    if (combined) {
      return combined;
    }
    const object = readObject(parsed);
    if (typeof object?.source === "string" && looksLikeSolidity(object.source)) {
      return {
        source: object.source.trim(),
        sourceName:
          typeof object.sourceName === "string" && object.sourceName.trim()
            ? object.sourceName.trim()
            : "Contract.sol"
      };
    }
    const addressValue = object?.contractAddress ?? object?.address;
    if (typeof addressValue === "string" && ADDRESS_PATTERN.test(addressValue)) {
      return { contractAddress: ethers.getAddress(addressValue) as HexAddress };
    }
  } catch {
    // Continue with raw Solidity/address detection.
  }
  const embeddedSource = extractEmbeddedSolidity(rawInput);
  if (embeddedSource) {
    return { source: embeddedSource, sourceName: "Contract.sol" };
  }
  const address = stripped.match(ADDRESS_PATTERN)?.[0];
  if (address) {
    return { contractAddress: ethers.getAddress(address) as HexAddress };
  }
  return undefined;
}

function explorerUrl(chainId: number, address: HexAddress): string | undefined {
  if (chainId === 97) {
    return `https://testnet.bscscan.com/address/${address}#code`;
  }
  if (chainId === 56) {
    return `https://bscscan.com/address/${address}#code`;
  }
  return undefined;
}

async function fetchVerifiedSource(
  address: HexAddress,
  options: Required<Pick<SecuritySourceResolverOptions, "chainId" | "apiKey" | "timeoutMs" | "maxSourceBytes" | "fetchImpl">>
): Promise<SecurityTaskInput> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const url = new URL("https://api.etherscan.io/v2/api");
  url.searchParams.set("chainid", String(options.chainId));
  url.searchParams.set("module", "contract");
  url.searchParams.set("action", "getsourcecode");
  url.searchParams.set("address", address);
  url.searchParams.set("apikey", options.apiKey);
  let response: Response;
  try {
    response = await options.fetchImpl(url, { signal: controller.signal });
  } catch (error) {
    throw new HunterError(
      502,
      "SECURITY_SOURCE_FETCH_FAILED",
      error instanceof Error ? error.message : "Verified source request failed"
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new HunterError(
      502,
      "SECURITY_SOURCE_FETCH_FAILED",
      `Verified source request returned HTTP ${response.status}`
    );
  }
  const payload = (await response.json()) as EtherscanSourceResponse;
  const entry = Array.isArray(payload.result) ? (payload.result[0] as EtherscanSourceEntry | undefined) : undefined;
  if (payload.status !== "1" || !entry || typeof entry.SourceCode !== "string" || !entry.SourceCode.trim()) {
    throw new HunterError(
      422,
      "SECURITY_SOURCE_UNVERIFIED",
      "The contract does not have usable verified Solidity source on the configured explorer",
      { address, chainId: options.chainId, explorerMessage: payload.message }
    );
  }
  const parsed = parseExplorerSource(entry.SourceCode, entry);
  if (Buffer.byteLength(parsed.source, "utf8") > options.maxSourceBytes) {
    throw new HunterError(413, "SECURITY_SOURCE_TOO_LARGE", "Verified Solidity source exceeds the configured limit");
  }
  return {
    chainId: options.chainId,
    mode: "verified-source",
    sourceName: parsed.sourceName,
    source: parsed.source,
    ...(parsed.sources ? { sources: parsed.sources } : {}),
    ...(parsed.remappings ? { remappings: parsed.remappings } : {}),
    sourceHash: sha256Source(parsed.source),
    contractAddress: address,
    explorerUrl: explorerUrl(options.chainId, address)
  };
}

export async function resolveSecurityTaskInput(
  rawInput: string,
  overrides: SecuritySourceResolverOptions = {}
): Promise<SecurityTaskInput> {
  const parsed = parseInlineInput(rawInput);
  if (!parsed) {
    throw new HunterError(
      422,
      "SECURITY_SOURCE_REQUIRED",
      "Smart-contract audit requires Solidity source, source JSON, or a BSC contract address"
    );
  }
  const chainId = overrides.chainId ?? hunterConfig.chainId;
  const maxSourceBytes = overrides.maxSourceBytes ?? hunterConfig.securitySource.maxSourceBytes;
  if ("source" in parsed) {
    if (Buffer.byteLength(parsed.source, "utf8") > maxSourceBytes) {
      throw new HunterError(413, "SECURITY_SOURCE_TOO_LARGE", "Solidity source exceeds the configured limit");
    }
    return {
      chainId,
      mode: "inline-source",
      sourceName: parsed.sourceName,
      source: parsed.source,
      sourceHash: sha256Source(parsed.source)
    };
  }
  const apiKey = overrides.apiKey ?? hunterConfig.securitySource.etherscanApiKey;
  if (!apiKey) {
    throw new HunterError(
      503,
      "SECURITY_SOURCE_API_KEY_MISSING",
      "ETHERSCAN_API_KEY (or BSCSCAN_API_KEY) is required to resolve a contract address"
    );
  }
  return fetchVerifiedSource(parsed.contractAddress, {
    chainId,
    apiKey,
    timeoutMs: overrides.timeoutMs ?? hunterConfig.securitySource.timeoutMs,
    maxSourceBytes,
    fetchImpl: overrides.fetchImpl ?? fetch
  });
}
