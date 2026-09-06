import { apiBase, demoApiToken } from '@/lib/api-config';
import type { AuthoritySnapshot } from '@/types/authority';

export async function getAuthoritySnapshot(): Promise<AuthoritySnapshot> {
  const response = await fetch(`${apiBase.hunter}/authority`, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(demoApiToken ? { Authorization: `Bearer ${demoApiToken}` } : {}),
    },
    signal: AbortSignal.timeout(8_000),
  });

  const payload = await response.json().catch(() => null) as
    | AuthoritySnapshot
    | { message?: string }
    | null;
  if (!response.ok) {
    throw new Error(payload && 'message' in payload && payload.message
      ? payload.message
      : `Hunter Authority API returned ${response.status}`);
  }
  if (!payload || !('authority' in payload) || !('now' in payload) || !('spending' in payload)) {
    throw new Error('Hunter Authority API returned an invalid response');
  }
  return payload;
}
