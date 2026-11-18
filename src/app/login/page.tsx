import { redirect } from "next/navigation";

import { LoginForm } from "@/components/auth/login-form";
import { getSessionContext } from "@/server/auth/guards";

export default async function LoginPage() {
  const context = await getSessionContext();
  if (context) redirect("/");

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
