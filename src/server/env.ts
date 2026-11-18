import { config } from "dotenv";

// Next.js loads .env.local itself; these calls make the same variables available
// to tsx/vitest/drizzle-kit scripts.
config({ path: ".env.local" });
config({ path: ".env" });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
}

export const DATABASE_URL = process.env.DATABASE_URL;
export const APP_MODE = process.env.APP_MODE ?? "cloud";
