import { PatientRegistry } from "@/components/reception/patient-registry";
import { Screen } from "@/components/shell/screen";
import { requireScreen } from "@/server/auth/guards";
import { db } from "@/server/db/client";
import { listPatients } from "@/server/queries/patients";

const INITIAL_PAGE_SIZE = 25;

export default async function PatientRegistryPage() {
  const staff = await requireScreen(["receptionist"]);

  // The first page is rendered on the server so the registry never flashes an
  // empty skeleton on arrival. Later pages and searches go through the API.
  const { rows, total } = await listPatients(
    db,
    staff.facilityId,
    "",
    INITIAL_PAGE_SIZE,
    0,
  );

  return (
    <Screen
      title="Patient registry"
      description="Search the facility's records and confirm a patient's identity before a visit."
      testId="screen-reception-patients"
      role={staff.role}
      eyebrow="Patients · Registry"
    >
      <PatientRegistry
        initialPatients={rows}
        initialTotal={total}
        initialPageSize={INITIAL_PAGE_SIZE}
      />
    </Screen>
  );
}
