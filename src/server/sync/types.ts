import { z } from "zod";

import { isInboundSyncTable, isOutboundSyncTable } from "./registry";

export const syncRowSchema = z.object({
  outboxId: z.uuid(),
  facilityId: z.uuid(),
  deviceKey: z.string().trim().min(1).max(128),
  tableName: z.string().refine(isOutboundSyncTable, "Table is not syncable"),
  recordId: z.string().trim().min(1).max(256),
  operation: z.enum(["INSERT", "UPDATE", "DELETE"]),
  payload: z.record(z.string(), z.unknown()),
  version: z.number().int().nonnegative().optional(),
});

export const syncBatchSchema = z.object({
  facilityId: z.uuid(),
  deviceKey: z.string().trim().min(1).max(128),
  rows: z.array(syncRowSchema).min(1).max(100),
});

export const pullRowSchema = z.object({
  tableName: z.string().refine(isInboundSyncTable, "Table is not pullable"),
  payload: z.record(z.string(), z.unknown()),
});

export const pullResponseSchema = z.object({
  rows: z.array(pullRowSchema),
  pulledAt: z.string(),
});

export type SyncRow = z.infer<typeof syncRowSchema>;
export type PullRow = z.infer<typeof pullRowSchema>;
export type SyncOperation = SyncRow["operation"];
