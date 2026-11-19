import { and, asc, eq } from "drizzle-orm";

import { ADMIN_SECTIONS, type AdminSection } from "@/lib/admin-sections";
import { db } from "@/server/db/client";
import { adminSectionPermissions } from "@/server/db/schema";

/**
 * Resolve effective sections. Legacy administrators have no explicit grant
 * rows and keep access to every section; any grant row makes the list exact.
 */
export async function getAdminSections(
  userId: string,
  facilityId: string,
  database: typeof db = db,
): Promise<AdminSection[]> {
  const grants = await database
    .select({ section: adminSectionPermissions.section })
    .from(adminSectionPermissions)
    .where(
      and(
        eq(adminSectionPermissions.userId, userId),
        eq(adminSectionPermissions.facilityId, facilityId),
      ),
    )
    .orderBy(asc(adminSectionPermissions.section));

  if (grants.length === 0) return [...ADMIN_SECTIONS];
  return grants
    .map((grant) => grant.section)
    .filter((section): section is AdminSection =>
      (ADMIN_SECTIONS as readonly string[]).includes(section),
    );
}
