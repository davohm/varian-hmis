import { HrWorkspace } from "@/components/hr/hr-workspace";
import { Screen } from "@/components/shell/screen";
import { HR_READ_ROLES, HR_WRITE_ROLES } from "@/lib/navigation";
import { requireScreen } from "@/server/auth/guards";

export default async function HrPage() {
  const staff = await requireScreen(HR_READ_ROLES);
  const canWrite = staff.role ? HR_WRITE_ROLES.includes(staff.role) : false;

  return (
    <Screen
      title="Human resources"
      description="Maintain personnel records, contracts, rota, attendance and leave."
      testId="screen-hr"
      role={staff.role}
    >
      <HrWorkspace canWrite={canWrite} />
    </Screen>
  );
}
