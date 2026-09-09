/** Use the fixed public origin behind a TLS reverse proxy, never a client-supplied forwarded host. */
export function isAllowedAltanaOrigin(origin: string | null, requestUrl: string, publicOrigin?: string): boolean {
  if (!origin) return true;
  try {
    return origin === new URL(publicOrigin || requestUrl).origin;
  } catch {
    return false;
  }
}
