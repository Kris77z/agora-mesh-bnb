import { persistAgentIdentity, registerDynamicService } from "@rebel/shared";
import { writerConfig } from "./config.js";
import { getWriterIdentity, getWriterServicesInfo } from "./identity.js";

function normalizeEndpoint(endpoint: string): string {
  return endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
}

const advertiseStatus: {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailure?: string;
} = {};

export function getWriterAdvertiseStatus() {
  return { ...advertiseStatus };
}

export async function advertiseWriterCapabilities(input: { silent?: boolean } = {}): Promise<void> {
  advertiseStatus.lastAttemptAt = new Date().toISOString();
  const identity = await persistAgentIdentity(getWriterIdentity());
  const services = getWriterServicesInfo();
  let remoteRegistrations = 0;
  let remoteIdentityRegistered = false;
  let lastFailure: string | undefined;

  try {
    const response = await fetch(
      `${normalizeEndpoint(writerConfig.discovery.serviceUrl)}/agents/register`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(writerConfig.discovery.apiAuthToken
            ? { Authorization: `Bearer ${writerConfig.discovery.apiAuthToken}` }
            : {})
        },
        body: JSON.stringify(identity)
      }
    );
    if (response.ok) remoteIdentityRegistered = true;
    else lastFailure = `Registry identity returned HTTP ${response.status}`;
  } catch (error) {
    lastFailure = error instanceof Error ? error.message : String(error);
  }

  for (const service of services) {
    await registerDynamicService({
      agentId: identity.agentId,
      service,
      ttlSeconds: writerConfig.discovery.ttlSeconds
    });

    try {
      const response = await fetch(
        `${normalizeEndpoint(writerConfig.discovery.serviceUrl)}/services/register`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(writerConfig.discovery.apiAuthToken
              ? { Authorization: `Bearer ${writerConfig.discovery.apiAuthToken}` }
              : {})
          },
          body: JSON.stringify({
            agentId: identity.agentId,
            service,
            ttlSeconds: writerConfig.discovery.ttlSeconds
          })
        }
      );
      if (!response.ok && !input.silent) {
        console.warn(
          `[writer] registry service register failed: service=${service.id} status=${response.status}`
        );
      }
      if (response.ok) remoteRegistrations += 1;
      else lastFailure = `Registry returned HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      if (!input.silent) {
        console.warn(
          `[writer] registry service unavailable: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  if (remoteIdentityRegistered && remoteRegistrations === services.length) {
    advertiseStatus.lastSuccessAt = new Date().toISOString();
    advertiseStatus.lastFailure = undefined;
  } else {
    advertiseStatus.lastFailureAt = new Date().toISOString();
    advertiseStatus.lastFailure = lastFailure ?? "Registry heartbeat was incomplete";
  }

  if (!input.silent) {
    console.log(
      `[writer] capability advertised | agentId=${identity.agentId} | capabilities=${identity.capabilities.length} | services=${services.length}`
    );
  }
}
