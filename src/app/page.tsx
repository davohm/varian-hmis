import { redirect } from "next/navigation";

import { ROLE_HOME } from "@/lib/navigation";
import { getSessionContext } from "@/server/auth/guards";

export default async function Home() {
  const context = await getSessionContext();
  if (!context) redirect("/login");

  const role = context.scopes.find((scope) => scope.facilityId === context.activeFacilityId)?.role;
  redirect(role ? ROLE_HOME[role] : "/forbidden");
}
