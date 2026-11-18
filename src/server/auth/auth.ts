import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins";

import { db } from "@/server/db/client";

import { recordAuthAudit } from "./audit";

export const auth = betterAuth({
  appName: "Varian HMIS",
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  trustedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 10,
  },
  // Better Auth applies a 3-per-10s limit to every /sign-in path and enables
  // the limiter only in production. The Playwright suite signs in as six roles
  // in quick succession from one address, so its server sets AUTH_RATE_LIMIT=off.
  // Every other environment keeps the production default.
  rateLimit: {
    enabled: process.env.AUTH_RATE_LIMIT === "off" ? false : process.env.NODE_ENV === "production",
  },
  session: {
    expiresIn: 60 * 60 * 12,
    updateAge: 60 * 60,
    cookieCache: {
      enabled: true,
      maxAge: 300,
    },
  },
  plugins: [admin(), nextCookies()],
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      try {
        if (ctx.path === "/sign-in/email") {
          const body = (ctx.body ?? {}) as { email?: string };
          const email = typeof body.email === "string" ? body.email : null;
          const returned = ctx.context.returned;

          if (isAPIError(returned)) {
            await recordAuthAudit({
              action: "auth.sign_in.failed",
              email,
              headers: ctx.headers,
            });
            return;
          }

          const signedInUser = (returned as { user?: { id?: string; email?: string } } | null)?.user;
          const userId = signedInUser?.id ?? ctx.context.session?.user?.id ?? null;
          if (userId) {
            await recordAuthAudit({
              action: "auth.sign_in",
              userId,
              email: signedInUser?.email ?? email,
              headers: ctx.headers,
            });
          }
          return;
        }

        if (ctx.path === "/sign-out") {
          const userId = ctx.context.session?.user?.id;
          if (userId) {
            await recordAuthAudit({
              action: "auth.sign_out",
              userId,
              email: ctx.context.session?.user?.email ?? null,
              headers: ctx.headers,
            });
          }
        }
      } catch (error) {
        ctx.context.logger?.error?.("Failed to write authentication audit event", error);
      }
    }),
  },
});
