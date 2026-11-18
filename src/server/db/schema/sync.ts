import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { newId } from "../../../lib/uuid";
import { facilities } from "./tenancy";

export const syncOutboxStatusEnum = pgEnum("sync_outbox_status", [
  "pending",
  "synced",
  "failed",
]);

export const syncOutbox = pgTable(
  "sync_outbox",
  {
    outboxId: uuid("outbox_id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    tableName: text("table_name").notNull(),
    recordId: text("record_id").notNull(),
    operation: varchar("operation", { length: 16 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: syncOutboxStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
  },
  (table) => ({
    pendingIdx: index("sync_outbox_pending_idx").on(
      table.status,
      table.nextAttemptAt,
      table.createdAt,
      table.outboxId,
    ),
    facilityIdx: index("sync_outbox_facility_idx").on(table.facilityId, table.createdAt),
    recordIdx: index("sync_outbox_record_idx").on(table.tableName, table.recordId),
  }),
);

export const syncReceived = pgTable(
  "sync_received",
  {
    outboxId: uuid("outbox_id").primaryKey(),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    tableName: text("table_name").notNull(),
    recordId: text("record_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    facilityIdx: index("sync_received_facility_idx").on(table.facilityId, table.receivedAt),
  }),
);

export const syncState = pgTable("sync_state", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const facilitySyncTokens = pgTable(
  "facility_sync_tokens",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    deviceKey: varchar("device_key", { length: 128 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    facilityDeviceIdx: uniqueIndex("facility_sync_tokens_facility_device_idx").on(
      table.facilityId,
      table.deviceKey,
    ),
  }),
);

export type SyncOutboxRow = typeof syncOutbox.$inferSelect;
export type NewSyncOutboxRow = typeof syncOutbox.$inferInsert;
export type SyncReceivedRow = typeof syncReceived.$inferSelect;
export type SyncStateRow = typeof syncState.$inferSelect;
export type FacilitySyncToken = typeof facilitySyncTokens.$inferSelect;
