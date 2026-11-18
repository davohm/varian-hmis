"use client";

import { ShieldPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const result = await authClient.signIn.email({ email, password });
      if (result.error) {
        // A throttled request must not be reported as a wrong password, or the
        // user keeps retrying and stays locked out.
        setError(
          result.error.status === 429
            ? "Too many sign-in attempts. Wait a few seconds and try again."
            : "The email or password is incorrect.",
        );
        return;
      }

      const contextResponse = await fetch("/api/session/context");
      if (!contextResponse.ok) throw new Error("Could not load staff scope");
      const context = (await contextResponse.json()) as {
        facilities: Array<{ id: string; branches: Array<{ id: string }> }>;
      };
      const facility = context.facilities[0];
      if (!facility) throw new Error("No facility is assigned to this account");

      const activateResponse = await fetch("/api/session/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          facilityId: facility.id,
          branchId: facility.branches[0]?.id ?? null,
        }),
      });
      if (!activateResponse.ok) throw new Error("Could not activate the facility");

      toast.success("Signed in");
      window.location.assign("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign-in failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="w-full rounded-lg border border-border bg-card shadow-sm">
      <div className="border-b border-border px-8 pt-8 pb-6">
        <span className="grid size-11 place-items-center rounded-md bg-primary">
          <ShieldPlus className="size-6 text-primary-foreground" aria-hidden="true" />
        </span>
        <h1 className="mt-4 text-lg font-semibold text-primary">Sign in to your account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Use the staff credentials issued by your facility administrator.
        </p>
      </div>

      <div className="px-8 py-6">
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="email">Work email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              placeholder="name@fam.test"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "login-error" : undefined}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "login-error" : undefined}
            />
          </div>
          {error ? (
            <p
              id="login-error"
              role="alert"
              data-testid="login-error"
              className="rounded-md border border-destructive/30 bg-[var(--status-critical-background)] px-3 py-2 text-sm text-[var(--status-critical-foreground)]"
            >
              {error}
            </p>
          ) : null}
          <Button type="submit" size="lg" className="w-full" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>

      <div className="rounded-b-lg border-t border-border bg-secondary px-8 py-3">
        <p className="text-xs leading-5 text-secondary-foreground">
          Problems signing in? Contact your facility administrator — access is limited to
          provisioned staff accounts.
        </p>
      </div>
    </div>
  );
}
