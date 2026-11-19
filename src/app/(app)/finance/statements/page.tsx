import { FinancialStatementsWorkspace } from "@/components/finance/financial-statements-workspace";
import { Screen } from "@/components/shell/screen";
import { FINANCE_READ_ROLES } from "@/lib/navigation";
import { requireScreen } from "@/server/auth/guards";

export const dynamic = "force-dynamic";

export default async function StatementsPage() {
  const staff = await requireScreen(FINANCE_READ_ROLES);

  return (
    <Screen
      title="Financial statements"
      description="Report the posted ledger as a balance sheet, income statement and direct cash flow."
      testId="screen-statements"
      role={staff.role}
    >
      <FinancialStatementsWorkspace />
    </Screen>
  );
}
