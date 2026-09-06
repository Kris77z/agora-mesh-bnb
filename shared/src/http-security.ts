import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function parseOriginAllowlist(raw: string | undefined, fallback: string[]): string[] {
  const values = raw?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  return [...new Set(values.length > 0 ? values : fallback)];
}

export function isAllowedCorsOrigin(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  return origin === undefined || allowedOrigins.includes(origin);
}

export function normalizeRequestId(value: string | undefined): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : randomUUID();
}

export function apiTokenMatches(expected: string | undefined, presented: string | undefined): boolean {
  if (!expected || !presented) return false;
  const expectedHash = createHash("sha256").update(expected).digest();
  const presentedHash = createHash("sha256").update(presented).digest();
  return timingSafeEqual(expectedHash, presentedHash);
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maximum: number,
    private readonly windowMs: number
  ) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) throw new Error("maximum must be positive");
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) throw new Error("windowMs must be positive");
  }

  consume(key: string, now = Date.now()): { allowed: boolean; remaining: number; resetAt: number } {
    const current = this.windows.get(key);
    const window = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + this.windowMs }
      : current;
    window.count += 1;
    this.windows.set(key, window);
    if (this.windows.size > 10_000) {
      for (const [entryKey, entry] of this.windows) {
        if (entry.resetAt <= now) this.windows.delete(entryKey);
      }
    }
    return {
      allowed: window.count <= this.maximum,
      remaining: Math.max(0, this.maximum - window.count),
      resetAt: window.resetAt
    };
  }
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    a! >= 224;
}

export function isPrivateIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version !== 6) return true;
  const normalized = address.toLowerCase();
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.");
}

export function validateServiceEndpointUrl(
  endpoint: string,
  options: { allowLocal: boolean; allowedHosts?: readonly string[] }
): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Service endpoint must be an absolute URL");
  }
  if (url.username || url.password || url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Service endpoint must be an origin URL without credentials or a path");
  }
  const hostname = url.hostname.toLowerCase();
  const explicitlyAllowed = options.allowedHosts?.some((host) => host.toLowerCase() === hostname) ?? false;
  const local = hostname === "localhost" || hostname.endsWith(".localhost") ||
    (isIP(hostname) > 0 && isPrivateIpAddress(hostname));
  if (local && !(options.allowLocal || explicitlyAllowed)) {
    throw new Error("Private, loopback, and metadata-network service endpoints are not allowed");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (options.allowLocal || explicitlyAllowed))) {
    throw new Error("Service endpoint must use HTTPS");
  }
  return url;
}

export async function assertSafeServiceEndpoint(
  endpoint: string,
  options: { allowLocal: boolean; allowedHosts?: readonly string[] }
): Promise<URL> {
  const url = validateServiceEndpointUrl(endpoint, options);
  const explicitlyAllowed = options.allowedHosts?.some((host) => host.toLowerCase() === url.hostname.toLowerCase()) ?? false;
  if (options.allowLocal || explicitlyAllowed || isIP(url.hostname) > 0) return url;
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateIpAddress(entry.address))) {
    throw new Error("Service endpoint DNS resolved to a non-public address");
  }
  return url;
}
