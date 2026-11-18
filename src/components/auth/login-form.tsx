"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
        setError("The email or password is incorrect.");
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
    <Card className="w-full max-w-md">
      <CardHeader className="border-b border-border">
        <div className="font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
          Secure staff access
        </div>
        <CardTitle className="mt-2 text-xl">Sign in to Varian HMIS</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="email">Work email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
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
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
          <Button type="submit" size="lg" className="w-full" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
