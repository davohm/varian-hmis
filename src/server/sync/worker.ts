import { db as defaultDb } from "@/server/db/client";
import {
  CLOUD_URL,
  FACILITY_DEVICE_KEY,
  FACILITY_ID,
  FACILITY_SYNC_TOKEN,
  SYNC_BATCH_SIZE,
  SYNC_POLL_MS,
  SYNC_PULL_MS,
  SYNC_TIMEOUT_MS,
} from "@/server/env";
import type { DbExecutor } from "@/server/numbering";

import {
  listPendingRows,
  markRowsFailed,
  markRowsSynced,
  readSyncState,
} from "./outbox";
import { applyPullRows } from "./pull";
import { pullResponseSchema, type SyncRow } from "./types";

type Database = typeof defaultDb;

export interface SyncWorkerConfig {
  database: Database;
  facilityId: string;
  token: string;
  deviceKey: string;
  cloudUrl: string;
  batchSize: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

export interface SyncCycleResult {
  online: boolean;
  pushed: number;
  pulled: number;
  errors: string[];
}

function resolveConfig(overrides: Partial<SyncWorkerConfig> = {}): SyncWorkerConfig {
  const cloudUrl = overrides.cloudUrl ?? CLOUD_URL;
  const facilityId = overrides.facilityId ?? FACILITY_ID;
  const token = overrides.token ?? FACILITY_SYNC_TOKEN;
  if (!cloudUrl || !facilityId || !token) {
    throw new Error("Sync worker requires CLOUD_URL, FACILITY_ID and FACILITY_SYNC_TOKEN");
  }
  return {
    database: overrides.database ?? defaultDb,
    facilityId,
    token,
    deviceKey: overrides.deviceKey ?? FACILITY_DEVICE_KEY,
    cloudUrl: cloudUrl.replace(/\/+$/, ""),
    batchSize: overrides.batchSize ?? SYNC_BATCH_SIZE,
    timeoutMs: overrides.timeoutMs ?? SYNC_TIMEOUT_MS,
    fetchImpl: overrides.fetchImpl ?? fetch,
  };
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function isOnline(config: SyncWorkerConfig): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      config.fetchImpl,
      `${config.cloudUrl}/api/health`,
      { method: "GET" },
      config.timeoutMs,
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function pushPending(config: SyncWorkerConfig): Promise<{ pushed: number; error: string | null }> {
  const rows = await listPendingRows(config.database, config.batchSize, config.facilityId);
  if (rows.length === 0) return { pushed: 0, error: null };

  const payload = rows.map((row: SyncRow) => ({ ...row, deviceKey: config.deviceKey }));

  try {
    const response = await fetchWithTimeout(
      config.fetchImpl,
      `${config.cloudUrl}/api/sync/batch`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.token}`,
          "x-device-key": config.deviceKey,
        },
        body: JSON.stringify({
          facilityId: config.facilityId,
          deviceKey: config.deviceKey,
          rows: payload,
        }),
      },
      config.timeoutMs,
    );

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new Error(`Batch rejected (${response.status}): ${detail}`);
    }

    const body = (await response.json()) as { acceptedOutboxIds?: string[] };
    const accepted = new Set(body.acceptedOutboxIds ?? []);
    const acceptedRows = rows.filter((row) => accepted.has(row.outboxId));
    await markRowsSynced(config.database, acceptedRows.map((row) => row.outboxId));
    return { pushed: acceptedRows.length, error: null };
  } catch (error) {
    const message = errorMessage(error);
    await markRowsFailed(config.database, rows.map((row) => row.outboxId), message);
    return { pushed: 0, error: message };
  }
}

async function pullCatalogs(config: SyncWorkerConfig): Promise<{ pulled: number; error: string | null }> {
  try {
    const state = await readSyncState(config.database, "last_pulled_at");
    const since = typeof state?.timestamp === "string" ? state.timestamp : new Date(0).toISOString();
    const url = new URL(`${config.cloudUrl}/api/sync/pull`);
    url.searchParams.set("since", since);

    const response = await fetchWithTimeout(
      config.fetchImpl,
      url.toString(),
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${config.token}`,
          "x-device-key": config.deviceKey,
        },
      },
      config.timeoutMs,
    );
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new Error(`Pull rejected (${response.status}): ${detail}`);
    }

    const parsed = pullResponseSchema.parse(await response.json());
    await (config.database as Database).transaction(async (tx: DbExecutor) => {
      await applyPullRows(tx, parsed.rows, parsed.pulledAt);
    });
    return { pulled: parsed.rows.length, error: null };
  } catch (error) {
    return { pulled: 0, error: errorMessage(error) };
  }
}

export async function runSyncCycle(
  overrides: Partial<SyncWorkerConfig> = {},
  options: { push?: boolean; pull?: boolean } = {},
): Promise<SyncCycleResult> {
  const config = resolveConfig(overrides);
  const errors: string[] = [];
  const online = await isOnline(config);
  if (!online) return { online: false, pushed: 0, pulled: 0, errors: [] };

  let pushed = 0;
  let pulled = 0;

  if (options.push !== false) {
    const result = await pushPending(config);
    pushed = result.pushed;
    if (result.error) errors.push(result.error);
  }
  if (options.pull !== false) {
    const result = await pullCatalogs(config);
    pulled = result.pulled;
    if (result.error) errors.push(result.error);
  }

  return { online: true, pushed, pulled, errors };
}

export async function startSyncWorker(): Promise<void> {
  if (!FACILITY_ID || !FACILITY_SYNC_TOKEN || !CLOUD_URL) {
    throw new Error("Sync worker requires CLOUD_URL, FACILITY_ID and FACILITY_SYNC_TOKEN");
  }

  let running = true;
  let lastPullAt = 0;
  const stop = () => { running = false; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  console.log("[sync-worker] started", { facilityId: FACILITY_ID, cloudUrl: CLOUD_URL });
  while (running) {
    const shouldPull = Date.now() - lastPullAt >= SYNC_PULL_MS;
    try {
      const result = await runSyncCycle({}, { push: true, pull: shouldPull });
      if (shouldPull && result.online) lastPullAt = Date.now();
      if (!result.online) {
        console.warn("[sync-worker] cloud offline");
      } else {
        console.log("[sync-worker] cycle", {
          pushed: result.pushed,
          pulled: result.pulled,
          errors: result.errors,
        });
      }
    } catch (error) {
      console.error("[sync-worker] cycle failed", error);
    }
    await new Promise((resolve) => setTimeout(resolve, SYNC_POLL_MS));
  }
  console.log("[sync-worker] stopped");
}
