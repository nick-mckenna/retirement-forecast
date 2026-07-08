// Thin client for the local persistence API (server/index.ts), which owns the
// SQL Server database. All calls go through the Vite /api proxy.

import type { Scenario } from "../model/types";

export const BACKUP_FORMAT = "retirement-forecast-backup";

export interface RemoteState {
  scenarios: Scenario[];
  activeId: string | null;
}

/** The JSON backup envelope: a snapshot of the whole database. */
export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt?: string;
  activeId: string | null;
  scenarios: Scenario[];
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let message = `API error ${res.status}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  state: () => http<RemoteState>("/state"),
  /** `keepalive` lets the final debounced save survive a page unload. */
  saveScenario: (scenario: Scenario, sortOrder?: number, keepalive = false) =>
    http<void>(`/scenarios/${encodeURIComponent(scenario.id)}`, {
      method: "PUT",
      body: JSON.stringify({ scenario, sortOrder }),
      keepalive,
    }),
  deleteScenario: (id: string) =>
    http<void>(`/scenarios/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setActive: (activeId: string | null) =>
    http<void>("/active", { method: "PUT", body: JSON.stringify({ activeId }) }),
  exportBackup: () => http<BackupFile>("/export"),
  importBackup: (backup: BackupFile) =>
    http<RemoteState>("/import", { method: "POST", body: JSON.stringify(backup) }),
};
