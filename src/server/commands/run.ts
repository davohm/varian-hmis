import { sql } from "drizzle-orm";
import { z } from "zod";

import { findCommand } from "@/server/audit";
import { db } from "@/server/db/client";
import type { DbExecutor } from "@/server/numbering";

type AppDatabase = typeof db;
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
