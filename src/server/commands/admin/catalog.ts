import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { newId } from "@/lib/uuid";
import {
  icd10Codes,
  items,
  labTests,
  priceLists,
  prices,
  services,
  type LabParameter,
} from "@/server/db/schema";

import { runCommand, type CommandOptions, type CommandTransaction } from "../run";
import { adminBaseSchema, codeSchema, moneySchema, requireActor, writeAdminAudit } from "./shared";

const nameSchema = z.string().trim().min(2).max(160);
const unitSchema = z.string().trim().min(1).max(32);
const optionalText = z.string().trim().max(255).nullable().optional();
const sharedFields = { shared: z.boolean().default(false) };
const itemKindSchema = z.enum(["drug", "consumable", "reagent"]);
const serviceKindSchema = z.enum(["consultation", "lab", "procedure", "drug"]);
const payerTypeSchema = z.enum(["cash", "sha", "insurance"]);

export const labParameterSchema = z.object({
  name: z.string().trim().min(1).max(80),
  unit: unitSchema,
  refLow: z.number().nullable().default(null),
  refHigh: z.number().nullable().default(null),
  criticalLow: z.number().nullable().default(null),
  criticalHigh: z.number().nullable().default(null),
});

function touch() {
  return { updatedAt: new Date(), version: sql`version + 1` };
}

export const createItemSchema = z.object({
  ...adminBaseSchema,
  ...sharedFields,
  code: codeSchema.transform((value) => value.toUpperCase()),
  name: nameSchema,
  kind: itemKindSchema.default("drug"),
  unit: unitSchema.default("unit"),
  strength: optionalText,
  form: optionalText,
});
export type CreateItemInput = z.input<typeof createItemSchema>;

export const updateItemSchema = z
  .object({
    ...adminBaseSchema,
    id: z.uuid(),
    ...sharedFields,
    code: codeSchema.transform((value) => value.toUpperCase()).optional(),
    name: nameSchema.optional(),
    kind: itemKindSchema.optional(),
    unit: unitSchema.optional(),
    strength: optionalText,
    form: optionalText,
    active: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.code !== undefined ||
      value.name !== undefined ||
      value.kind !== undefined ||
      value.unit !== undefined ||
      value.strength !== undefined ||
      value.form !== undefined ||
      value.active !== undefined ||
      value.shared !== undefined,
    "No item changes supplied",
  );
export type UpdateItemInput = z.input<typeof updateItemSchema>;

export const setItemActiveSchema = z.object({
  ...adminBaseSchema,
  id: z.uuid(),
  active: z.boolean(),
});
export type SetItemActiveInput = z.input<typeof setItemActiveSchema>;

export const createLabTestSchema = z.object({
  ...adminBaseSchema,
  ...sharedFields,
  code: codeSchema.transform((value) => value.toUpperCase()),
  name: nameSchema,
  sampleType: nameSchema,
  parameters: z.array(labParameterSchema).max(30).default([]),
});
export type CreateLabTestInput = z.input<typeof createLabTestSchema>;

export const updateLabTestSchema = z
  .object({
    ...adminBaseSchema,
    id: z.uuid(),
    ...sharedFields,
    code: codeSchema.transform((value) => value.toUpperCase()).optional(),
    name: nameSchema.optional(),
    sampleType: nameSchema.optional(),
    parameters: z.array(labParameterSchema).max(30).optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.code !== undefined ||
      value.name !== undefined ||
      value.sampleType !== undefined ||
      value.parameters !== undefined ||
      value.active !== undefined ||
      value.shared !== undefined,
    "No laboratory test changes supplied",
  );
export type UpdateLabTestInput = z.input<typeof updateLabTestSchema>;

export const setLabTestActiveSchema = z.object({
  ...adminBaseSchema,
  id: z.uuid(),
  active: z.boolean(),
});
export type SetLabTestActiveInput = z.input<typeof setLabTestActiveSchema>;

export const createServiceSchema = z.object({
  ...adminBaseSchema,
  ...sharedFields,
  code: codeSchema.transform((value) => value.toUpperCase()),
  name: nameSchema,
  kind: serviceKindSchema,
  defaultPrice: moneySchema.default("0"),
  active: z.boolean().default(true),
});
export type CreateServiceInput = z.input<typeof createServiceSchema>;

export const updateServiceSchema = z
  .object({
    ...adminBaseSchema,
    id: z.uuid(),
    ...sharedFields,
    code: codeSchema.transform((value) => value.toUpperCase()).optional(),
    name: nameSchema.optional(),
    kind: serviceKindSchema.optional(),
    defaultPrice: moneySchema.optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.code !== undefined ||
      value.name !== undefined ||
      value.kind !== undefined ||
      value.defaultPrice !== undefined ||
      value.active !== undefined ||
      value.shared !== undefined,
    "No service changes supplied",
  );
export type UpdateServiceInput = z.input<typeof updateServiceSchema>;

export const setServiceActiveSchema = z.object({
  ...adminBaseSchema,
  id: z.uuid(),
  active: z.boolean(),
});
export type SetServiceActiveInput = z.input<typeof setServiceActiveSchema>;

export const createPriceListSchema = z.object({
  ...adminBaseSchema,
  name: nameSchema,
  payerType: payerTypeSchema,
  active: z.boolean().default(true),
});
export type CreatePriceListInput = z.input<typeof createPriceListSchema>;

export const updatePriceListSchema = z
  .object({
    ...adminBaseSchema,
    id: z.uuid(),
    name: nameSchema.optional(),
    payerType: payerTypeSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.payerType !== undefined || value.active !== undefined,
    "No price list changes supplied",
  );
export type UpdatePriceListInput = z.input<typeof updatePriceListSchema>;

export const setPriceListActiveSchema = z.object({
  ...adminBaseSchema,
  id: z.uuid(),
  active: z.boolean(),
});
export type SetPriceListActiveInput = z.input<typeof setPriceListActiveSchema>;

export const upsertPriceSchema = z.object({
  ...adminBaseSchema,
  priceListId: z.uuid(),
  targetType: z.enum(["service", "item"]),
  targetId: z.uuid(),
  amount: moneySchema,
});
export type UpsertPriceInput = z.input<typeof upsertPriceSchema>;

export const removePriceSchema = z.object({
  ...adminBaseSchema,
  id: z.uuid(),
});
export type RemovePriceInput = z.input<typeof removePriceSchema>;

export const importIcd10Schema = z.object({
  ...adminBaseSchema,
  rows: z
    .array(
      z.object({
        code: codeSchema.transform((value) => value.toUpperCase()),
        description: z.string().trim().min(1).max(255),
        chapter: optionalText,
      }),
    )
    .min(1)
    .max(500),
});
export type ImportIcd10Input = z.input<typeof importIcd10Schema>;

async function requireVisibleItem(tx: CommandTransaction, facilityId: string, id: string) {
  const rows = await tx
    .select()
    .from(items)
    .where(
      and(
        eq(items.id, id),
        or(isNull(items.facilityId), eq(items.facilityId, facilityId)),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new Error("Item not found in this facility");
  return rows[0];
}

async function requireVisibleLabTest(tx: CommandTransaction, facilityId: string, id: string) {
  const rows = await tx
    .select()
    .from(labTests)
    .where(
      and(
        eq(labTests.id, id),
        or(isNull(labTests.facilityId), eq(labTests.facilityId, facilityId)),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new Error("Laboratory test not found in this facility");
  return rows[0];
}

async function requireVisibleService(tx: CommandTransaction, facilityId: string, id: string) {
  const rows = await tx
    .select()
    .from(services)
    .where(
      and(
        eq(services.id, id),
        or(isNull(services.facilityId), eq(services.facilityId, facilityId)),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new Error("Service not found in this facility");
  return rows[0];
}

async function requirePriceList(tx: CommandTransaction, facilityId: string, id: string) {
  const rows = await tx
    .select()
    .from(priceLists)
    .where(and(eq(priceLists.id, id), eq(priceLists.facilityId, facilityId)))
    .limit(1);
  if (!rows[0]) throw new Error("Price list not found in this facility");
  return rows[0];
}

export async function createItem(input: CreateItemInput, options: CommandOptions = {}) {
  const values = createItemSchema.parse(input);
  const actorId = requireActor(values.actor);
  const itemFacilityId = values.shared ? null : values.facilityId;

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createItem",
    async (tx) => {
      const duplicate = await tx
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.code, values.code), isNull(items.facilityId)))
        .limit(1);
      if (!values.shared) {
        const local = await tx
          .select({ id: items.id })
          .from(items)
          .where(and(eq(items.code, values.code), eq(items.facilityId, values.facilityId)))
          .limit(1);
        if (duplicate[0] || local[0]) throw new Error("Item code already exists");
      } else if (duplicate[0]) {
        throw new Error("Item code already exists");
      }

      const id = newId();
      await tx.insert(items).values({
        id,
        facilityId: itemFacilityId,
        code: values.code,
        name: values.name,
        kind: values.kind,
        unit: values.unit,
        strength: values.strength ?? null,
        form: values.form ?? null,
        active: true,
        createdBy: actorId,
      });

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.item.create",
        entity: "items",
        entityId: id,
        details: { code: values.code, name: values.name, shared: values.shared },
      });

      return { itemId: id, code: values.code };
    },
    options,
  );
}

export async function updateItem(input: UpdateItemInput, options: CommandOptions = {}) {
  const values = updateItemSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "updateItem",
    async (tx) => {
      const current = await requireVisibleItem(tx, values.facilityId, values.id);
      const itemFacilityId =
        values.shared === undefined
          ? current.facilityId
          : values.shared
            ? null
            : values.facilityId;

      if (values.code) {
        const duplicate = await tx
          .select({ id: items.id })
          .from(items)
          .where(
            and(
              eq(items.code, values.code),
              ne(items.id, values.id),
              itemFacilityId
                ? eq(items.facilityId, itemFacilityId)
                : isNull(items.facilityId),
            ),
          )
          .limit(1);
        if (duplicate[0]) throw new Error("Item code already exists");
      }

      await tx
        .update(items)
        .set({
          facilityId: itemFacilityId,
          code: values.code,
          name: values.name,
          kind: values.kind,
          unit: values.unit,
          strength: values.strength,
          form: values.form,
          active: values.active,
          ...touch(),
        })
        .where(eq(items.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.item.update",
        entity: "items",
        entityId: values.id,
        details: { code: values.code, name: values.name, active: values.active },
      });

      return { itemId: values.id };
    },
    options,
  );
}

export async function setItemActive(input: SetItemActiveInput, options: CommandOptions = {}) {
  const values = setItemActiveSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "setItemActive",
    async (tx) => {
      await requireVisibleItem(tx, values.facilityId, values.id);
      await tx
        .update(items)
        .set({ active: values.active, ...touch() })
        .where(eq(items.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.item.setActive",
        entity: "items",
        entityId: values.id,
        details: { active: values.active },
      });

      return { itemId: values.id, active: values.active };
    },
    options,
  );
}

export async function createLabTest(input: CreateLabTestInput, options: CommandOptions = {}) {
  const values = createLabTestSchema.parse(input);
  const actorId = requireActor(values.actor);
  const testFacilityId = values.shared ? null : values.facilityId;

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createLabTest",
    async (tx) => {
      const conditions = [eq(labTests.code, values.code)];
      conditions.push(testFacilityId ? eq(labTests.facilityId, testFacilityId) : isNull(labTests.facilityId));
      const duplicate = await tx
        .select({ id: labTests.id })
        .from(labTests)
        .where(and(...conditions))
        .limit(1);
      if (duplicate[0]) throw new Error("Laboratory test code already exists");

      const id = newId();
      await tx.insert(labTests).values({
        id,
        facilityId: testFacilityId,
        code: values.code,
        name: values.name,
        sampleType: values.sampleType,
        parameters: values.parameters as LabParameter[],
        active: true,
        createdBy: actorId,
      });

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.labTest.create",
        entity: "lab_tests",
        entityId: id,
        details: { code: values.code, name: values.name, shared: values.shared },
      });

      return { labTestId: id, code: values.code };
    },
    options,
  );
}

export async function updateLabTest(input: UpdateLabTestInput, options: CommandOptions = {}) {
  const values = updateLabTestSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "updateLabTest",
    async (tx) => {
      const current = await requireVisibleLabTest(tx, values.facilityId, values.id);
      const testFacilityId =
        values.shared === undefined
          ? current.facilityId
          : values.shared
            ? null
            : values.facilityId;

      if (values.code) {
        const duplicate = await tx
          .select({ id: labTests.id })
          .from(labTests)
          .where(
            and(
              eq(labTests.code, values.code),
              ne(labTests.id, values.id),
              testFacilityId ? eq(labTests.facilityId, testFacilityId) : isNull(labTests.facilityId),
            ),
          )
          .limit(1);
        if (duplicate[0]) throw new Error("Laboratory test code already exists");
      }

      await tx
        .update(labTests)
        .set({
          facilityId: testFacilityId,
          code: values.code,
          name: values.name,
          sampleType: values.sampleType,
          parameters: values.parameters as LabParameter[] | undefined,
          active: values.active,
          ...touch(),
        })
        .where(eq(labTests.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.labTest.update",
        entity: "lab_tests",
        entityId: values.id,
        details: { code: values.code, name: values.name, active: values.active },
      });

      return { labTestId: values.id };
    },
    options,
  );
}

export async function setLabTestActive(input: SetLabTestActiveInput, options: CommandOptions = {}) {
  const values = setLabTestActiveSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "setLabTestActive",
    async (tx) => {
      await requireVisibleLabTest(tx, values.facilityId, values.id);
      await tx
        .update(labTests)
        .set({ active: values.active, ...touch() })
        .where(eq(labTests.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.labTest.setActive",
        entity: "lab_tests",
        entityId: values.id,
        details: { active: values.active },
      });

      return { labTestId: values.id, active: values.active };
    },
    options,
  );
}

export async function createService(input: CreateServiceInput, options: CommandOptions = {}) {
  const values = createServiceSchema.parse(input);
  const actorId = requireActor(values.actor);
  const serviceFacilityId = values.shared ? null : values.facilityId;

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createService",
    async (tx) => {
      const duplicate = await tx
        .select({ id: services.id })
        .from(services)
        .where(
          and(
            eq(services.code, values.code),
            serviceFacilityId ? eq(services.facilityId, serviceFacilityId) : isNull(services.facilityId),
          ),
        )
        .limit(1);
      if (duplicate[0]) throw new Error("Service code already exists");

      const id = newId();
      await tx.insert(services).values({
        id,
        facilityId: serviceFacilityId,
        code: values.code,
        name: values.name,
        kind: values.kind,
        defaultPrice: values.defaultPrice,
        active: values.active,
        createdBy: actorId,
      });

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.service.create",
        entity: "services",
        entityId: id,
        details: { code: values.code, name: values.name, shared: values.shared },
      });

      return { serviceId: id, code: values.code };
    },
    options,
  );
}

export async function updateService(input: UpdateServiceInput, options: CommandOptions = {}) {
  const values = updateServiceSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "updateService",
    async (tx) => {
      const current = await requireVisibleService(tx, values.facilityId, values.id);
      const serviceFacilityId =
        values.shared === undefined
          ? current.facilityId
          : values.shared
            ? null
            : values.facilityId;

      if (values.code) {
        const duplicate = await tx
          .select({ id: services.id })
          .from(services)
          .where(
            and(
              eq(services.code, values.code),
              ne(services.id, values.id),
              serviceFacilityId
                ? eq(services.facilityId, serviceFacilityId)
                : isNull(services.facilityId),
            ),
          )
          .limit(1);
        if (duplicate[0]) throw new Error("Service code already exists");
      }

      await tx
        .update(services)
        .set({
          facilityId: serviceFacilityId,
          code: values.code,
          name: values.name,
          kind: values.kind,
          defaultPrice: values.defaultPrice,
          active: values.active,
          ...touch(),
        })
        .where(eq(services.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.service.update",
        entity: "services",
        entityId: values.id,
        details: { code: values.code, name: values.name, active: values.active },
      });

      return { serviceId: values.id };
    },
    options,
  );
}

export async function setServiceActive(input: SetServiceActiveInput, options: CommandOptions = {}) {
  const values = setServiceActiveSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "setServiceActive",
    async (tx) => {
      await requireVisibleService(tx, values.facilityId, values.id);
      await tx
        .update(services)
        .set({ active: values.active, ...touch() })
        .where(eq(services.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.service.setActive",
        entity: "services",
        entityId: values.id,
        details: { active: values.active },
      });

      return { serviceId: values.id, active: values.active };
    },
    options,
  );
}

export async function createPriceList(input: CreatePriceListInput, options: CommandOptions = {}) {
  const values = createPriceListSchema.parse(input);
  const actorId = requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "createPriceList",
    async (tx) => {
      const duplicate = await tx
        .select({ id: priceLists.id })
        .from(priceLists)
        .where(and(eq(priceLists.facilityId, values.facilityId), eq(priceLists.payerType, values.payerType)))
        .limit(1);
      if (duplicate[0]) throw new Error("A price list for this payer already exists");

      const id = newId();
      await tx.insert(priceLists).values({
        id,
        facilityId: values.facilityId,
        name: values.name,
        payerType: values.payerType,
        active: values.active,
        createdBy: actorId,
      });

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.priceList.create",
        entity: "price_lists",
        entityId: id,
        details: { name: values.name, payerType: values.payerType },
      });

      return { priceListId: id, payerType: values.payerType };
    },
    options,
  );
}

export async function updatePriceList(input: UpdatePriceListInput, options: CommandOptions = {}) {
  const values = updatePriceListSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "updatePriceList",
    async (tx) => {
      await requirePriceList(tx, values.facilityId, values.id);
      if (values.payerType) {
        const duplicate = await tx
          .select({ id: priceLists.id })
          .from(priceLists)
          .where(
            and(
              eq(priceLists.facilityId, values.facilityId),
              eq(priceLists.payerType, values.payerType),
              ne(priceLists.id, values.id),
            ),
          )
          .limit(1);
        if (duplicate[0]) throw new Error("A price list for this payer already exists");
      }

      await tx
        .update(priceLists)
        .set({
          name: values.name,
          payerType: values.payerType,
          active: values.active,
          ...touch(),
        })
        .where(eq(priceLists.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.priceList.update",
        entity: "price_lists",
        entityId: values.id,
        details: { name: values.name, payerType: values.payerType, active: values.active },
      });

      return { priceListId: values.id };
    },
    options,
  );
}

export async function setPriceListActive(input: SetPriceListActiveInput, options: CommandOptions = {}) {
  const values = setPriceListActiveSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "setPriceListActive",
    async (tx) => {
      await requirePriceList(tx, values.facilityId, values.id);
      await tx
        .update(priceLists)
        .set({ active: values.active, ...touch() })
        .where(eq(priceLists.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.priceList.setActive",
        entity: "price_lists",
        entityId: values.id,
        details: { active: values.active },
      });

      return { priceListId: values.id, active: values.active };
    },
    options,
  );
}

export async function upsertPrice(input: UpsertPriceInput, options: CommandOptions = {}) {
  const values = upsertPriceSchema.parse(input);
  const actorId = requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "upsertPrice",
    async (tx) => {
      await requirePriceList(tx, values.facilityId, values.priceListId);
      if (values.targetType === "service") {
        await requireVisibleService(tx, values.facilityId, values.targetId);
      } else {
        await requireVisibleItem(tx, values.facilityId, values.targetId);
      }

      const target =
        values.targetType === "service"
          ? [prices.priceListId, prices.serviceId]
          : [prices.priceListId, prices.itemId];
      const conflictWhere =
        values.targetType === "service"
          ? sql`${prices.serviceId} is not null`
          : sql`${prices.itemId} is not null`;

      await tx
        .insert(prices)
        .values({
          id: newId(),
          facilityId: values.facilityId,
          priceListId: values.priceListId,
          serviceId: values.targetType === "service" ? values.targetId : null,
          itemId: values.targetType === "item" ? values.targetId : null,
          amount: values.amount,
          createdBy: actorId,
        })
        .onConflictDoUpdate({
          target,
          targetWhere: conflictWhere,
          set: {
            amount: values.amount,
            createdBy: actorId,
            updatedAt: new Date(),
            version: sql`${prices.version} + 1`,
          },
        });

      const rows = await tx
        .select({ id: prices.id })
        .from(prices)
        .where(
          and(
            eq(prices.facilityId, values.facilityId),
            eq(prices.priceListId, values.priceListId),
            values.targetType === "service"
              ? eq(prices.serviceId, values.targetId)
              : eq(prices.itemId, values.targetId),
          ),
        )
        .limit(1);
      const priceId = rows[0]?.id;
      if (!priceId) throw new Error("Could not save the price");

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.price.upsert",
        entity: "prices",
        entityId: priceId,
        details: {
          priceListId: values.priceListId,
          targetType: values.targetType,
          targetId: values.targetId,
          amount: values.amount,
        },
      });

      return { priceId, amount: values.amount };
    },
    options,
  );
}

export async function removePrice(input: RemovePriceInput, options: CommandOptions = {}) {
  const values = removePriceSchema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "removePrice",
    async (tx) => {
      const current = await tx
        .select({ id: prices.id, priceListId: prices.priceListId })
        .from(prices)
        .where(and(eq(prices.id, values.id), eq(prices.facilityId, values.facilityId)))
        .limit(1);
      if (!current[0]) throw new Error("Price not found in this facility");

      await tx.delete(prices).where(eq(prices.id, values.id));

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.price.remove",
        entity: "prices",
        entityId: values.id,
        details: { priceListId: current[0].priceListId },
      });

      return { priceId: values.id };
    },
    options,
  );
}

export async function importIcd10(input: ImportIcd10Input, options: CommandOptions = {}) {
  const values = importIcd10Schema.parse(input);
  requireActor(values.actor);

  return runCommand(
    { facilityId: values.facilityId, idempotencyKey: values.idempotencyKey },
    "importIcd10",
    async (tx) => {
      const codes = new Map<string, (typeof values.rows)[number]>();
      for (const row of values.rows) codes.set(row.code, row);
      const rows = [...codes.values()];

      const existing = await tx
        .select({ code: icd10Codes.code })
        .from(icd10Codes)
        .where(inArray(icd10Codes.code, rows.map((row) => row.code)));
      const existingCodes = new Set(existing.map((row) => row.code));
      const inserted = rows.length - existingCodes.size;

      await tx
        .insert(icd10Codes)
        .values(
          rows.map((row) => ({
            id: newId(),
            code: row.code,
            description: row.description,
            chapter: row.chapter ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: icd10Codes.code,
          set: {
            description: sql`excluded.description`,
            chapter: sql`excluded.chapter`,
          },
        });

      await writeAdminAudit(tx, {
        facilityId: values.facilityId,
        actor: values.actor,
        action: "admin.icd10.import",
        entity: "icd10_codes",
        entityId: null,
        details: { rows: rows.length, inserted, updated: existingCodes.size },
      });

      return { rows: rows.length, inserted, updated: existingCodes.size };
    },
    options,
  );
}
