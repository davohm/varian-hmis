import { TriageWorkspace } from "@/components/triage/triage-workspace";
import { Screen } from "@/components/shell/screen";
import { requireScreen } from "@/server/auth/guards";

export default async function TriagePage() {
  const staff = await requireScreen(["triage_nurse"]);
  return (
    <Screen
      title="Triage"
      description="Record vitals, assign a triage category and route patients to a doctor."
      testId="screen-triage"
      role={staff.role}
    >
      <TriageWorkspace />
    </Screen>
  );
}
