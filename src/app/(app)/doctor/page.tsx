import { DoctorWorkspace } from "@/components/doctor/doctor-workspace";
import { Screen } from "@/components/shell/screen";
import { requireScreen } from "@/server/auth/guards";

export default async function DoctorPage() {
  const staff = await requireScreen(["doctor"]);
  return (
    <Screen
      title="Consultation"
      description="Review the pinned patient banner, record SOAP notes, order tests and prescribe."
      testId="screen-doctor"
      role={staff.role}
    >
      <DoctorWorkspace />
    </Screen>
  );
}
