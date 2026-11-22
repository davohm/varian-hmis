import { redirect } from "next/navigation";

import { LoginForm } from "@/components/auth/login-form";
import { getFirstRunStatus } from "@/server/commands/bootstrap";
import { getSessionContext } from "@/server/auth/guards";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const context = await getSessionContext();
  if (context) redirect("/");

  const setup = await getFirstRunStatus().catch(() => ({ required: false }));
  if (setup.required) redirect("/setup");

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold text-primary">Varian HMIS</div>
            <div className="font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
              Family Afya Modern Medical Centre
            </div>
          </div>
          <div className="font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
            V1 · Kenya
          </div>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
