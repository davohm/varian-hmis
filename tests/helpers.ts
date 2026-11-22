import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { newId } from "../src/lib/uuid";
import { DATABASE_URL } from "../src/server/env";
import { createDatabase } from "../src/server/db/client";
import {
  account,
  adminOverrides,
  assetApprovals,
  assetAssignments,
  assetDisposals,
  assetValuations,
  assets,
  adminSectionPermissions,
  auditLog,
  bankAccounts,
  bankReconciliations,
  bankTransactions,
  birthNotifications,
  branches,
  budgetLines,
  budgets,
  cashierSessions,
  charges,
  chartAccessLog,
  claimDenials,
  claimLines,
  claims,
  clinicalNotes,
  commandLog,
  costCenters,
  dataBreaches,
  dataConsents,
  dataSharingAgreements,
  dataSubjectRequests,
  attendanceRecords,
  deathNotifications,
  depreciationEntries,
  depreciationRunApprovals,
  depreciationRuns,
  departments,
  diagnoses,
  dispenses,
  employees,
  employmentContracts,
  encounters,
  etimsInvoiceLines,
  etimsInvoiceQueue,
  etimsOutbox,
  etimsTransmissionLog,
  facilities,
  facilityIdentifiers,
  facilityLicences,
  facilityRegulatoryProfiles,
  facilitySettings,
  facilitySyncTokens,
  financeApprovalLimits,
  fiscalPeriods,
  goodsReceiptLines,
  goodsReceipts,
  integrationSettings,
  invoices,
  itemBatches,
  items,
  journalEntries,
  journalLines,
  labOrderItems,
  labOrders,
  labResults,
  labTests,
  ledgerAccounts,
  leaveRequests,
  licenceAlertRules,
  maintenanceEvents,
  maintenanceOrders,
  nextOfKin,
  notifiableEvents,
  numberSequences,
  patients,
  payerBenefits,
  payerContracts,
  payers,
  payments,
  payrollLines,
  payrollRunApprovals,
  payrollRuns,
  payslips,
  positions,
  practitionerRegistrations,
  purchaseOrderLines,
  purchaseOrders,
  purchaseRequisitionApprovals,
  purchaseRequisitionLines,
  purchaseRequisitions,
  preAuthorizations,
  prescriptions,
  priceLists,
  prices,
  queueEntries,
  remittances,
  reorderLevels,
  reportCells,
  reportDefinitions,
  reportRuns,
  reportSavedViews,
  retentionPolicies,
  rfqLines,
  rfqs,
  rooms,
  services,
  session,
  shaAdjudicationCodes,
  shiftAssignments,
  shiftTemplates,
  statutoryFeeSchedules,
  statutoryRates,
  stockLedger,
  staffProfiles,
  staffRoleScopes,
  stores,
  supplierInvoiceLines,
  supplierInvoices,
  supplierPayments,
  supplierQuoteLines,
  supplierQuotes,
  suppliers,
  supportServiceLicences,
  syncOutbox,
  syncReceived,
  taxCodeApplicabilities,
  taxCodes,
  transferAssessments,
  triageVitals,
  user,
} from "../src/server/db/schema";

import { seedRegulatoryDefaults } from "../src/server/regulatory-seed";

export function createTestDatabase() {
  // Tests exercise local command writes, including their outbox rows. Only
  // tests that explicitly need cloud-node behaviour should open a cloud-role
  // connection.
  return createDatabase(DATABASE_URL, "clinic");
}

export type TestDatabase = ReturnType<typeof createTestDatabase>;

export async function insertTestFacility(db: TestDatabase["db"]) {
  const id = newId();
  const code = `TEST-${randomUUID().slice(0, 8).toUpperCase()}`;

  await db.insert(facilities).values({
    id,
    code,
    name: `Test Facility ${code}`,
    writeAuthority: "cloud",
    createdBy: "vitest",
  });

  // Billing is gated on the seeded §6.6 settings (invoice prefix), exactly as
  // a real install is, so every test facility gets the same defaults.
  await seedRegulatoryDefaults(db, id, { createdBy: "vitest" });

  return { id, code };
}

export async function insertTestBranch(db: TestDatabase["db"], facilityId: string) {
  const id = newId();
  await db.insert(branches).values({
    id,
    facilityId,
    code: `MAIN-${randomUUID().slice(0, 6).toUpperCase()}`,
    name: "Main Branch",
    isMain: true,
    createdBy: "vitest",
  });
  return id;
}

export async function insertTestActor(db: TestDatabase["db"]) {
  const id = newId();
  const suffix = randomUUID().slice(0, 8);
  const now = new Date();
  await db.insert(user).values({
    id,
    name: `Test Admin ${suffix}`,
    email: `admin-${suffix}@test.local`,
    emailVerified: true,
    role: "admin",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(staffProfiles).values({
    id: newId(),
    userId: id,
    staffNumber: `ADM-${suffix}`.toUpperCase(),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function deleteTestActor(db: TestDatabase["db"], userId: string) {
  await db.transaction(async (tx) => {
    await tx.delete(adminSectionPermissions).where(eq(adminSectionPermissions.userId, userId));
    await tx.delete(staffRoleScopes).where(eq(staffRoleScopes.userId, userId));
    await tx.delete(session).where(eq(session.userId, userId));
    await tx.delete(account).where(eq(account.userId, userId));
    await tx.delete(staffProfiles).where(eq(staffProfiles.userId, userId));
    await tx.delete(user).where(eq(user.id, userId));
  });
}

export async function cleanupTestFacility(db: TestDatabase["db"], facilityId: string) {
  await db.transaction(async (tx) => {
    // The stock and payment ledgers reject deletes outside test cleanup, and
    // sync capture must not recreate outbox rows for rows being torn down.
    await tx.execute(sql`SET LOCAL varian.ledger_cleanup = 'on'`);
    await tx.execute(sql`SET LOCAL varian.sync_apply = 'on'`);

    const scopedUsers = await tx
      .select({ userId: staffRoleScopes.userId })
      .from(staffRoleScopes)
      .where(eq(staffRoleScopes.facilityId, facilityId));
    const userIds = scopedUsers.map((row) => row.userId);
    await tx
      .delete(practitionerRegistrations)
      .where(eq(practitionerRegistrations.facilityId, facilityId));
    await tx.delete(adminSectionPermissions).where(eq(adminSectionPermissions.facilityId, facilityId));
    await tx.delete(staffRoleScopes).where(eq(staffRoleScopes.facilityId, facilityId));
    if (userIds.length) {
      await tx.delete(session).where(inArray(session.userId, userIds));
      await tx.delete(account).where(inArray(account.userId, userIds));
      await tx.delete(staffProfiles).where(inArray(staffProfiles.userId, userIds));
      await tx.delete(user).where(inArray(user.id, userIds));
    }
    // Reversals reference the payment they reverse, so clear them first.
    await tx
      .delete(payments)
      .where(and(eq(payments.facilityId, facilityId), isNotNull(payments.reversedPaymentId)));
    await tx.delete(claimDenials).where(eq(claimDenials.facilityId, facilityId));
    await tx.delete(remittances).where(eq(remittances.facilityId, facilityId));
    await tx.delete(claimLines).where(eq(claimLines.facilityId, facilityId));
    await tx.delete(claims).where(eq(claims.facilityId, facilityId));
    await tx.delete(preAuthorizations).where(eq(preAuthorizations.facilityId, facilityId));
    await tx.delete(payerBenefits).where(eq(payerBenefits.facilityId, facilityId));
    await tx.delete(payerContracts).where(eq(payerContracts.facilityId, facilityId));
    await tx.delete(payers).where(eq(payers.facilityId, facilityId));
    await tx.delete(bankTransactions).where(eq(bankTransactions.facilityId, facilityId));
    await tx.delete(bankReconciliations).where(eq(bankReconciliations.facilityId, facilityId));
    await tx.delete(bankAccounts).where(eq(bankAccounts.facilityId, facilityId));
    await tx.delete(journalLines).where(eq(journalLines.facilityId, facilityId));
    await tx.delete(journalEntries).where(eq(journalEntries.facilityId, facilityId));
    await tx.delete(budgetLines).where(eq(budgetLines.facilityId, facilityId));
    await tx.delete(budgets).where(eq(budgets.facilityId, facilityId));
    await tx.delete(financeApprovalLimits).where(eq(financeApprovalLimits.facilityId, facilityId));

    // Procurement documents reference each other, stock batches and journals.
    // Remove them in reverse creation order before those parents are torn down.
    await tx.delete(supplierPayments).where(eq(supplierPayments.facilityId, facilityId));
    await tx.delete(supplierInvoiceLines).where(eq(supplierInvoiceLines.facilityId, facilityId));
    await tx.delete(supplierInvoices).where(eq(supplierInvoices.facilityId, facilityId));
    await tx.delete(goodsReceiptLines).where(eq(goodsReceiptLines.facilityId, facilityId));
    await tx.delete(goodsReceipts).where(eq(goodsReceipts.facilityId, facilityId));
    await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.facilityId, facilityId));
    await tx.delete(purchaseOrders).where(eq(purchaseOrders.facilityId, facilityId));
    await tx.delete(supplierQuoteLines).where(eq(supplierQuoteLines.facilityId, facilityId));
    await tx.delete(supplierQuotes).where(eq(supplierQuotes.facilityId, facilityId));
    await tx.delete(rfqLines).where(eq(rfqLines.facilityId, facilityId));
    await tx.delete(rfqs).where(eq(rfqs.facilityId, facilityId));
    await tx
      .delete(purchaseRequisitionApprovals)
      .where(eq(purchaseRequisitionApprovals.facilityId, facilityId));
    await tx.delete(purchaseRequisitionLines).where(eq(purchaseRequisitionLines.facilityId, facilityId));
    await tx.delete(purchaseRequisitions).where(eq(purchaseRequisitions.facilityId, facilityId));
    await tx.delete(reorderLevels).where(eq(reorderLevels.facilityId, facilityId));
    await tx.delete(suppliers).where(eq(suppliers.facilityId, facilityId));

    // Asset history is append-only in normal use. Teardown removes dependants
    // first with ledger_cleanup enabled so facilities can be fully removed.
    await tx.delete(assetApprovals).where(eq(assetApprovals.facilityId, facilityId));
    await tx.delete(depreciationRunApprovals).where(
      eq(depreciationRunApprovals.facilityId, facilityId),
    );
    await tx.delete(depreciationEntries).where(eq(depreciationEntries.facilityId, facilityId));
    await tx.delete(assetAssignments).where(eq(assetAssignments.facilityId, facilityId));
    await tx.delete(maintenanceEvents).where(eq(maintenanceEvents.facilityId, facilityId));
    await tx.delete(maintenanceOrders).where(eq(maintenanceOrders.facilityId, facilityId));
    await tx.delete(assetDisposals).where(eq(assetDisposals.facilityId, facilityId));
    await tx.delete(assetValuations).where(eq(assetValuations.facilityId, facilityId));
    await tx.delete(depreciationRuns).where(eq(depreciationRuns.facilityId, facilityId));
    await tx.delete(assets).where(eq(assets.facilityId, facilityId));

    // Payroll evidence and personnel records are append-only in normal use.
    // Test teardown removes dependants first, with ledger_cleanup enabled above.
    await tx.delete(payslips).where(eq(payslips.facilityId, facilityId));
    await tx.delete(payrollRunApprovals).where(eq(payrollRunApprovals.facilityId, facilityId));
    await tx.delete(payrollLines).where(eq(payrollLines.facilityId, facilityId));
    await tx.delete(payrollRuns).where(eq(payrollRuns.facilityId, facilityId));
    await tx.delete(leaveRequests).where(eq(leaveRequests.facilityId, facilityId));
    await tx.delete(attendanceRecords).where(eq(attendanceRecords.facilityId, facilityId));
    await tx.delete(shiftAssignments).where(eq(shiftAssignments.facilityId, facilityId));
    await tx.delete(employmentContracts).where(eq(employmentContracts.facilityId, facilityId));
    await tx.delete(shiftTemplates).where(eq(shiftTemplates.facilityId, facilityId));
    await tx.delete(positions).where(eq(positions.facilityId, facilityId));
    await tx.delete(employees).where(eq(employees.facilityId, facilityId));

    await tx.delete(fiscalPeriods).where(eq(fiscalPeriods.facilityId, facilityId));
    await tx.delete(costCenters).where(eq(costCenters.facilityId, facilityId));
    await tx.delete(ledgerAccounts).where(eq(ledgerAccounts.facilityId, facilityId));
    await tx
      .delete(etimsTransmissionLog)
      .where(eq(etimsTransmissionLog.facilityId, facilityId));
    await tx.delete(etimsOutbox).where(eq(etimsOutbox.facilityId, facilityId));
    await tx.delete(etimsInvoiceLines).where(eq(etimsInvoiceLines.facilityId, facilityId));
    await tx.delete(etimsInvoiceQueue).where(eq(etimsInvoiceQueue.facilityId, facilityId));
    await tx.delete(payments).where(eq(payments.facilityId, facilityId));
    await tx.delete(charges).where(eq(charges.facilityId, facilityId));
    await tx.delete(invoices).where(eq(invoices.facilityId, facilityId));
    await tx.delete(cashierSessions).where(eq(cashierSessions.facilityId, facilityId));
    await tx
      .delete(taxCodeApplicabilities)
      .where(eq(taxCodeApplicabilities.facilityId, facilityId));
    await tx.delete(taxCodes).where(eq(taxCodes.facilityId, facilityId));
    await tx.delete(prices).where(eq(prices.facilityId, facilityId));
    await tx.delete(priceLists).where(eq(priceLists.facilityId, facilityId));
    await tx.delete(services).where(eq(services.facilityId, facilityId));
    await tx.delete(dispenses).where(eq(dispenses.facilityId, facilityId));
    await tx.delete(stockLedger).where(eq(stockLedger.facilityId, facilityId));
    await tx.delete(itemBatches).where(eq(itemBatches.facilityId, facilityId));
    await tx.delete(labResults).where(eq(labResults.facilityId, facilityId));
    await tx.delete(labOrderItems).where(eq(labOrderItems.facilityId, facilityId));
    await tx.delete(labOrders).where(eq(labOrders.facilityId, facilityId));
    await tx.delete(prescriptions).where(eq(prescriptions.facilityId, facilityId));
    await tx.delete(diagnoses).where(eq(diagnoses.facilityId, facilityId));
    await tx.delete(clinicalNotes).where(eq(clinicalNotes.facilityId, facilityId));
    await tx.delete(items).where(eq(items.facilityId, facilityId));
    await tx.delete(labTests).where(eq(labTests.facilityId, facilityId));
    await tx.delete(triageVitals).where(eq(triageVitals.facilityId, facilityId));
    await tx.delete(queueEntries).where(eq(queueEntries.facilityId, facilityId));
    await tx.delete(reportCells).where(eq(reportCells.facilityId, facilityId));
    await tx.delete(reportSavedViews).where(eq(reportSavedViews.facilityId, facilityId));
    await tx.delete(reportRuns).where(eq(reportRuns.facilityId, facilityId));
    await tx.delete(reportDefinitions).where(eq(reportDefinitions.facilityId, facilityId));
    await tx.delete(notifiableEvents).where(eq(notifiableEvents.facilityId, facilityId));
    await tx.delete(birthNotifications).where(eq(birthNotifications.facilityId, facilityId));
    await tx.delete(deathNotifications).where(eq(deathNotifications.facilityId, facilityId));
    await tx.delete(encounters).where(eq(encounters.facilityId, facilityId));
    await tx.delete(chartAccessLog).where(eq(chartAccessLog.facilityId, facilityId));
    await tx.delete(dataSubjectRequests).where(eq(dataSubjectRequests.facilityId, facilityId));
    await tx.delete(dataConsents).where(eq(dataConsents.facilityId, facilityId));
    await tx.delete(nextOfKin).where(eq(nextOfKin.facilityId, facilityId));
    await tx.delete(patients).where(eq(patients.facilityId, facilityId));
    await tx.delete(auditLog).where(eq(auditLog.facilityId, facilityId));
    await tx.delete(commandLog).where(eq(commandLog.facilityId, facilityId));
    await tx.delete(adminOverrides).where(eq(adminOverrides.facilityId, facilityId));
    await tx.delete(numberSequences).where(eq(numberSequences.facilityId, facilityId));
    await tx.delete(stores).where(eq(stores.facilityId, facilityId));
    await tx.delete(rooms).where(eq(rooms.facilityId, facilityId));
    await tx.delete(departments).where(eq(departments.facilityId, facilityId));
    await tx.delete(branches).where(eq(branches.facilityId, facilityId));
    await tx.delete(syncOutbox).where(eq(syncOutbox.facilityId, facilityId));
    await tx.delete(syncReceived).where(eq(syncReceived.facilityId, facilityId));
    await tx.execute(sql`
      DELETE FROM sync_state
      WHERE key IN (
        ${`last_pull_cursors:${facilityId}`},
        ${`last_pulled_at:${facilityId}`},
        ${`last_override_cursor:${facilityId}`}
      )
    `);
    await tx.delete(facilitySyncTokens).where(eq(facilitySyncTokens.facilityId, facilityId));
    await tx.delete(dataBreaches).where(eq(dataBreaches.facilityId, facilityId));
    await tx.delete(retentionPolicies).where(eq(retentionPolicies.facilityId, facilityId));
    await tx.delete(dataSharingAgreements).where(eq(dataSharingAgreements.facilityId, facilityId));
    await tx.delete(transferAssessments).where(eq(transferAssessments.facilityId, facilityId));
    // Licence renewals reference the licence they replace.
    await tx
      .update(facilityLicences)
      .set({ supersedesId: null })
      .where(eq(facilityLicences.facilityId, facilityId));
    await tx.delete(facilityLicences).where(eq(facilityLicences.facilityId, facilityId));
    await tx.delete(facilityIdentifiers).where(eq(facilityIdentifiers.facilityId, facilityId));
    await tx.delete(supportServiceLicences).where(eq(supportServiceLicences.facilityId, facilityId));
    await tx.delete(licenceAlertRules).where(eq(licenceAlertRules.facilityId, facilityId));
    await tx.delete(facilitySettings).where(eq(facilitySettings.facilityId, facilityId));
    await tx.delete(statutoryRates).where(eq(statutoryRates.facilityId, facilityId));
    await tx.delete(statutoryFeeSchedules).where(eq(statutoryFeeSchedules.facilityId, facilityId));
    await tx.delete(shaAdjudicationCodes).where(eq(shaAdjudicationCodes.facilityId, facilityId));
    await tx.delete(integrationSettings).where(eq(integrationSettings.facilityId, facilityId));
    await tx
      .delete(facilityRegulatoryProfiles)
      .where(eq(facilityRegulatoryProfiles.facilityId, facilityId));
    await tx.delete(facilities).where(eq(facilities.id, facilityId));
  });
}
