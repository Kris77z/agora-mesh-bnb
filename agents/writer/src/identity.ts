import { buildCaip2Network, type AgentIdentity, type AssetRef, type ServiceInfo } from "@rebel/shared";
import { U_TOKEN } from "@altananetwork/x402-server";
import { writerConfig } from "./config.js";
import {
  getSkillPriceWei,
  listLoadedSkills,
  resolveSkillForTaskType,
  type LoadedSkill
} from "./skill-loader.js";
import { getSkillRuntimeAvailability } from "./runtime-availability.js";

const writerRegisteredAt = Math.floor(Date.now() / 1000);

export function getWriterAgentId(): string {
  return (
    writerConfig.identity.agentId ??
    `${writerConfig.chainId}:${writerConfig.writerAddress.toLowerCase()}`
  );
}

function getAdvertisedPayment(): {
  price: string;
  asset: AssetRef;
  currency: string;
  paymentRails: ServiceInfo["paymentRails"];
} {
  if (!writerConfig.x402.enabled) {
    return {
      price: writerConfig.priceWei,
      asset: writerConfig.chain.nativeAsset,
      currency: writerConfig.chain.nativeAsset.symbol,
      paymentRails: ["legacy-native"]
    };
  }
  const token = U_TOKEN[writerConfig.chainId as 56 | 97];
  if (!token) {
    throw new Error(`x402 $U is unsupported on chain ${writerConfig.chainId}`);
  }
  const asset: AssetRef = {
    chainId: writerConfig.chainId,
    kind: "erc20",
    address: token.address,
    symbol: token.symbol,
    decimals: token.decimals
  };
  return {
    price: writerConfig.x402.priceAmount,
    asset,
    currency: asset.symbol,
    paymentRails: ["x402"]
  };
}

function toServiceInfo(skill: LoadedSkill): ServiceInfo {
  const payment = getAdvertisedPayment();
  const availability = getSkillRuntimeAvailability(skill);
  return {
    id: skill.config.id,
    name: skill.config.name,
    description: skill.config.description ?? `Task execution service for ${skill.canonicalTaskType}`,
    endpoint: writerConfig.publicEndpoint,
    taskType: skill.canonicalTaskType,
    skills: [...skill.config.skills],
    price: writerConfig.x402.enabled
      ? writerConfig.x402.priceAmount
      : getSkillPriceWei(skill, payment.price),
    currency: payment.currency,
    asset: payment.asset,
    agentId: getWriterAgentId(),
    paymentRails: payment.paymentRails,
    offerVersion: writerConfig.x402.enabled ? "2" : "1",
    network: buildCaip2Network(writerConfig.chainId),
    provider: writerConfig.writerAddress,
    availability
  };
}

export function getWriterIdentity(): AgentIdentity {
  const skills = listLoadedSkills();
  const availableSkills = skills.filter((skill) => getSkillRuntimeAvailability(skill).available);
  const capabilitySkills = [
    ...new Set([
      ...availableSkills.flatMap((item) => item.config.taskTypes),
      ...availableSkills.flatMap((item) => item.config.skills),
      "x402-paywall"
    ])
  ];

  return {
    agentId: getWriterAgentId(),
    name: writerConfig.identity.name,
    description: writerConfig.identity.description,
    image: writerConfig.identity.image,
    walletAddress: writerConfig.writerAddress,
    capabilities: [
      {
        type: "a2a",
        endpoint: `${writerConfig.publicEndpoint}/execute`,
        skills: capabilitySkills
      },
      {
        type: "mcp",
        endpoint: `${writerConfig.publicEndpoint}/execute`,
        tools: ["quote", "execute", "receipt-sign", "skill-routing"]
      }
    ],
    trustModels: writerConfig.identity.trustModels,
    active: availableSkills.length > 0,
    registeredAt: writerRegisteredAt
  };
}

export function getWriterServicesInfo(): ServiceInfo[] {
  return listLoadedSkills().map((skill) => toServiceInfo(skill));
}

export function getWriterServiceInfo(): ServiceInfo {
  const primary = listLoadedSkills()[0];
  if (!primary) {
    throw new Error("Writer has no enabled service profile");
  }
  return toServiceInfo(primary);
}
