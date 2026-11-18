import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { DATABASE_URL } from "../env";
import * as schema from "./schema";

export function createDatabase(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 10_000,
  });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

const globalForDb = globalThis as unknown as {
  varianPool?: ReturnType<typeof createDatabase>["pool"];
  varianDb?: ReturnType<typeof createDatabase>["db"];
};

export const pool = globalForDb.varianPool ?? createDatabase(DATABASE_URL).pool;
export const db = globalForDb.varianDb ?? drizzle(pool, { schema });

if (process.env.NODE_ENV !== "production") {
  globalForDb.varianPool = pool;
  globalForDb.varianDb = db;
}
