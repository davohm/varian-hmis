import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { ADMIN_SECTIONS } from "@/lib/admin-sections";
import {
  adminSectionPermissions,
  staffRoleScopes,
} from "@/server/db/schema";

import { runCommand, type CommandOptions } from "../run";
import {
  adminBaseSchema,
  requireActor,
  verifyManagedFacilities,
  writeAdminAudit,
} from "./shared";

const sectionSchema = z.enum(ADMIN_SECTIONS);

export const setAdminSectionAccessSchema = z.object({
  ...adminBaseSchema,
  userId: z.string().min(1),
  /** An empty list resets the account to full administration access. */
  sections: z.array(sectionSchema).max(ADMIN_SECTIONS.length).refine(
    (sections) => new Set(sections).size === sections.length,
    "Duplicate administration sections are not allowed",
  ),
  allowedFacilityIds: z.array(z.uuid()).optional(),
});

export type SetAdminSectionAccessInput = z.input<typeof setAdminSectionAccessSchema>;

export async function setAdminSectionAccess(
  input: SetAdminSectionAccessInput,
  options: CommandOptions = {},
) {
  const values = setAdminSectionAccessSchema.parse(input);
  const actorId = requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "setAdminSectionAccess",
    async (tx) => {
      verifyManagedFacilities([values.facilityId], values.allowedFacilityIds);

      if (values.userId === actorId && values.sections.length === 0) {
        throw new Error("Use a limited section list instead of clearing your own access");
      }

      const scopes = await tx
        .select({ role: staffRoleScopes.role })
        .from(staffRoleScopes)
        .where(
          and(
            eq(staffRoleScopes.userId, values.userId),
            eq(staffRoleScopes.facilityId, values.facilityId),
            eq(staffRoleScopes.role, "admin"),
          ),
        )
        .limit(1);
      if (!scopes[0]) throw new Error("Target user is not an administrator for this facility");

      await tx
        .delete(adminSectionPermissions)
        .where(
          and(
            eq(adminSectionPermissions.userId, values.userId),
            eq(adminSectionPermissions.facilityId, values.facilityId),
          ),
        );

      if (values.sections.length > 0) {
        await tx.insert(adminSectionPermissions).values(
          values.sections.map((section) => ({
            userId: values.userId,
            facilityId: values.facilityId,
            section,
          })),
        );
      }

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.access.sections",
        entity: "admin_section_permissions",
        entityId: values.userId,
        details: { sections: values.sections },
      });

      return { userId: values.userId, sections: values.sections };
    },
    options,
  );
}
