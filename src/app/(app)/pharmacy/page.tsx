import { Screen } from "@/components/shell/screen";
import { requireScreen } from "@/server/auth/guards";

export default async function PharmacyPage() {
  await requireScreen(["pharmacist"]);
  return (
    <Screen
      title="Pharmacy"
      description="Dispense from FEFO batches and manage stock movements."
      testId="screen-pharmacy"
    />
  );
}
