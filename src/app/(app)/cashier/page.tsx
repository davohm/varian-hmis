import { CashierWorkspace } from "@/components/cashier/cashier-workspace";
import { Screen } from "@/components/shell/screen";
import { requireScreen } from "@/server/auth/guards";

export default async function CashierPage() {
  const staff = await requireScreen(["cashier"]);
  return (
    <Screen
      title="Cashier"
      description="Bill consultations, record split tenders and print receipts."
      testId="screen-cashier"
      role={staff.role}
    >
      <CashierWorkspace />
    </Screen>
  );
}
