import { redirect } from "next/navigation";

import { AdminSectionPage } from "@/components/admin/admin-section-page";
import { ADMIN_SECTION_META } from "@/lib/admin-sections";
import { getAdminSections } from "@/server/auth/admin-access";
import { requireScreen } from "@/server/auth/guards";

export const dynamic = "force-dynamic";

/** /admin stays the default landing page for administrators with full access. */
export default async function AdminPage() {
  const staff = await requireScreen(["admin"]);
  const sections = await getAdminSections(staff.user.id, staff.facilityId);
  if (!sections.includes("setup")) {
    const first = sections[0] ?? "setup";
    redirect(ADMIN_SECTION_META[first].href);
  }

  return <AdminSectionPage section="setup" />;
}
