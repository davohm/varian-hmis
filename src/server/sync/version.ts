/**
 * Bump this when the sync wire contract changes in a way older branch builds
 * cannot safely interpret. Both batch and pull requests carry it as a header,
 * and pull responses echo it so a branch can verify the cloud it is talking to.
 */
export const SYNC_SCHEMA_VERSION = 2;
export const SYNC_SCHEMA_HEADER = "x-sync-schema-version";

export class SyncSchemaError extends Error {
  readonly status = 426;

  constructor(expected: number, received: string | null) {
    super(`Sync schema version mismatch: branch expects ${expected}, cloud reported ${received ?? "none"}`);
    this.name = "SyncSchemaError";
  }
}

export function assertSyncSchemaVersion(
  header: string | null | undefined,
  expected = SYNC_SCHEMA_VERSION,
): void {
  if (header === null || header === undefined || header.trim() === "") {
    throw new SyncSchemaError(expected, null);
  }
  const received = Number(header);
  if (!Number.isInteger(received) || received !== expected) {
    throw new SyncSchemaError(expected, header);
  }
}

export function checkAdvertisedSyncSchemaVersion(header: string | null | undefined): void {
  if (header === null || header === undefined || header.trim() === "") return;
  const received = Number(header);
  if (Number.isInteger(received) && received !== SYNC_SCHEMA_VERSION) {
    throw new SyncSchemaError(SYNC_SCHEMA_VERSION, header);
  }
}
