# 04 — Auth & RBAC (Better Auth)

## Setup — `src/server/auth/auth.ts`
```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/server/db/client";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 10 },
  session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60, cookieCache: { enabled: true, maxAge: 300 } },
  plugins: [admin(), nextCookies()],
});
```
- Route handler `src/app/api/auth/[...all]/route.ts` → `toNextJsHandler(auth)`.
- Client `src/lib/auth-client.ts` → `createAuthClient()`.
- Generate Better Auth tables with `npx @better-auth/cli generate` into the Drizzle schema.
- Public sign-up is disabled; admins create staff via the admin plugin (`auth.api.createUser`).
- Optional username login plugin for staff numbers.

## Roles
`receptionist, triage_nurse, doctor, lab_tech, pharmacist, cashier, admin` stored in `staff_role_scopes` with facility (and optional branch) scope.

## Guards — `src/server/auth/guards.ts`
```ts
export async function requireStaff(roles: Role[], facilityId: string) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  const scopes = await getScopes(session.user.id); // cached per request
  const ok = scopes.some(s => s.facilityId === facilityId && (roles.includes(s.role) || s.role === "admin"));
  if (!ok) throw new ForbiddenError();
  return { user: session.user, scopes };
}
```
- Every Server Action and Route Handler calls a guard first; layouts call it to hide screens.
- `middleware.ts` only checks session cookie presence and redirects to `/login` (no DB calls).
- Active facility stored in a cookie, validated against scopes on every request.

## Offline sign-in (clinic mode)
- Clinic server holds its own copy of `user`, `account` (password hashes), and `staff_role_scopes`, pulled from the cloud (see 05).
- Staff sign in against the clinic server; works with no internet.
- Password changes and deactivations made in the cloud apply at the next pull (≤ 5 min when online). Admins can also deactivate locally.

## Audit
Sign-in, sign-out, failed sign-in, role change and every command write to `audit_log`.
