import { randomBytes } from "node:crypto";
import { join } from "node:path";

/**
 * Pure backup rules. No database, filesystem or process-env access lives here so
 * the retention and validation behaviour can be unit tested without a DB.
 * The backup script owns all I/O and calls these helpers before acting.
 */

export const BACKUP_PREFIX = "varian-hmis";
export const BACKUP_EXTENSION = ".dump.enc";
export const DEFAULT_RETENTION_DAYS = 14;
const MAX_RETENTION_DAYS = 365;

/** Encrypted file layout: magic (6) + IV (12) + GCM tag (16) + ciphertext. */
export const BACKUP_MAGIC = Buffer.from("VHMIS1", "ascii");
export const BACKUP_IV_BYTES = 12;
export const BACKUP_TAG_BYTES = 16;
export const BACKUP_HEADER_BYTES = BACKUP_MAGIC.length + BACKUP_IV_BYTES + BACKUP_TAG_BYTES;

const KEY_BYTES = 32;
const FILE_NAME_PATTERN =
  /^varian-hmis-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.dump\.enc$/;

/** Decode a base64 AES-256 key. Errors never include the supplied value. */
export function decodeEncryptionKey(key: string | undefined | null): Buffer {
  if (!key || typeof key !== "string") {
    throw new Error("BACKUP_ENCRYPTION_KEY is not set.");
  }
  const normalized = key.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error("BACKUP_ENCRYPTION_KEY must be base64-encoded 32 bytes.");
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length !== KEY_BYTES) {
    throw new Error("BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256).");
  }
  if (decoded.toString("base64") !== normalized) {
    throw new Error("BACKUP_ENCRYPTION_KEY is not canonical base64.");
  }
  return decoded;
}

/** Validate and return the trimmed key. Safe to call from config validation. */
export function validateEncryptionKey(key: string | undefined | null): string {
  decodeEncryptionKey(key);
  return (key as string).trim();
}

/** Generate a new key for operators: `openssl rand -base64 32` is equivalent. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

export function normalizeRetentionDays(value: string | number | undefined | null): number {
  if (value === undefined || value === null || value === "") return DEFAULT_RETENTION_DAYS;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_RETENTION_DAYS) {
    throw new Error(`BACKUP_RETENTION_DAYS must be an integer between 1 and ${MAX_RETENTION_DAYS}.`);
  }
  return parsed;
}

export function formatBackupTimestamp(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error("Invalid backup date.");
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}Z`
  );
}

export function backupFileName(date: Date): string {
  return `${BACKUP_PREFIX}-${formatBackupTimestamp(date)}${BACKUP_EXTENSION}`;
}

export interface ParsedBackupName {
  fileName: string;
  /** UTC calendar day (YYYY-MM-DD), used as the retention bucket. */
  day: string;
  date: Date;
}

/**
 * Parse a backup basename. Path-like names, unknown suffixes and impossible
 * dates return null so retention never deletes anything it did not create.
 */
export function parseBackupFileName(fileName: string): ParsedBackupName | null {
  if (typeof fileName !== "string" || fileName.length === 0) return null;
  if (fileName !== fileName.trim()) return null;
  if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) return null;

  const match = FILE_NAME_PATTERN.exec(fileName);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }

  return { fileName, day: `${yearText}-${monthText}-${dayText}`, date };
}

/** Avoid overwriting a same-second backup by advancing the timestamp. */
export function nextBackupFileName(date: Date, existing: Iterable<string>): string {
  const used = new Set(existing);
  let candidate = new Date(date.getTime());
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const fileName = backupFileName(candidate);
    if (!used.has(fileName)) return fileName;
    candidate = new Date(candidate.getTime() + 1000);
  }
  throw new Error("Could not allocate a unique backup filename.");
}

export interface RetentionResult {
  keep: string[];
  remove: string[];
  ignored: string[];
}

/**
 * Keep the newest backup per UTC day, for at most `retentionDays` days.
 * Files dated in the future and files with unknown names are ignored, never
 * deleted. Results are sorted for deterministic output and safe execution.
 */
export function selectBackupsForRetention(
  files: Iterable<string>,
  now: Date,
  retentionDays: string | number = DEFAULT_RETENTION_DAYS,
): RetentionResult {
  const limit = normalizeRetentionDays(retentionDays);
  const today = formatBackupTimestamp(now).slice(0, 10);
  const byDay = new Map<string, ParsedBackupName[]>();
  const ignored: string[] = [];

  for (const fileName of files) {
    const parsed = parseBackupFileName(fileName);
    if (!parsed || parsed.day > today) {
      ignored.push(fileName);
      continue;
    }
    const entries = byDay.get(parsed.day) ?? [];
    entries.push(parsed);
    byDay.set(parsed.day, entries);
  }

  const days = [...byDay.keys()].sort((a, b) => b.localeCompare(a));
  const keepDays = new Set(days.slice(0, limit));
  const keep: string[] = [];
  const remove: string[] = [];

  for (const day of days) {
    const entries = byDay.get(day)!.sort(
      (a, b) => b.date.getTime() - a.date.getTime() || b.fileName.localeCompare(a.fileName),
    );
    if (keepDays.has(day)) {
      keep.push(entries[0]!.fileName);
      remove.push(...entries.slice(1).map((entry) => entry.fileName));
    } else {
      remove.push(...entries.map((entry) => entry.fileName));
    }
  }

  return { keep: keep.sort(), remove: remove.sort(), ignored: ignored.sort() };
}

/** Validate retention output before any deletion is attempted. */
export function assertRetentionResult(
  result: RetentionResult,
  retentionDays: string | number = DEFAULT_RETENTION_DAYS,
): void {
  const limit = normalizeRetentionDays(retentionDays);
  const all = [...result.keep, ...result.remove, ...result.ignored];
  if (new Set(all).size !== all.length) {
    throw new Error("Retention result contains duplicate filenames.");
  }
  if (result.keep.length > limit) {
    throw new Error("Retention result exceeds the configured day limit.");
  }
  for (const fileName of result.remove) {
    if (!parseBackupFileName(fileName)) {
      throw new Error("Retention result would delete an unrecognised filename.");
    }
  }
  const keepDays = result.keep.map((fileName) => parseBackupFileName(fileName)?.day);
  if (keepDays.some((day) => !day) || new Set(keepDays).size !== keepDays.length) {
    throw new Error("Retention result must keep at most one backup per day.");
  }
  if (result.remove.length > 0 && keepDays.length > 0) {
    const removeDays = result.remove
      .map((fileName) => parseBackupFileName(fileName)!.day)
      .sort();
    const oldestKept = [...keepDays].sort()[0]!;
    const newestRemoved = removeDays[removeDays.length - 1]!;
    if (oldestKept <= newestRemoved) {
      throw new Error("Retention result would delete a backup newer than one it keeps.");
    }
  }
}

export interface BackupConfig {
  databaseUrl: string;
  /** Null only for --dry-run without a configured key. */
  encryptionKey: string | null;
  backupDir: string;
  retentionDays: number;
  pgBinDir: string;
  pgDumpBin: string;
  pgRestoreBin: string;
  psqlBin: string;
  dryRun: boolean;
  once: boolean;
}

/** Validate process configuration. Error messages never contain secret values. */
export function validateBackupConfig(
  env: Record<string, string | undefined>,
  argv: string[] = [],
  cwd: string = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): BackupConfig {
  const allowedFlags = new Set(["--dry-run", "--once"]);
  for (const flag of argv) {
    if (!allowedFlags.has(flag)) throw new Error(`Unknown backup option: ${flag}`);
  }
  const dryRun = argv.includes("--dry-run");
  const once = argv.includes("--once");

  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
  }
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    throw new Error("DATABASE_URL must use the postgres:// or postgresql:// scheme.");
  }
  try {
    new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }

  const rawKey = env.BACKUP_ENCRYPTION_KEY;
  const encryptionKey = rawKey?.trim() ? validateEncryptionKey(rawKey) : null;
  if (!encryptionKey && !dryRun) {
    throw new Error(
      "BACKUP_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32",
    );
  }

  const pgBinDir =
    env.PG_BIN_DIR?.trim() ||
    (platform === "win32" ? "C:\\Program Files\\PostgreSQL\\17\\bin" : "/usr/lib/postgresql/17/bin");
  const suffix = platform === "win32" ? ".exe" : "";

  return {
    databaseUrl,
    encryptionKey,
    backupDir: env.BACKUP_DIR?.trim() || join(cwd, "backups"),
    retentionDays: normalizeRetentionDays(env.BACKUP_RETENTION_DAYS),
    pgBinDir,
    pgDumpBin: env.PG_DUMP_BIN?.trim() || join(pgBinDir, `pg_dump${suffix}`),
    pgRestoreBin: env.PG_RESTORE_BIN?.trim() || join(pgBinDir, `pg_restore${suffix}`),
    psqlBin: env.PSQL_BIN?.trim() || join(pgBinDir, `psql${suffix}`),
    dryRun,
    once,
  };
}

/** Strip credentials from anything that may be written to a log. */
export function redactSecrets(message: string, secrets: Array<string | undefined | null>): string {
  let result = message;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.trim().length === 0) continue;
    result = result.split(secret.trim()).join("[REDACTED]");
  }
  result = result.replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgres://[REDACTED]@");
  return result.replace(/(password\s*=\s*)([^\s]+)/gi, "$1[REDACTED]");
}

/** Confirm pg_restore produced a real TOC before treating a dump as valid. */
export function validateRestoreList(output: string): boolean {
  if (typeof output !== "string") return false;
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hasHeader = lines.some((line) => /Archive created|TOC Entries/i.test(line));
  const hasEntries = lines.some((line) => !line.startsWith(";"));
  return hasHeader && hasEntries;
}

export interface BackupPlan {
  generatedAt: string;
  day: string;
  targetFileName: string;
  targetPath: string;
  retentionDays: number;
  keep: string[];
  remove: string[];
  ignored: string[];
  dryRun: boolean;
  willWrite: boolean;
  willPrune: boolean;
  steps: string[];
}

export interface BackupPlanInput {
  now: Date;
  existingFiles: Iterable<string>;
  backupDir?: string;
  retentionDays?: string | number;
  dryRun?: boolean;
}

/** Build the complete, inspectable plan used by both --dry-run and real runs. */
export function buildBackupPlan(input: BackupPlanInput): BackupPlan {
  const retentionDays = normalizeRetentionDays(input.retentionDays);
  const dryRun = input.dryRun === true;
  const existingFiles = [...input.existingFiles];
  const targetFileName = nextBackupFileName(input.now, existingFiles);
  const parsedTarget = parseBackupFileName(targetFileName)!;
  const retention = selectBackupsForRetention(existingFiles, input.now, retentionDays);
  const backupDir = input.backupDir ?? "backups";
  const steps = [
    `dump:${targetFileName}`,
    `verify:${targetFileName}`,
    `encrypt:${targetFileName}`,
  ];
  if (retention.remove.length > 0) steps.push(`prune:${retention.remove.length}`);

  return {
    generatedAt: formatBackupTimestamp(input.now),
    day: parsedTarget.day,
    targetFileName,
    targetPath: join(backupDir, targetFileName),
    retentionDays,
    keep: retention.keep,
    remove: retention.remove,
    ignored: retention.ignored,
    dryRun,
    willWrite: !dryRun,
    willPrune: !dryRun && retention.remove.length > 0,
    steps,
  };
}

/** Validate a plan immediately before it is executed. */
export function assertBackupPlan(plan: BackupPlan): void {
  assertRetentionResult(
    { keep: plan.keep, remove: plan.remove, ignored: plan.ignored },
    plan.retentionDays,
  );
  if (parseBackupFileName(plan.targetFileName)?.day !== plan.day) {
    throw new Error("Backup plan has an inconsistent target day.");
  }
  if (!plan.targetPath.endsWith(plan.targetFileName)) {
    throw new Error("Backup plan target path does not match its filename.");
  }
  if (plan.remove.includes(plan.targetFileName)) {
    throw new Error("Backup plan would prune the file it is about to write.");
  }
  if (plan.dryRun && (plan.willWrite || plan.willPrune)) {
    throw new Error("Dry-run plan must not write or prune.");
  }
  if (!plan.dryRun && !plan.willWrite) {
    throw new Error("Live backup plan must write the dump.");
  }
  if (plan.steps.length === 0) {
    throw new Error("Backup plan has no steps.");
  }
}
