import { apiBase, demoApiToken } from '@/lib/api-config';
import type { StoredHunterMission, StoredMissionSummary } from '@/types/mission';

async function requestMissionJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(demoApiToken ? { Authorization: `Bearer ${demoApiToken}` } : {}),
    },
    signal: AbortSignal.timeout(8_000),
  });
  const payload = await response.json().catch(() => null) as (T & { message?: string }) | null;
  if (!response.ok) {
    throw new Error(payload?.message ?? `Hunter Mission API returned ${response.status}`);
  }
  if (!payload) throw new Error('Hunter Mission API returned an invalid response');
  return payload;
}

export async function getMission(missionId: string): Promise<StoredHunterMission> {
  const payload = await requestMissionJson<{ mission: StoredHunterMission }>(
    `${apiBase.hunter}/missions/${encodeURIComponent(missionId)}`,
  );
  return payload.mission;
}

export async function listMissions(): Promise<StoredMissionSummary[]> {
  const payload = await requestMissionJson<{ missions: StoredMissionSummary[] }>(
    `${apiBase.hunter}/missions`,
  );
  return payload.missions;
}
