import { Screen } from "@/components/shell/screen";
import { requireScreen } from "@/server/auth/guards";

export default async function LabPage() {
  await requireScreen(["lab_tech"]);
  return (
    <Screen
      title="Laboratory"
      description="Collect samples, enter parameters and verify results for the care team."
      testId="screen-lab"
    />
  );
}
