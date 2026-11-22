import { ProcurementWorkspace } from "@/components/procurement/procurement-workspace";
import { Screen } from "@/components/shell/screen";
import { PROCUREMENT_READ_ROLES, PROCUREMENT_WRITE_ROLES } from "@/lib/navigation";
import { requireScreen } from "@/server/auth/guards";

export default async function ProcurementPage() {
  const staff = await requireScreen(PROCUREMENT_READ_ROLES);
  const canWrite = staff.role ? PROCUREMENT_WRITE_ROLES.includes(staff.role) : false;

  return (
    <Screen
      title="Procurement"
      description="Raise requisitions, compare quotes, receive goods and match supplier invoices."
      testId="screen-procurement"
      role={staff.role}
    >
      <ProcurementWorkspace canWrite={canWrite} />
    </Screen>
  );
}
