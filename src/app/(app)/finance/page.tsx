import { FinanceWorkspace } from "@/components/finance/finance-workspace";
import { Screen } from "@/components/shell/screen";
import { FINANCE_READ_ROLES, FINANCE_WRITE_ROLES } from "@/lib/navigation";
import { requireScreen } from "@/server/auth/guards";

export default async function FinancePage() {
  const staff = await requireScreen(FINANCE_READ_ROLES);
  const canWrite = staff.role ? FINANCE_WRITE_ROLES.includes(staff.role) : false;

  return (
    <Screen
      title="Finance"
      description="Post journals, prove the ledger, close periods and reconcile bank accounts."
      testId="screen-finance"
      role={staff.role}
    >
      <FinanceWorkspace canWrite={canWrite} />
    </Screen>
  );
}
