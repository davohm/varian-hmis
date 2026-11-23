import { ShaWorkspace } from "@/components/sha/sha-workspace";
import { Screen } from "@/components/shell/screen";
import {
  SHA_APPROVAL_ROLES,
  SHA_CLAIM_ROLES,
  SHA_CO_PAY_ROLES,
  SHA_ELIGIBILITY_ROLES,
  SHA_FINANCE_ROLES,
  SHA_READ_ROLES,
  SHA_SETUP_ROLES,
} from "@/lib/navigation";
import { requireScreen } from "@/server/auth/guards";

export default async function ShaRevenuePage() {
  const staff = await requireScreen(SHA_READ_ROLES);
  const has = (roles: string[]) => Boolean(staff.role && roles.includes(staff.role));

  return (
    <Screen
      title="SHA / SHIF revenue cycle"
      description="Maintain empanelment and benefits, verify eligibility, work claims and reconcile SHA payments."
      testId="screen-sha"
      role={staff.role}
    >
      <ShaWorkspace
        capabilities={{
          canSetup: has(SHA_SETUP_ROLES),
          canVerifyEligibility: has(SHA_ELIGIBILITY_ROLES),
          canRecordCoPay: has(SHA_CO_PAY_ROLES),
          canApprove: has(SHA_APPROVAL_ROLES),
          canClaim: has(SHA_CLAIM_ROLES),
          canFinance: has(SHA_FINANCE_ROLES),
        }}
      />
    </Screen>
  );
}
