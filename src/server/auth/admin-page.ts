import { redirect } from "next/navigation";

import type { AdminSection } from "@/lib/admin-sections";

import { getAdminSections } from "./admin-access";
import { requireScreen } from "./guards";

/** Page-level guard for a deep-linked administration section. */
export async function requireAdminPage(section: AdminSection) {
  const staff = await requireScreen(["admin"]);
  const sections = await getAdminSections(staff.user.id, staff.facilityId);
  if (!sections.includes(section)) redirect("/forbidden");
  return { staff, sections };
}
