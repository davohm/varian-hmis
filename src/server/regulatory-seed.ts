import { sql } from "drizzle-orm";

import { REGULATORY_SETTINGS } from "@/lib/regulatory";
import type { db } from "@/server/db/client";
import { facilitySettings } from "@/server/db/schema";

import { todayIso } from "./queries/regulatory";

type Database = typeof db;

/**
 * Seed the §6.6 settings for a facility.
 *
 * Every key in `REGULATORY_SETTINGS` gets a row with its safe default, so a
 * fresh install renders the settings screen and can bill on day one. Existing
 * rows are never overwritten: an administrator's value always wins.
 */
export async function seedRegulatoryDefaults(
  database: Database,
  facilityId: string,
  options: { createdBy?: string; effectiveFrom?: string } = {},
): Promise<number> {
  const effectiveFrom = options.effectiveFrom ?? todayIso();
  const createdBy = options.createdBy ?? "seed";

  const rows = REGULATORY_SETTINGS.map((definition) => {
    const value = definition.defaultValue;
    const isNumeric = definition.dataType === "integer" || definition.dataType === "decimal";
    return {
      facilityId,
      domain: definition.domain,
      key: definition.key,
      valueText:
        value === null
          ? null
          : typeof value === "boolean"
            ? String(value)
            : String(value),
      valueNumeric: isNumeric && value !== null ? String(value) : null,
      valueJson: definition.dataType === "json" ? (value ?? null) : null,
      dataType: definition.dataType,
      allowedValues: definition.allowedValues ?? null,
      minValue: definition.min !== undefined ? String(definition.min) : null,
      maxValue: definition.max !== undefined ? String(definition.max) : null,
      regex: definition.pattern ?? null,
      isRequired: definition.required,
      isSecret: definition.secret ?? false,
      effectiveFrom,
      createdBy,
    };
  });

  const inserted = await database
    .insert(facilitySettings)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: facilitySettings.id });

  return inserted.length;
}

/** Verify a facility has a settings row for every definition. */
export async function missingRegulatorySettings(
  database: Database,
  facilityId: string,
): Promise<string[]> {
  const rows = await database.execute(sql`
    SELECT domain, key FROM facility_settings
    WHERE facility_id = ${facilityId}::uuid
  `);
  const present = new Set(
    ((rows as { rows?: Array<Record<string, unknown>> }).rows ?? []).map(
      (row) => `${String(row.domain)}:${String(row.key)}`,
    ),
  );
  return REGULATORY_SETTINGS.filter(
    (definition) => !present.has(`${definition.domain}:${definition.key}`),
  ).map((definition) => `${definition.domain}.${definition.key}`);
}
