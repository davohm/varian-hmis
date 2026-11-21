import { sql } from "drizzle-orm";
import { z } from "zod";

import { newId } from "@/lib/uuid";
import { adminOverrides } from "@/server/db/schema";
import {
  assertOverridableTable,
  assertOverrideChanges,
  readOverrideTargetVersion,
} from "@/server/sync/overrides";

import { runCommand, type CommandOptions } from "../run";
import { adminBaseSchema, requireActor, writeAdminAudit } from "./shared";

const overrideIdentitySchema = {
  overrideId: z.uuid(),
  decisionReason: z.string().trim().min(3).max(500).optional(),
};

const proposeSchema = z.object({
  ...adminBaseSchema,
  tableName: z.string().trim().min(2).max(64),
  recordId: z.string().trim().min(1).max(64),
  changes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  basedOnVersion: z.number().int().positive(),
  reason: z.string().trim().min(5).max(500),
  allowedFacilityIds: z.array(z.uuid()).optional(),
});
export type ProposeAdminOverrideInput = z.input<typeof proposeSchema>;

/** Cloud-only: create a proposal for a branch-owned record. */
export async function proposeAdminOverride(
  input: ProposeAdminOverrideInput,
  options: CommandOptions = {},
) {
  const values = proposeSchema.parse(input);
  const actorId = requireActor(values.actor);
  const mode = options.mode ?? "cloud";
  if (mode !== "cloud") throw new Error("Overrides can only be proposed from the cloud");
  if (values.allowedFacilityIds && !values.allowedFacilityIds.includes(values.facilityId)) {
    throw new Error("Facility is outside your administration scope");
  }
  assertOverrideChanges(values.tableName, values.changes);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "proposeAdminOverride",
    async (tx) => {
      const authority = await tx.execute(sql`
        SELECT write_authority::text AS "writeAuthority"
        FROM facilities WHERE id = ${values.facilityId}::uuid
      `);
      const writeAuthority = (authority as { rows?: Array<{ writeAuthority?: string }> }).rows?.[0]?.writeAuthority;
      if (writeAuthority !== "clinic") {
        throw new Error("Overrides are only for clinic-owned branch records");
      }

      const currentVersion = await readOverrideTargetVersion(
        tx,
        values.tableName,
        values.facilityId,
        values.recordId,
      );
      if (currentVersion === null) throw new Error("Target record was not found");
      if (currentVersion !== values.basedOnVersion) {
        throw new Error(
          `Target record changed: expected version ${values.basedOnVersion}, found ${currentVersion}`,
        );
      }

      const id = newId();
      // Proposals reach the branch through the pull channel. Suppressing the
      // outbox here prevents a duplicate copy being pushed as ordinary data.
      await tx.execute(sql`SET LOCAL varian.sync_apply = 'on'`);
      await tx.insert(adminOverrides).values({
        id,
        facilityId: values.facilityId,
        tableName: values.tableName,
        recordId: values.recordId,
        changes: values.changes,
        basedOnVersion: values.basedOnVersion,
        reason: values.reason,
        requestedBy: actorId,
        status: "proposed",
        createdAt: new Date(),
        updatedAt: new Date(),
        version: 1,
      });

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.override.propose",
        entity: "admin_overrides",
        entityId: id,
        details: {
          table: values.tableName,
          recordId: values.recordId,
          fields: Object.keys(values.changes),
          basedOnVersion: values.basedOnVersion,
          reason: values.reason,
        },
      });

      return { overrideId: id, status: "proposed" as const };
    },
    { ...options, allowCrossAuthority: true },
  );
}

function tableIdentifier(tableName: string) {
  assertOverridableTable(tableName);
  // Only allow-listed names reach this function.
  return sql.raw(`"${tableName}"`);
}

const applySchema = z.object({
  ...adminBaseSchema,
  ...overrideIdentitySchema,
});
export type ApplyAdminOverrideInput = z.input<typeof applySchema>;

export type OverrideApplyResult =
  | { status: "applied"; version: number }
  | { status: "conflicted"; expectedVersion: number; actualVersion: number }
  | { status: "invalid"; reason: string };

/** Clinic-only: apply a proposal to the branch's own record. */
export async function applyAdminOverride(
  input: ApplyAdminOverrideInput,
  options: CommandOptions = {},
): Promise<OverrideApplyResult> {
  const values = applySchema.parse(input);
  const actorId = requireActor(values.actor);
  const mode = options.mode ?? "clinic";
  if (mode !== "clinic") throw new Error("Overrides can only be applied on a branch");

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "applyAdminOverride",
    async (tx): Promise<OverrideApplyResult> => {
      const proposals = await tx
        .select()
        .from(adminOverrides)
        .where(sql`id = ${values.overrideId}::uuid AND facility_id = ${values.facilityId}::uuid`)
        .limit(1);
      const proposal = proposals[0];
      if (!proposal) return { status: "invalid", reason: "Override was not found for this facility" };
      if (proposal.status !== "proposed") {
        return { status: "invalid", reason: `Override is already ${proposal.status}` };
      }

      assertOverridableTable(proposal.tableName);
      assertOverrideChanges(proposal.tableName, proposal.changes);

      const currentVersion = await readOverrideTargetVersion(
        tx,
        proposal.tableName,
        values.facilityId,
        proposal.recordId,
      );
      if (currentVersion === null || currentVersion !== proposal.basedOnVersion) {
        const actualVersion = currentVersion ?? -1;
        await tx.execute(sql`
          UPDATE admin_overrides
          SET status = 'conflicted', decision_by = ${actorId},
              decision_reason = ${`Branch version ${actualVersion} did not match base version ${proposal.basedOnVersion}`},
              updated_at = now(), version = version + 1
          WHERE id = ${values.overrideId}::uuid
        `);
        await writeAdminAudit(tx, {
          facilityId: values.facilityId,
          actor: values.actor,
          action: "admin.override.conflict",
          entity: "admin_overrides",
          entityId: proposal.id,
          details: {
            table: proposal.tableName,
            recordId: proposal.recordId,
            expectedVersion: proposal.basedOnVersion,
            actualVersion,
          },
        });
        return {
          status: "conflicted",
          expectedVersion: proposal.basedOnVersion,
          actualVersion,
        };
      }

      const assignments = [
        ...Object.entries(proposal.changes).map(([field, value]) =>
          sql`${sql.raw(`"${field}"`)} = ${value}`),
        sql`updated_at = now()`,
        sql`version = version + 1`,
      ];
      const targetScope = proposal.tableName === "facilities"
        ? sql`id = ${values.facilityId}::uuid AND id = ${proposal.recordId}::uuid`
        : sql`facility_id = ${values.facilityId}::uuid AND id = ${proposal.recordId}::uuid`;
      await tx.execute(sql`
        UPDATE ${tableIdentifier(proposal.tableName)}
        SET ${sql.join(assignments, sql`, `)}
        WHERE ${targetScope}
      `);

      await tx.execute(sql`
        UPDATE admin_overrides
        SET status = 'applied', decision_by = ${actorId}, applied_at = now(),
            decision_reason = ${values.decisionReason ?? null},
            updated_at = now(), version = version + 1
        WHERE id = ${values.overrideId}::uuid
      `);
      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.override.apply",
        entity: proposal.tableName,
        entityId: proposal.recordId,
        details: {
          overrideId: proposal.id,
          fields: Object.keys(proposal.changes),
          basedOnVersion: proposal.basedOnVersion,
          requestedBy: proposal.requestedBy,
        },
      });

      return { status: "applied", version: currentVersion + 1 };
    },
    options,
  );
}

const rejectSchema = z.object({
  ...adminBaseSchema,
  ...overrideIdentitySchema,
  decisionReason: z.string().trim().min(3).max(500),
});
export type RejectAdminOverrideInput = z.input<typeof rejectSchema>;

/** Clinic-only: decline a proposal without touching the branch record. */
export async function rejectAdminOverride(
  input: RejectAdminOverrideInput,
  options: CommandOptions = {},
) {
  const values = rejectSchema.parse(input);
  const actorId = requireActor(values.actor);
  const mode = options.mode ?? "clinic";
  if (mode !== "clinic") throw new Error("Overrides can only be decided on a branch");

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "rejectAdminOverride",
    async (tx) => {
      const proposals = await tx
        .select()
        .from(adminOverrides)
        .where(sql`id = ${values.overrideId}::uuid AND facility_id = ${values.facilityId}::uuid`)
        .limit(1);
      const proposal = proposals[0];
      if (!proposal) throw new Error("Override was not found for this facility");
      if (proposal.status !== "proposed") throw new Error(`Override is already ${proposal.status}`);

      await tx.execute(sql`
        UPDATE admin_overrides
        SET status = 'rejected', decision_by = ${actorId},
            decision_reason = ${values.decisionReason},
            updated_at = now(), version = version + 1
        WHERE id = ${values.overrideId}::uuid
      `);
      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.override.reject",
        entity: "admin_overrides",
        entityId: proposal.id,
        details: {
          table: proposal.tableName,
          recordId: proposal.recordId,
          reason: values.decisionReason,
        },
      });
      return { status: "rejected" as const };
    },
    options,
  );
}
