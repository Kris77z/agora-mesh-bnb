import type { AgentEvent, HunterRunResult } from '@/types/agent';

export interface StoredHunterMission {
  missionId: string;
  goal: string;
  chainId: number;
  authorityId?: string;
  mode: 'scripted' | 'react' | 'commander';
  status: 'completed' | 'failed';
  source: 'live-run' | 'recovered-evidence';
  events: AgentEvent[];
  result?: HunterRunResult;
  error?: { code?: string; message: string };
  createdAt: number;
  completedAt: number;
}

export interface StoredMissionSummary {
  missionId: string;
  goal: string;
  mode: StoredHunterMission['mode'];
  status: StoredHunterMission['status'];
  source: StoredHunterMission['source'];
  serviceId?: string;
  score?: number;
  createdAt: number;
  completedAt: number;
}
