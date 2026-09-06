import type { AgentIdentity } from "@rebel/shared";

export const ERC8004_REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

export interface Erc8004RegistrationFile {
  type: typeof ERC8004_REGISTRATION_TYPE;
  name: string;
  description: string;
  image: string;
  services: Array<{ name: "A2A" | "MCP"; endpoint: string; version: string }>;
  x402Support: boolean;
  active: boolean;
  registrations: Array<{ agentId: number; agentRegistry: string }>;
  supportedTrust: string[];
}

export function buildErc8004RegistrationFile(input: {
  identity: AgentIdentity;
  chainId: number;
  registryAddress?: string;
  onchainAgentId?: string;
  x402Support: boolean;
}): Erc8004RegistrationFile {
  const registrations: Erc8004RegistrationFile["registrations"] = [];
  if (input.registryAddress && input.onchainAgentId && /^\d+$/.test(input.onchainAgentId)) {
    const agentId = Number(input.onchainAgentId);
    if (!Number.isSafeInteger(agentId) || agentId < 0) throw new Error("ERC-8004 agent id is not a safe integer");
    registrations.push({
      agentId,
      agentRegistry: `eip155:${input.chainId}:${input.registryAddress}`
    });
  }
  const services = input.identity.capabilities.flatMap((capability) => {
    if (!capability.endpoint || capability.type === "oasf") return [];
    return [{
      name: capability.type === "a2a" ? "A2A" as const : "MCP" as const,
      endpoint: capability.endpoint,
      version: capability.type === "a2a" ? "0.3.0" : "2025-06-18"
    }];
  });
  return {
    type: ERC8004_REGISTRATION_TYPE,
    name: input.identity.name,
    description: input.identity.description,
    image: input.identity.image ?? "",
    services,
    x402Support: input.x402Support,
    active: input.identity.active,
    registrations,
    supportedTrust: [...input.identity.trustModels]
  };
}
