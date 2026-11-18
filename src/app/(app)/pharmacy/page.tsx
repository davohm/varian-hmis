import { PharmacyWorkspace } from "@/components/pharmacy/pharmacy-workspace";
import { Screen } from "@/components/shell/screen";
import { requireScreen } from "@/server/auth/guards";

export default async function PharmacyPage() {
  const staff = await requireScreen(["pharmacist"]);
  return (
    <Screen
      title="Pharmacy"
      description="Dispense from FEFO batches, print labels and manage stock movements."
      testId="screen-pharmacy"
      role={staff.role}
    >
      <PharmacyWorkspace />
    </Screen>
  );
}
