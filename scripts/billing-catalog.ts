/**
 * Shared billing-catalog defaults for HQ seeding and branch provisioning.
 *
 * Global services/items are seeded once on HQ. Price lists and prices are
 * facility-scoped, so each branch needs its own rows on HQ; the branch then
 * pulls them with the rest of the inbound catalog. Keeping this in one place
 * ensures branch prices reference the same HQ row ids as HQ prices.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";

import { fromCents, toCents } from "../src/lib/billing";
import { newId } from "../src/lib/uuid";
import { createDatabase } from "../src/server/db/client";
import { items, priceLists, prices, services } from "../src/server/db/schema";

type Db = ReturnType<typeof createDatabase>["db"];

export type SeedPayerType = "cash" | "sha" | "insurance";

export const PAYER_TYPES: SeedPayerType[] = ["cash", "sha", "insurance"];

/** Negotiated lists sit above the cash counter price by payer. */
const PAYER_MARKUP: Record<SeedPayerType, number> = {
  cash: 1,
  sha: 1.1,
  insurance: 1.25,
};

/** Cash price per dispensing unit, keyed by the item code. */
export const DRUG_PRICES: Record<string, string> = {
  PARA500: "2.00",
  PARA120: "150.00",
  IBU400: "3.00",
  DICLO50: "3.00",
  AMOX500: "5.00",
  AMOXCLAV625: "25.00",
  AZITH500: "30.00",
  CIPRO500: "8.00",
  METRO400: "3.00",
  COTRIM960: "3.00",
  DOXY100: "4.00",
  CETIR10: "2.00",
  LORA10: "2.00",
  OMEP20: "5.00",
  RANT150: "3.00",
  METFORMIN500: "3.00",
  GLIB5: "3.00",
  AMLOD5: "4.00",
  LISIN10: "4.00",
  HCTZ25: "3.00",
  ATEN50: "3.00",
  SALB100: "450.00",
  PRED5: "3.00",
  ARTEM20: "10.00",
  QUIN300: "8.00",
  ORS: "50.00",
  ZINC20: "3.00",
  FERR200: "3.00",
  FOLIC5: "2.00",
  VITC100: "2.00",
  HYDRO25: "120.00",
  CLOTRI1: "120.00",
  GENTA01: "150.00",
  NSALINE: "120.00",
  RINGER: "140.00",
  TRAMA50: "6.00",
  DIAZ5: "3.00",
  AMIT25: "3.00",
  FLUOX20: "6.00",
  CARBAM200: "5.00",
};

export function payerPrice(base: string, payer: SeedPayerType): string {
  return fromCents(Math.round(toCents(base) * PAYER_MARKUP[payer]));
}

/**
 * Create the three payer price lists for a facility and price every global
 * service and drug. Existing prices are never overwritten so a negotiated
 * price survives a re-seed or a re-run of branch provisioning.
 */
export async function upsertFacilityPrices(db: Db, facilityId: string) {
  const serviceRows = await db
    .select({ id: services.id, code: services.code, defaultPrice: services.defaultPrice })
    .from(services)
    .where(isNull(services.facilityId));

  const itemRows = await db
    .select({ id: items.id, code: items.code })
    .from(items)
    .where(and(isNull(items.facilityId), inArray(items.code, Object.keys(DRUG_PRICES))));

  const priceListIds = new Map<SeedPayerType, string>();
  for (const payer of PAYER_TYPES) {
    const [row] = await db
      .insert(priceLists)
      .values({
        id: newId(),
        facilityId,
        name: `${payer === "cash" ? "Cash" : payer === "sha" ? "SHA" : "Insurance"} price list`,
        payerType: payer,
        createdBy: "seed",
      })
      .onConflictDoUpdate({
        target: [priceLists.facilityId, priceLists.payerType],
        set: { active: true, updatedAt: new Date() },
      })
      .returning({ id: priceLists.id });
    priceListIds.set(payer, row.id);
  }

  const existingPrices = await db
    .select({ priceListId: prices.priceListId, serviceId: prices.serviceId, itemId: prices.itemId })
    .from(prices)
    .where(eq(prices.facilityId, facilityId));
  const knownPrices = new Set(
    existingPrices.map((row) => `${row.priceListId}:${row.serviceId ?? row.itemId}`),
  );

  const pending: Array<{
    id: string;
    facilityId: string;
    priceListId: string;
    serviceId: string | null;
    itemId: string | null;
    amount: string;
    createdBy: string;
  }> = [];

  for (const payer of PAYER_TYPES) {
    const priceListId = priceListIds.get(payer);
    if (!priceListId) continue;

    for (const service of serviceRows) {
      if (knownPrices.has(`${priceListId}:${service.id}`)) continue;
      pending.push({
        id: newId(),
        facilityId,
        priceListId,
        serviceId: service.id,
        itemId: null,
        amount: payerPrice(service.defaultPrice, payer),
        createdBy: "seed",
      });
    }

    for (const item of itemRows) {
      if (knownPrices.has(`${priceListId}:${item.id}`)) continue;
      pending.push({
        id: newId(),
        facilityId,
        priceListId,
        serviceId: null,
        itemId: item.id,
        amount: payerPrice(DRUG_PRICES[item.code] ?? "5.00", payer),
        createdBy: "seed",
      });
    }
  }

  for (let index = 0; index < pending.length; index += 200) {
    await db.insert(prices).values(pending.slice(index, index + 200));
  }

  return {
    services: serviceRows.length,
    priceLists: priceListIds.size,
    prices: pending.length,
  };
}
