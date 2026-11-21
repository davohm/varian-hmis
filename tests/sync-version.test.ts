import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { POST as batchPost } from "../src/app/api/sync/batch/route";
import { GET as pullGet } from "../src/app/api/sync/pull/route";
import {
  assertSyncSchemaVersion,
  checkAdvertisedSyncSchemaVersion,
  SyncSchemaError,
  SYNC_SCHEMA_HEADER,
  SYNC_SCHEMA_VERSION,
} from "../src/server/sync/version";

describe("sync schema handshake", () => {
  it("accepts the current version and rejects missing or stale versions", () => {
    expect(() => assertSyncSchemaVersion(String(SYNC_SCHEMA_VERSION))).not.toThrow();
    expect(() => assertSyncSchemaVersion(` ${SYNC_SCHEMA_VERSION} `)).not.toThrow();
    expect(() => assertSyncSchemaVersion(null)).toThrow(SyncSchemaError);
    expect(() => assertSyncSchemaVersion("")).toThrow(/mismatch/);
    expect(() => assertSyncSchemaVersion(String(SYNC_SCHEMA_VERSION - 1))).toThrow(/mismatch/);
    expect(new SyncSchemaError(SYNC_SCHEMA_VERSION, null).status).toBe(426);
  });

  it("checks an advertised cloud version only when one is present", () => {
    expect(() => checkAdvertisedSyncSchemaVersion(null)).not.toThrow();
    expect(() => checkAdvertisedSyncSchemaVersion(String(SYNC_SCHEMA_VERSION))).not.toThrow();
    expect(() => checkAdvertisedSyncSchemaVersion(String(SYNC_SCHEMA_VERSION + 1))).toThrow(
      SyncSchemaError,
    );
  });

  it("returns 426 before touching the sync body when the header is absent", async () => {
    const batch = await batchPost(new NextRequest("http://cloud.test/api/sync/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ facilityId: "not-a-uuid" }),
    }));
    expect(batch.status).toBe(426);
    expect(await batch.json()).toMatchObject({ error: expect.stringContaining("schema version mismatch") });

    const pull = await pullGet(new NextRequest("http://cloud.test/api/sync/pull"));
    expect(pull.status).toBe(426);
    expect(await pull.json()).toMatchObject({ error: expect.stringContaining("schema version mismatch") });
  });

  it("rejects a stale version with 426", async () => {
    const stale = String(SYNC_SCHEMA_VERSION - 1);
    const batch = await batchPost(new NextRequest("http://cloud.test/api/sync/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SYNC_SCHEMA_HEADER]: stale,
      },
      body: "{}",
    }));
    expect(batch.status).toBe(426);
    expect(await batch.json()).toMatchObject({ error: expect.stringContaining(stale) });
  });
});
