import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { APP_MODE, DATABASE_URL } from "../env";
import * as schema from "./schema";

export type AppDatabase = ReturnType<typeof drizzle<typeof schema>>;
export type NodeRole = "cloud" | "clinic";

/**
 * The node role is advertised to Postgres so capture_change() can suppress
 * outbox rows for direct cloud writes. It is a connection-level identity, not
 * the facility's write authority, which lets a clinic-mode test database still
 * capture rows even when its local facility is flagged cloud for test setup.
 *
 * Neon's pooled endpoint only accepts a small allow-list of startup parameters.
 * `application_name` is on that list, so the role is advertised there instead
 * of through a custom `options -c varian.node_role=...` startup parameter.
 */
export function createDatabase(
  connectionString: string,
  nodeRole: NodeRole = APP_MODE,
): {
  pool: Pool;
  db: AppDatabase;
} {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 10_000,
    application_name: `varian-${nodeRole}`,
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
