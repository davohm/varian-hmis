import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { RegistrationForm } from "@/components/reception/registration-form";
import { Screen } from "@/components/shell/screen";
import { Button } from "@/components/ui/button";
import { requireScreen } from "@/server/auth/guards";

export default async function RegisterPatientPage() {
  const staff = await requireScreen(["receptionist"]);
  return (
    <Screen
      title="Register patient"
      description="Create the medical record, capture consent, and decide whether to start the visit now."
      testId="screen-reception-register"
      role={staff.role}
      eyebrow="Patients · New record"
      actions={
        <Button variant="outline" nativeButton={false} render={<Link href="/reception" />}>
          <ArrowLeft aria-hidden="true" />
          Back to front desk
        </Button>
      }
    >
      <RegistrationForm />
    </Screen>
  );
}
