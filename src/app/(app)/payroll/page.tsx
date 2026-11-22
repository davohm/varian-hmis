import { PayrollWorkspace } from "@/components/payroll/payroll-workspace";
import { Screen } from "@/components/shell/screen";
import { PAYROLL_READ_ROLES, PAYROLL_WRITE_ROLES } from "@/lib/navigation";
import { requireScreen } from "@/server/auth/guards";

export default async function PayrollPage() {
  const staff = await requireScreen(PAYROLL_READ_ROLES);
  const canWrite = staff.role ? PAYROLL_WRITE_ROLES.includes(staff.role) : false;

  return (
    <Screen
      title="Payroll"
      description="Prepare, approve and post payroll from admin-entered statutory rates."
      testId="screen-payroll"
      role={staff.role}
    >
      <PayrollWorkspace canWrite={canWrite} />
    </Screen>
  );
}
