import { QueueTable } from "@/components/reception/queue-table";
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
      <QueueTable department="Triage" testId="triage-live-queue" compact />
      <p className="mt-4 rounded-lg border border-border bg-secondary px-4 py-3 text-sm text-secondary-foreground">
        Vitals and triage categories arrive in the next build stage. The live queue is ready for handoff.
      </p>
    </Screen>
  );
}
