import { ReportsWorkspace } from "@/components/reports/reports-workspace";
import { Screen } from "@/components/shell/screen";
import { REPORT_READ_ROLES, REPORT_WRITE_ROLES } from "@/lib/navigation";
import { requireScreen } from "@/server/auth/guards";

export default async function ReportsPage() {
  const staff = await requireScreen(REPORT_READ_ROLES);
  const canWrite = staff.role ? REPORT_WRITE_ROLES.includes(staff.role) : false;

  return (
    <Screen
      title="Reports"
      description="Generate ERP reports, review approval queues, drill into source transactions and export evidence."
      testId="screen-reports"
      role={staff.role}
    >
      <ReportsWorkspace canWrite={canWrite} />
    </Screen>
  );
}
