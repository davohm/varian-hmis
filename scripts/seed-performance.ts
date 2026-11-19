import { createHash } from "node:crypto";
import { config } from "dotenv";
import { count, eq } from "drizzle-orm";
import { UUID } from "uuidv7";

import { DATABASE_URL } from "../src/server/env";
import { createDatabase } from "../src/server/db/client";
import { facilities, patients, type NewPatient } from "../src/server/db/schema";

// src/server/env.ts already loads these; repeat explicitly so direct tsx runs
// and future refactors keep the same .env.local > .env precedence.
config({ path: ".env.local" });
config({ path: ".env" });

const FACILITY_CODE = "FAM";
const DEFAULT_COUNT = 100_000;
const DEFAULT_BATCH = 1_000;
const MAX_COUNT = 1_000_000;
const MAX_BATCH = 2_000;
/** Fixed timestamp keeps every generated UUIDv7 stable across reruns. */
const BASE_TIMESTAMP = Date.UTC(2026, 0, 1);

const FIRST_NAMES = [
  "Amina", "Brian", "Caroline", "David", "Esha", "Francis", "Grace", "Hassan",
  "Irene", "Joseph", "Kamau", "Lydia", "Mary", "Njeri", "Omar", "Peter",
  "Queenie", "Ruth", "Samuel", "Wanjiku",
];
const LAST_NAMES = [
  "Abdi", "Bello", "Chebet", "Diallo", "Ekiru", "Farah", "Gitau", "Hassan",
  "Ibrahim", "Juma", "Kiptoo", "Lodvik", "Mutua", "Njoroge", "Odhiambo", "Patel",
  "Rotich", "Shiphrah", "Tumaini", "Wafula",
];
const SEXES = ["male", "female", "other"] as const;
const PAYER_TYPES = ["cash", "sha", "insurance"] as const;

interface PerformanceSeedOptions {
  count: number;
  batchSize: number;
  confirmed: boolean;
  dryRun: boolean;
}

function parsePositiveInteger(raw: string | undefined, fallback: number, max: number, name: string) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
  }
  return value;
}

function parseOptions(argv: string[], env: NodeJS.ProcessEnv): PerformanceSeedOptions {
  let count = DEFAULT_COUNT;
  let batchSize = DEFAULT_BATCH;
  let dryRun = false;
  let confirmed = env.PERF_SEED_CONFIRM === "1";

  for (const arg of argv) {
    if (arg === "--yes") {
      confirmed = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--count=")) {
      count = parsePositiveInteger(arg.slice("--count=".length), DEFAULT_COUNT, MAX_COUNT, "--count");
    } else if (arg.startsWith("--batch=")) {
      batchSize = parsePositiveInteger(arg.slice("--batch=".length), DEFAULT_BATCH, MAX_BATCH, "--batch");
    } else {
      throw new Error(`Unknown performance seed option: ${arg}`);
    }
  }

  return { count, batchSize, confirmed, dryRun };
}

/** SHA-256 derived rand bits make UUIDv7 primary keys reproducible per index. */
function deterministicUuidV7(index: number): string {
  const digest = createHash("sha256").update(`${FACILITY_CODE}:perf:${index}`).digest();
  const randA = digest.readUInt16BE(0) & 0x0fff;
  const randBHi = ((digest[2]! & 0x3f) << 24) | (digest.readUInt16BE(3) << 8) | digest[4]!;
  const randBLo = digest.readUInt32BE(5);
  return UUID.fromFieldsV7(BASE_TIMESTAMP, randA, randBHi, randBLo).toString();
}

function buildPatient(index: number, facilityId: string): NewPatient {
  const year = 1950 + (index % 60);
  const month = index % 12;
  const day = 1 + (index % 28);
  const dob = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  return {
    id: deterministicUuidV7(index),
    facilityId,
    mrn: `PERF-${String(index + 1).padStart(8, "0")}`,
    firstName: FIRST_NAMES[index % FIRST_NAMES.length]!,
    lastName: LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length]!,
    dob,
    dobEstimated: false,
    sex: SEXES[index % SEXES.length]!,
    payerType: PAYER_TYPES[index % PAYER_TYPES.length]!,
    createdBy: "perf-seed",
  };
}

async function run() {
  const options = parseOptions(process.argv.slice(2), process.env);

  if (!options.confirmed) {
    throw new Error(
      "Refusing to seed patients without confirmation. Pass --yes or set PERF_SEED_CONFIRM=1.",
    );
  }

  console.log(
    JSON.stringify(
      {
        phase: "start",
        facilityCode: FACILITY_CODE,
        target: options.count,
        batchSize: options.batchSize,
        dryRun: options.dryRun,
        strategy: "deterministic ids with ON CONFLICT DO NOTHING",
      },
      null,
      2,
    ),
  );

  if (options.dryRun) return;

  const { pool, db } = createDatabase(DATABASE_URL);
  const startedAt = Date.now();

  try {
    const [facility] = await db
      .select({ id: facilities.id })
      .from(facilities)
      .where(eq(facilities.code, FACILITY_CODE))
      .limit(1);
    if (!facility) {
      throw new Error(`Facility ${FACILITY_CODE} is missing. Run npm run db:seed first.`);
    }

    let inserted = 0;
    for (let offset = 0; offset < options.count; offset += options.batchSize) {
      const size = Math.min(options.batchSize, options.count - offset);
      const rows = Array.from({ length: size }, (_, index) =>
        buildPatient(offset + index, facility.id),
      );

      // One transaction per batch. Existing data is never updated or deleted.
      const batchInserted = await db.transaction(async (tx) => {
        const written = await tx
          .insert(patients)
          .values(rows)
          .onConflictDoNothing()
          .returning({ id: patients.id });
        return written.length;
      });
      inserted += batchInserted;

      console.log(
        JSON.stringify({
          phase: "progress",
          attempted: Math.min(offset + size, options.count),
          inserted,
          alreadyPresent: offset + size - inserted,
          percent: Number((((offset + size) / options.count) * 100).toFixed(2)),
          elapsedMs: Date.now() - startedAt,
        }),
      );
    }

    const [totals] = await db
      .select({ value: count() })
      .from(patients)
      .where(eq(patients.facilityId, facility.id));

    console.log(
      JSON.stringify(
        {
          phase: "complete",
          target: options.count,
          inserted,
          alreadyPresent: options.count - inserted,
          totalPatientsInFacility: totals?.value ?? null,
          elapsedMs: Date.now() - startedAt,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

void run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
