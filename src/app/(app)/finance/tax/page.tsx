import { TaxWorkspace } from "@/components/finance/tax-workspace";
import { Screen } from "@/components/shell/screen";
import { FINANCE_READ_ROLES, FINANCE_WRITE_ROLES } from "@/lib/navigation";
import { requireScreen } from "@/server/auth/guards";

export const dynamic = "force-dynamic";

export default async function TaxPage() {
  const staff = await requireScreen(FINANCE_READ_ROLES);
  const canWrite = staff.role ? FINANCE_WRITE_ROLES.includes(staff.role) : false;

  return (
    <Screen
      title="KRA eTIMS"
      description="Finalise invoices into KRA tax documents, track signatures, retry failures and print compliant copies."
      testId="screen-tax"
      role={staff.role}
    >
      <TaxWorkspace canWrite={canWrite} />
    </Screen>
  );
}
