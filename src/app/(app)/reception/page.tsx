import { Screen } from "@/components/shell/screen";
import { requireScreen } from "@/server/auth/guards";

export default async function ReceptionPage() {
  const staff = await requireScreen(["receptionist"]);
  return (
    <Screen
      title="Reception"
      description="Register patients, allocate MRNs and manage the visit queue."
      testId="screen-reception"
      role={staff.role}
    />
  );
}
