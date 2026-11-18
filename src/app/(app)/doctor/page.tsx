import { Screen } from "@/components/shell/screen";
import { requireScreen } from "@/server/auth/guards";

export default async function DoctorPage() {
  await requireScreen(["doctor"]);
  return (
    <Screen
      title="Consultation"
      description="Review the pinned patient banner, record SOAP notes, order tests and prescribe."
      testId="screen-doctor"
    />
  );
}
