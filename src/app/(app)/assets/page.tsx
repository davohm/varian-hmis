import { AssetsWorkspace } from "@/components/assets/assets-workspace";
import { Screen } from "@/components/shell/screen";
import { ASSET_READ_ROLES, ASSET_WRITE_ROLES } from "@/lib/navigation";
import { requireScreen } from "@/server/auth/guards";

export default async function AssetsPage() {
  const staff = await requireScreen(ASSET_READ_ROLES);
  const canWrite = staff.role ? ASSET_WRITE_ROLES.includes(staff.role) : false;

  return (
    <Screen
      title="Assets"
      description="Register assets, calculate depreciation, track maintenance and approve changes with ledger postings."
      testId="screen-assets"
      role={staff.role}
    >
      <AssetsWorkspace canWrite={canWrite} />
    </Screen>
  );
}
