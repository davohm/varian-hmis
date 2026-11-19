import { redirect } from "next/navigation";

import type { AdminSection } from "@/lib/admin-sections";

import { getAdminSections } from "./admin-access";
import { requireScreen } from "./guards";

/** Page-level guard for a deep-linked administration section. */
export async function requireAdminPage(section: AdminSection) {
  const roles = section === "regulatory" ? (["admin", "regulatory_officer"] as const) : (["admin"] as const);
  const staff = await requireScreen([...roles]);
  const isAdmin = staff.scopes.some(
    (scope) => scope.facilityId === staff.facilityId && scope.role === "admin",
  );
  const granted = await getAdminSections(staff.user.id, staff.facilityId);
  const sections = isAdmin ? granted : granted.filter((grant) => grant === "regulatory");
  if (!sections.includes(section)) redirect("/forbidden");
  return { staff, sections };
}
