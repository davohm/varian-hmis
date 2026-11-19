import { spawn } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "dotenv";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  BACKUP_HEADER_BYTES,
  BACKUP_IV_BYTES,
  BACKUP_MAGIC,
  assertBackupPlan,
  assertRetentionResult,
  buildBackupPlan,
  decodeEncryptionKey,
  redactSecrets,
  selectBackupsForRetention,
  validateBackupConfig,
  validateRestoreList,
  type BackupConfig,
} from "../src/server/backups";

// Match src/server/env.ts and drizzle.config.ts loading order. Calling config()
// does not overwrite variables already present in the process environment.
config({ path: ".env.local" });
config({ path: ".env" });

/**
 * Connection details go to libpq through PG* environment variables, never
 * through argv, so a DATABASE_URL password cannot leak into the process list.
 */
function connectionEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decode(url.username),
    PGDATABASE: decode(url.pathname.replace(/^\//, "")),
  };
  if (url.password) childEnv.PGPASSWORD = decode(url.password);

  for (const key of [
    "sslmode",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "channel_binding",
    "application_name",
  ]) {
    const value = url.searchParams.get(key);
    if (value) childEnv[`PG${key.toUpperCase()}`] = value;
  }
  return childEnv;
}

function runCommand(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${bin} exited with code ${code}: ${stderr.trim() || "no details"}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function listExisting(backupDir: string): Promise<string[]> {
  try {
    return await readdir(backupDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function encryptDump(inputPath: string, outputPath: string, key: Buffer) {
  const plaintext = await readFile(inputPath);
  const iv = randomBytes(BACKUP_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const header = Buffer.concat([BACKUP_MAGIC, iv, cipher.getAuthTag()]);
  if (header.length !== BACKUP_HEADER_BYTES) {
    throw new Error("Internal backup header length mismatch.");
  }
  const encrypted = Buffer.concat([header, ciphertext]);
  await writeFile(outputPath, encrypted, { flag: "wx", mode: 0o600 });
  return {
    plaintextBytes: plaintext.length,
    encryptedBytes: encrypted.length,
    sha256: createHash("sha256").update(encrypted).digest("hex"),
  };
}

function publicSummary(config: BackupConfig, targetFileName: string) {
  return {
    backupDir: config.backupDir,
    retentionDays: config.retentionDays,
    targetFileName,
    pgDumpBin: config.pgDumpBin,
    pgRestoreBin: config.pgRestoreBin,
    once: config.once,
  };
}

async function main() {
  const config = validateBackupConfig(process.env, process.argv.slice(2));
  const now = new Date();
  const existing = await listExisting(config.backupDir);
  const plan = buildBackupPlan({
    now,
    existingFiles: existing,
    backupDir: config.backupDir,
    retentionDays: config.retentionDays,
    dryRun: config.dryRun,
  });
  assertBackupPlan(plan);

  if (config.dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          ...publicSummary(config, plan.targetFileName),
          steps: plan.steps,
          wouldWrite: plan.targetPath,
          wouldPrune: plan.remove,
          ignored: plan.ignored,
        },
        null,
        2,
      ),
    );
    return;
  }

  await mkdir(config.backupDir, { recursive: true });
  const key = decodeEncryptionKey(config.encryptionKey);
  const childEnv = connectionEnv(config.databaseUrl);
  const tempDump = join(
    config.backupDir,
    `.${plan.targetFileName}.${randomBytes(6).toString("hex")}.dump.tmp`,
  );

  console.log(
    JSON.stringify(
      { phase: "start", ...publicSummary(config, plan.targetFileName), steps: plan.steps },
      null,
      2,
    ),
  );

  try {
    await runCommand(
      config.pgDumpBin,
      ["--format=custom", "--no-owner", "--no-privileges", `--file=${tempDump}`],
      childEnv,
    );

    const toc = await runCommand(config.pgRestoreBin, ["--list", tempDump], childEnv);
    if (!validateRestoreList(toc)) {
      throw new Error("pg_restore --list did not report a valid archive table of contents.");
    }

    const encrypted = await encryptDump(tempDump, plan.targetPath, key);

    // Recompute after writing so the new backup participates in retention.
    const retention = selectBackupsForRetention(
      [...existing, plan.targetFileName],
      new Date(),
      config.retentionDays,
    );
    assertRetentionResult(retention, config.retentionDays);
    if (retention.remove.includes(plan.targetFileName)) {
      throw new Error("Retention would delete the backup just created.");
    }
    for (const fileName of retention.remove) {
      await rm(join(config.backupDir, fileName));
    }

    console.log(
      JSON.stringify(
        {
          phase: "complete",
          ...publicSummary(config, plan.targetFileName),
          plaintextBytes: encrypted.plaintextBytes,
          encryptedBytes: encrypted.encryptedBytes,
          sha256: encrypted.sha256,
          pruned: retention.remove,
          ignored: retention.ignored,
          tocEntries: toc.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith(";")).length,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(tempDump, { force: true });
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `Backup failed: ${redactSecrets(message, [process.env.DATABASE_URL, process.env.BACKUP_ENCRYPTION_KEY])}`,
  );
  process.exitCode = 1;
});
