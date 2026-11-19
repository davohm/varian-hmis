import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RETENTION_DAYS,
  assertBackupPlan,
  assertRetentionResult,
  backupFileName,
  buildBackupPlan,
  decodeEncryptionKey,
  formatBackupTimestamp,
  generateEncryptionKey,
  nextBackupFileName,
  normalizeRetentionDays,
  parseBackupFileName,
  redactSecrets,
  selectBackupsForRetention,
  validateBackupConfig,
  validateEncryptionKey,
  validateRestoreList,
} from "../src/server/backups";

const KEY = Buffer.alloc(32, 7).toString("base64");
const DATABASE_URL = "postgresql://varian:s3cr3t@localhost:5432/varian-hmis-db";

function fileName(day: string, time = "00-00-00") {
  return `varian-hmis-${day}T${time}Z.dump.enc`;
}

function utcDay(day: string, time = "12:00:00") {
  return new Date(`${day}T${time}Z`);
}

describe("backup key validation", () => {
  it("accepts a canonical base64 AES-256 key and trims surrounding whitespace", () => {
    expect(validateEncryptionKey(`  ${KEY}\n`)).toBe(KEY);
    expect(decodeEncryptionKey(KEY)).toHaveLength(32);
  });

  it("rejects missing, short and non-base64 keys", () => {
    expect(() => validateEncryptionKey(undefined)).toThrow(/not set/i);
    expect(() => validateEncryptionKey("")).toThrow(/not set/i);
    expect(() => validateEncryptionKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/i);
    expect(() => validateEncryptionKey(`${KEY}!!!`)).toThrow(/base64/i);
  });

  it("never echoes a supplied key in an error message", () => {
    const secret = "SUPER_SECRET_MATERIAL_123";
    try {
      validateEncryptionKey(secret);
      expect.unreachable("expected validation to fail");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("generates keys that pass its own validator", () => {
    const generated = generateEncryptionKey();
    expect(generated).not.toBe(KEY);
    expect(() => validateEncryptionKey(generated)).not.toThrow();
  });
});

describe("backup configuration", () => {
  it("applies defaults and parses flags", () => {
    const config = validateBackupConfig(
      { DATABASE_URL, BACKUP_ENCRYPTION_KEY: KEY },
      ["--dry-run", "--once"],
      "/srv/app",
      "linux",
    );
    expect(config.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(config.dryRun).toBe(true);
    expect(config.once).toBe(true);
    expect(config.backupDir).toBe(join("/srv/app", "backups"));
    expect(config.pgDumpBin).toBe(join("/usr/lib/postgresql/17/bin", "pg_dump"));
    expect(config.pgRestoreBin).toBe(join("/usr/lib/postgresql/17/bin", "pg_restore"));
    expect(config.psqlBin).toBe(join("/usr/lib/postgresql/17/bin", "psql"));
  });

  it("uses the PostgreSQL 17 Windows path and .exe binaries when requested", () => {
    const config = validateBackupConfig(
      { DATABASE_URL, BACKUP_ENCRYPTION_KEY: KEY, BACKUP_RETENTION_DAYS: "30" },
      [],
      "C:\\repo",
      "win32",
    );
    expect(config.dryRun).toBe(false);
    expect(config.retentionDays).toBe(30);
    expect(config.pgDumpBin).toBe(join("C:\\Program Files\\PostgreSQL\\17\\bin", "pg_dump.exe"));
  });

  it("honours binary and directory overrides", () => {
    const config = validateBackupConfig(
      {
        DATABASE_URL,
        BACKUP_ENCRYPTION_KEY: KEY,
        BACKUP_DIR: "/mnt/usb/varian",
        PG_BIN_DIR: "/opt/pg17",
        PG_DUMP_BIN: "/usr/local/bin/pg_dump",
      },
      [],
      "/srv/app",
      "linux",
    );
    expect(config.backupDir).toBe("/mnt/usb/varian");
    expect(config.pgDumpBin).toBe("/usr/local/bin/pg_dump");
    expect(config.pgRestoreBin).toBe(join("/opt/pg17", "pg_restore"));
  });

  it("allows a missing key for dry-run but requires one for a live run", () => {
    expect(() =>
      validateBackupConfig({ DATABASE_URL }, ["--dry-run"]),
    ).not.toThrow();
    expect(validateBackupConfig({ DATABASE_URL }, ["--dry-run"]).encryptionKey).toBeNull();
    expect(() => validateBackupConfig({ DATABASE_URL }, [])).toThrow(
      /BACKUP_ENCRYPTION_KEY is not set/i,
    );
  });

  it("rejects bad database URLs, retention values and unknown flags", () => {
    expect(() => validateBackupConfig({}, [])).toThrow(/DATABASE_URL is not set/i);
    expect(() => validateBackupConfig({ DATABASE_URL: "mysql://localhost/db" }, [])).toThrow(
      /postgres/i,
    );
    expect(() =>
      validateBackupConfig(
        { DATABASE_URL, BACKUP_ENCRYPTION_KEY: KEY, BACKUP_RETENTION_DAYS: "0" },
        [],
      ),
    ).toThrow(/integer between/i);
    expect(() => validateBackupConfig({ DATABASE_URL, BACKUP_ENCRYPTION_KEY: KEY }, ["--wipe"])).toThrow(
      /Unknown backup option/i,
    );
  });

  it("normalises the retention default and rejects out-of-range values", () => {
    expect(normalizeRetentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
    expect(normalizeRetentionDays("")).toBe(DEFAULT_RETENTION_DAYS);
    expect(normalizeRetentionDays("21")).toBe(21);
    expect(() => normalizeRetentionDays("0")).toThrow(/integer between/i);
    expect(() => normalizeRetentionDays(Number.NaN)).toThrow(/integer between/i);
  });

  it("does not leak the database password in configuration errors", () => {
    try {
      validateBackupConfig({ DATABASE_URL: "postgresql://varian:leaky@example/db" }, []);
      expect.unreachable("expected validation to fail");
    } catch (error) {
      expect((error as Error).message).not.toContain("leaky");
    }
  });
});

describe("backup filename and date handling", () => {
  const now = new Date("2026-11-19T23:07:05.456Z");

  it("formats UTC timestamps with filesystem-safe separators", () => {
    expect(formatBackupTimestamp(now)).toBe("2026-11-19T23-07-05Z");
    expect(backupFileName(now)).toBe("varian-hmis-2026-11-19T23-07-05Z.dump.enc");
  });

  it("round-trips a generated filename", () => {
    const parsed = parseBackupFileName(backupFileName(now));
    expect(parsed).not.toBeNull();
    expect(parsed!.day).toBe("2026-11-19");
    expect(parsed!.date.toISOString()).toBe("2026-11-19T23:07:05.000Z");
  });

  it("rejects path traversal, wrong suffixes and impossible dates", () => {
    expect(parseBackupFileName(`../${fileName("2026-11-19")}`)).toBeNull();
    expect(parseBackupFileName("C:\\backups\\varian-hmis-2026-11-19T00-00-00Z.dump.enc")).toBeNull();
    expect(parseBackupFileName("varian-hmis-2026-02-30T00-00-00Z.dump.enc")).toBeNull();
    expect(parseBackupFileName("varian-hmis-2026-11-19T00:00:00Z.dump.enc")).toBeNull();
    expect(parseBackupFileName("varian-hmis-2026-11-19T00-00-00Z.dump")).toBeNull();
    expect(parseBackupFileName("notes.txt")).toBeNull();
    expect(parseBackupFileName(` ${fileName("2026-11-19")}`)).toBeNull();
  });

  it("advances the timestamp when a filename already exists", () => {
    const existing = [backupFileName(now), backupFileName(new Date(now.getTime() + 1000))];
    expect(nextBackupFileName(now, existing)).toBe(
      "varian-hmis-2026-11-19T23-07-07Z.dump.enc",
    );
  });
});

describe("retention selection", () => {
  const now = utcDay("2026-11-19");

  it("keeps the newest 14 days and removes older days", () => {
    const days = Array.from({ length: 20 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 9, 31 + index));
      return date.toISOString().slice(0, 10);
    });
    expect(days[0]).toBe("2026-10-31");
    expect(days[19]).toBe("2026-11-19");

    const result = selectBackupsForRetention(days.map((day) => fileName(day)), now, 14);
    expect(result.keep).toHaveLength(14);
    expect(result.remove).toHaveLength(6);
    expect(result.keep).toContain(fileName("2026-11-19"));
    expect(result.keep).toContain(fileName("2026-11-06"));
    expect(result.remove).toEqual([
      fileName("2026-10-31"),
      fileName("2026-11-01"),
      fileName("2026-11-02"),
      fileName("2026-11-03"),
      fileName("2026-11-04"),
      fileName("2026-11-05"),
    ]);
    expect(() => assertRetentionResult(result, 14)).not.toThrow();
  });

  it("keeps only the newest backup from each retained day", () => {
    const result = selectBackupsForRetention(
      [
        fileName("2026-11-18", "01-00-00"),
        fileName("2026-11-18", "23-00-00"),
        fileName("2026-11-19", "02-00-00"),
      ],
      now,
    );
    expect(result.keep).toEqual([
      fileName("2026-11-18", "23-00-00"),
      fileName("2026-11-19", "02-00-00"),
    ]);
    expect(result.remove).toEqual([fileName("2026-11-18", "01-00-00")]);
  });

  it("ignores malformed and future-dated files instead of deleting them", () => {
    const result = selectBackupsForRetention(
      [fileName("2026-11-18"), fileName("2026-11-20"), "notes.txt", "../escape.dump.enc"],
      now,
      1,
    );
    expect(result.keep).toEqual([fileName("2026-11-18")]);
    expect(result.remove).toEqual([]);
    expect(result.ignored).toEqual([
      "../escape.dump.enc",
      "notes.txt",
      fileName("2026-11-20"),
    ]);
  });

  it("validates retention output before deletion", () => {
    const good = selectBackupsForRetention([fileName("2026-11-18"), fileName("2026-11-19")], now, 1);
    expect(() => assertRetentionResult(good, 1)).not.toThrow();

    expect(() =>
      assertRetentionResult(
        { keep: [fileName("2026-11-19")], remove: [fileName("2026-11-19")], ignored: [] },
        1,
      ),
    ).toThrow(/duplicate/i);
    expect(() =>
      assertRetentionResult(
        { keep: [fileName("2026-11-18"), fileName("2026-11-19")], remove: [], ignored: [] },
        1,
      ),
    ).toThrow(/limit/i);
    expect(() =>
      assertRetentionResult(
        { keep: [fileName("2026-11-19")], remove: ["notes.txt"], ignored: [] },
        1,
      ),
    ).toThrow(/unrecognised/i);
    expect(() =>
      assertRetentionResult(
        {
          keep: [fileName("2026-11-18", "01-00-00"), fileName("2026-11-18", "23-00-00")],
          remove: [],
          ignored: [],
        },
        14,
      ),
    ).toThrow(/one backup per day/i);
  });
});

describe("backup plan and dry-run behaviour", () => {
  const now = utcDay("2026-11-19", "09:00:00");
  const existing = [fileName("2026-11-17"), fileName("2026-11-18")];

  it("reports, but does not perform, writes and prunes in dry-run mode", () => {
    const plan = buildBackupPlan({
      now,
      existingFiles: existing,
      backupDir: "/mnt/usb",
      retentionDays: 1,
      dryRun: true,
    });
    expect(plan.targetFileName).toBe(fileName("2026-11-19", "09-00-00"));
    expect(plan.targetPath).toBe(join("/mnt/usb", "varian-hmis-2026-11-19T09-00-00Z.dump.enc"));
    expect(plan.day).toBe("2026-11-19");
    expect(plan.remove).toEqual([fileName("2026-11-17")]);
    expect(plan.willWrite).toBe(false);
    expect(plan.willPrune).toBe(false);
    expect(plan.steps).toContain("prune:1");
    expect(() => assertBackupPlan(plan)).not.toThrow();
  });

  it("enables writes and pruning for a live run", () => {
    const plan = buildBackupPlan({
      now,
      existingFiles: existing,
      backupDir: "/mnt/usb",
      retentionDays: 1,
      dryRun: false,
    });
    expect(plan.willWrite).toBe(true);
    expect(plan.willPrune).toBe(true);
    expect(() => assertBackupPlan(plan)).not.toThrow();
  });

  it("rejects an inconsistent plan", () => {
    const plan = buildBackupPlan({ now, existingFiles: existing, dryRun: true });
    expect(() => assertBackupPlan({ ...plan, willWrite: true })).toThrow(/Dry-run/i);
    expect(() => assertBackupPlan({ ...plan, remove: [plan.targetFileName] })).toThrow(
      /delete|prune/i,
    );
  });
});

describe("log redaction and restore verification", () => {
  it("removes keys, URLs and password assignments from log lines", () => {
    const message = `connect ${DATABASE_URL} with key ${KEY} password=s3cr3t`;
    const redacted = redactSecrets(message, [DATABASE_URL, KEY, "s3cr3t"]);
    expect(redacted).not.toContain(KEY);
    expect(redacted).not.toContain(DATABASE_URL);
    expect(redacted).not.toContain("s3cr3t");
    expect(redacted).not.toMatch(/postgres(?:ql)?:\/\/[^\s[]+@/);
    expect(redacted).toContain("[REDACTED]");
  });

  it("accepts only a restore listing with a header and TOC entries", () => {
    expect(
      validateRestoreList(
        [
          ";",
          "; Archive created at 2026-11-19 02:00:00 UTC",
          ";     dbname: varian-hmis-db",
          ";     TOC Entries: 42",
          ";",
          "2059; 1262 16384 DATABASE - varian-hmis-db postgres",
          "2060; 1259 16400 TABLE public patients postgres",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(validateRestoreList("")).toBe(false);
    expect(validateRestoreList("; only comments\n; still comments")).toBe(false);
  });
});
