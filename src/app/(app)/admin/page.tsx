import { AdminWorkspace } from "@/components/admin/admin-workspace";
import { Screen } from "@/components/shell/screen";
import { requireScreen } from "@/server/auth/guards";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const staff = await requireScreen(["admin"]);

  return (
    <Screen
      title="Administration"
      description="Staff, facilities, catalogues, prices and audit activity."
      testId="screen-admin"
      role={staff.role}
    >
      <AdminWorkspace />
    </Screen>
  );
}
