import { redirect } from "next/navigation";

import { SetupWizard } from "@/components/setup/setup-wizard";
import { getFirstRunStatus } from "@/server/commands/bootstrap";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const status = await getFirstRunStatus();
  if (!status.required) redirect("/login");

  return (
    <main className="min-h-screen bg-background px-6 py-10">
      <div className="mx-auto w-full max-w-4xl">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold text-primary">Varian HMIS</div>
            <div className="font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
              Initial Configuration
            </div>
          </div>
          <div className="font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
            Phase 0 · First-run setup
          </div>
        </div>
        <SetupWizard />
      </div>
    </main>
  );
}
