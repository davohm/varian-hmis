import { BudgetsWorkspace } from "@/components/finance/budgets-workspace";
import { Screen } from "@/components/shell/screen";
import { FINANCE_READ_ROLES, FINANCE_WRITE_ROLES } from "@/lib/navigation";
import { requireScreen } from "@/server/auth/guards";

export const dynamic = "force-dynamic";

export default async function BudgetsPage() {
  const staff = await requireScreen(FINANCE_READ_ROLES);
  const canWrite = staff.role ? FINANCE_WRITE_ROLES.includes(staff.role) : false;

  return (
    <Screen
      title="Budgets & controls"
      description="Plan expense budgets, route them through approval and enforce them at posting time."
      testId="screen-budgets"
      role={staff.role}
    >
      <BudgetsWorkspace canWrite={canWrite} />
    </Screen>
  );
}
