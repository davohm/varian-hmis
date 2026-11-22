import { redirect } from "next/navigation";

import type { AdminSection } from "@/lib/admin-sections";

import { getAdminSections } from "./admin-access";
import { requireScreen } from "./guards";

const SECTION_ROLES: Partial<
  Record<AdminSection, readonly ("admin" | "super_admin" | "regulatory_officer" | "dpo")[]>
> = {
  regulatory: ["admin", "super_admin", "regulatory_officer"],
  privacy: ["admin", "super_admin", "dpo"],
};

/** Page-level guard for a deep-linked administration section. */
export async function requireAdminPage(section: AdminSection) {
  const roles = SECTION_ROLES[section] ?? (["admin", "super_admin"] as const);
  const staff = await requireScreen([...roles]);
  const isAdmin = staff.scopes.some(
    (scope) =>
      scope.facilityId === staff.facilityId &&
      (scope.role === "admin" || scope.role === "super_admin"),
  );
  const granted = await getAdminSections(staff.user.id, staff.facilityId);
  const sections = isAdmin
    ? granted
    : granted.filter((grant) => grant === "regulatory" || grant === "privacy");
  if (!sections.includes(section)) redirect("/forbidden");
  return { staff, sections };
}
