/**
 * Backend API endpoint configuration.
 * Values are loaded from NEXT_PUBLIC_* env vars with sensible defaults.
 */
const serverRuntime = typeof window === 'undefined';

export const apiBase = {
    hunter: serverRuntime
        ? process.env.HUNTER_INTERNAL_URL ?? process.env.NEXT_PUBLIC_HUNTER_URL ?? "http://localhost:3002"
        : process.env.NEXT_PUBLIC_HUNTER_URL ?? "/api/hunter",
    writer: serverRuntime
        ? process.env.WRITER_INTERNAL_URL ?? process.env.NEXT_PUBLIC_WRITER_URL ?? "http://localhost:3001"
        : process.env.NEXT_PUBLIC_WRITER_URL ?? "/api/auditor",
    registry: serverRuntime
        ? process.env.REGISTRY_INTERNAL_URL ?? process.env.NEXT_PUBLIC_REGISTRY_URL ?? "http://localhost:3003"
        : process.env.NEXT_PUBLIC_REGISTRY_URL ?? "/api/registry",
} as const;

// The public value is intentionally a scoped demo token, never a wallet/session or server secret.
export const demoApiToken = process.env.AGORA_DEMO_API_TOKEN ?? process.env.NEXT_PUBLIC_DEMO_API_TOKEN;
