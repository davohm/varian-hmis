import type { AdminSection } from "@/lib/admin-sections";
import { ADMIN_SECTION_META } from "@/lib/admin-sections";
import { Screen } from "@/components/shell/screen";
import { requireAdminPage } from "@/server/auth/admin-page";

import { AdminWorkspace } from "./admin-workspace";

export async function AdminSectionPage({ section }: { section: AdminSection }) {
  const { staff } = await requireAdminPage(section);
  const meta = ADMIN_SECTION_META[section];

  return (
    <Screen
      title={section === "setup" ? "Administration" : meta.label}
      description={meta.description}
      testId="screen-admin"
      role={staff.role}
    >
      <AdminWorkspace section={section} />
    </Screen>
  );
}
