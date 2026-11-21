import { sql } from "drizzle-orm";
import { z } from "zod";

import { findCommand } from "@/server/audit";
import { type AppDatabase, db } from "@/server/db/client";
import { APP_MODE, type AppMode } from "@/server/env";
import type { DbExecutor } from "@/server/numbering";
export type CommandTransaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

export interface CommandActor {
  userId?: string | null;
  ip?: string | null;
  deviceId?: string | null;
}

export const actorSchema = z.object({
  userId: z.string().nullable().optional(),
  ip: z.string().nullable().optional(),
  deviceId: z.string().nullable().optional(),
}).default({});

export interface CommandRequest {
  facilityId: string;
  idempotencyKey: string;
}

export interface CommandOptions {
  database?: AppDatabase;
  /** Effective node mode; defaults to APP_MODE. Used to simulate a branch in tests. */
  mode?: AppMode;
  /** Opt-in for commands that write a proposal, not branch-owned data. */
  allowCrossAuthority?: boolean;
}

export class CommandConflictError extends Error {
  constructor(message = "The idempotency key belongs to a different command") {
    super(message);
    this.name = "CommandConflictError";
  }
}

/**
 * Claim the idempotency key before doing any work. A replay waits on the
 * unique key, then reads the stored result after the first caller commits.
 * If the first caller rolls back, the replay claims the key and runs normally.
 */
export async function runCommand<T>(
  request: CommandRequest,
  commandName: string,
  work: (tx: CommandTransaction) => Promise<T>,
  options: CommandOptions = {},
): Promise<T> {
  const executor = options.database ?? db;

  return executor.transaction(async (tx) => {
    const authority = await tx.execute(sql`
      SELECT write_authority::text AS "writeAuthority"
      FROM facilities
      WHERE id = ${request.facilityId}::uuid
      LIMIT 1
    `);
    const storedAuthority = ((authority as { rows?: Array<{ writeAuthority?: string }> }).rows ?? [])[0]?.writeAuthority;
    const mode = options.mode ?? APP_MODE;
    if (
      !options.allowCrossAuthority &&
      storedAuthority &&
      ((mode === "cloud" && storedAuthority !== "cloud") ||
        (mode === "clinic" && storedAuthority !== "clinic"))
    ) {
      throw new Error(
        `Facility is owned by ${storedAuthority}; writes from ${mode} mode are not allowed`,
      );
    }

    const claim = await tx.execute(sql`
      INSERT INTO command_log (idempotency_key, facility_id, command, result, created_at)
      VALUES (
        ${request.idempotencyKey}::uuid,
        ${request.facilityId}::uuid,
        ${commandName}::text,
        '{}'::jsonb,
        now()
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING idempotency_key
    `);
    const claimed = ((claim as { rows?: unknown[] }).rows ?? []).length > 0;

    if (!claimed) {
      const stored = await findCommand(tx, request.facilityId, request.idempotencyKey);
      if (!stored) throw new Error("Command claim failed");
      if (stored.command !== commandName) throw new CommandConflictError();
      return stored.result as T;
    }

    const result = await work(tx);
    await tx.execute(sql`
      UPDATE command_log
      SET result = ${JSON.stringify(result ?? {})}::jsonb
      WHERE idempotency_key = ${request.idempotencyKey}::uuid
        AND facility_id = ${request.facilityId}::uuid
    `);
    return result;
  });
}

/** Helper for tests and callers that only need raw SQL execution. */
export function asExecutor(tx: CommandTransaction): DbExecutor {
  return tx;
}
