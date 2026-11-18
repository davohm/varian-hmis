import { config } from "dotenv";

// Next.js loads .env.local itself; these calls make the same variables available
// to tsx/vitest/drizzle-kit scripts.
config({ path: ".env.local" });
config({ path: ".env" });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
}

export const DATABASE_URL = process.env.DATABASE_URL;

export type AppMode = "cloud" | "clinic";
const rawMode = (process.env.APP_MODE ?? "cloud").toLowerCase();
if (rawMode !== "cloud" && rawMode !== "clinic") {
  throw new Error(`APP_MODE must be "cloud" or "clinic", received "${rawMode}".`);
}
export const APP_MODE: AppMode = rawMode;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Expected a boolean for ${normalized}, received "${value}".`);
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export const SYNC_ENABLED = parseBoolean(
  process.env.SYNC_ENABLED,
  APP_MODE === "clinic",
);
export const CLOUD_URL = process.env.CLOUD_URL?.replace(/\/+$/, "") ?? null;
export const FACILITY_ID = process.env.FACILITY_ID ?? null;
export const FACILITY_SYNC_TOKEN = process.env.FACILITY_SYNC_TOKEN ?? null;
export const FACILITY_DEVICE_KEY = process.env.FACILITY_DEVICE_KEY?.trim() || "clinic-server";

export const SYNC_BATCH_SIZE = parsePositiveInteger(process.env.SYNC_BATCH_SIZE, 100, "SYNC_BATCH_SIZE");
export const SYNC_POLL_MS = parsePositiveInteger(process.env.SYNC_POLL_MS, 10_000, "SYNC_POLL_MS");
export const SYNC_PULL_MS = parsePositiveInteger(process.env.SYNC_PULL_MS, 300_000, "SYNC_PULL_MS");
export const SYNC_TIMEOUT_MS = parsePositiveInteger(process.env.SYNC_TIMEOUT_MS, 10_000, "SYNC_TIMEOUT_MS");

if (APP_MODE === "clinic" && SYNC_ENABLED) {
  const missing: string[] = [];
  if (!CLOUD_URL || !/^https?:\/\//i.test(CLOUD_URL)) missing.push("CLOUD_URL");
  if (!FACILITY_ID) missing.push("FACILITY_ID");
  if (!FACILITY_SYNC_TOKEN) missing.push("FACILITY_SYNC_TOKEN");
  if (missing.length > 0) {
    throw new Error(
      `Clinic sync is enabled but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set.`,
    );
  }
}
