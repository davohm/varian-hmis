import { RevenueWorkspace } from "@/components/revenue/revenue-workspace";
import { Screen } from "@/components/shell/screen";
import { REVENUE_READ_ROLES, REVENUE_WRITE_ROLES } from "@/lib/navigation";
import { requireScreen } from "@/server/auth/guards";

export default async function RevenuePage() {
  const staff = await requireScreen(REVENUE_READ_ROLES);
  const canWrite = staff.role ? REVENUE_WRITE_ROLES.includes(staff.role) : false;

  return (
    <Screen
      title="Revenue cycle"
      description="Maintain payers, approve authorisations and work claims through to payment."
      testId="screen-revenue"
      role={staff.role}
    >
      <RevenueWorkspace canWrite={canWrite} />
    </Screen>
  );
}
