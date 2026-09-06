import { apiBase, demoApiToken } from '@/lib/api-config';
import type { AdvantageReport } from '@/types/advantage';

export async function getAdvantageReport(): Promise<AdvantageReport> {
  const response = await fetch(`${apiBase.hunter}/advantage`, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(demoApiToken ? { Authorization: `Bearer ${demoApiToken}` } : {}),
    },
    signal: AbortSignal.timeout(8_000),
  });
  const payload = await response.json().catch(() => null) as
    | AdvantageReport
    | { message?: string }
    | null;
  if (!response.ok) {
    throw new Error(payload && 'message' in payload && payload.message
      ? payload.message
      : `Hunter Advantage API returned ${response.status}`);
  }
  if (!payload || !('experiments' in payload) || !Array.isArray(payload.experiments)) {
    throw new Error('Hunter Advantage API returned an invalid response');
  }
  return payload;
}
