import { sql } from "drizzle-orm";
import { Client } from "pg";

import { DATABASE_URL } from "./env";
import type { DbExecutor } from "./numbering";

export const EVENT_CHANNEL = "varian_events";

/** Every event carries the facility it belongs to so stations can filter locally. */
export interface DomainEvent {
  type: string;
  facilityId: string;
  [key: string]: unknown;
}

/** Publish from inside the command transaction: NOTIFY is delivered on commit. */
export async function publishEvent(db: DbExecutor, event: DomainEvent): Promise<void> {
  await db.execute(sql`SELECT pg_notify(${EVENT_CHANNEL}, ${JSON.stringify(event)})`);
}

export interface EventSubscription {
  listen(): Promise<void>;
  close(): Promise<void>;
}

/**
 * LISTEN needs a dedicated connection: a pooled client cannot hold a listening
 * session while the rest of the app borrows connections from the same pool.
 */
export function createEventSubscription(
  onEvent: (event: DomainEvent) => void,
  onError?: (error: Error) => void,
): EventSubscription {
  const client = new Client({ connectionString: DATABASE_URL });
  let listening = false;
  let closed = false;

  client.on("notification", (message) => {
    if (message.channel !== EVENT_CHANNEL || !message.payload) return;
    try {
      const event = JSON.parse(message.payload) as DomainEvent;
      if (event && typeof event.facilityId === "string" && typeof event.type === "string") {
        onEvent(event);
      }
    } catch {
      // Ignore malformed payloads from other publishers.
    }
  });

  client.on("error", (error) => {
    if (!closed) onError?.(error);
  });

  return {
    async listen() {
      await client.connect();
      await client.query(`LISTEN ${EVENT_CHANNEL}`);
      listening = true;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (listening) {
        try {
          await client.query(`UNLISTEN ${EVENT_CHANNEL}`);
        } catch {
          // Connection may already be gone.
        }
      }
      try {
        await client.end();
      } catch {
        // Connection may already be gone.
      }
    },
  };
}
