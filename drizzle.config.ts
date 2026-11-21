import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".env.local" });
config({ path: ".env" });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
}

// Migrations must run over a direct/unpooled connection on hosted Postgres.
// Runtime keeps using DATABASE_URL (the pooled Neon URL in production).
const MIGRATION_DATABASE_URL = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;

export default defineConfig({
  schema: "./src/server/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: MIGRATION_DATABASE_URL,
  },
  strict: true,
  verbose: true,
});
