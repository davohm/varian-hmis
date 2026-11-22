import {
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { newId } from "../../../lib/uuid";

import { departments } from "./tenancy";
import { costCenters, journalEntries } from "./finance";
import { employees } from "./hr";
import { auditColumns, facilities } from "./tenancy";

export const assetStatusEnum = pgEnum("asset_status", [
  "in_service",
  "stored",
  "maintenance",
  "disposed",
  "written_off",
]);

export const assetAssignmentEventEnum = pgEnum("asset_assignment_event", [
  "assigned",
  "transferred",
  "returned",
]);

export const assetValuationKindEnum = pgEnum("asset_valuation_kind", [
  "revaluation",
  "impairment",
]);

export const assetProcessStatusEnum = pgEnum("asset_process_status", [
  "requested",
  "approved",
  "posted",
  "completed",
  "cancelled",
]);

export const assetApprovalSubjectEnum = pgEnum("asset_approval_subject", [
  "depreciation_run",
  "valuation",
  "disposal",
]);

export const depreciationRunStatusEnum = pgEnum("depreciation_run_status", [
  "draft",
  "approved",
  "posted",
  "cancelled",
]);

export const assetDecisionEnum = pgEnum("asset_decision", ["approved", "rejected"]);

export const maintenanceOrderStatusEnum = pgEnum("maintenance_order_status", [
  "open",
  "in_progress",
  "completed",
  "cancelled",
]);

export const maintenanceOrderTypeEnum = pgEnum("maintenance_order_type", [
  "preventive",
  "corrective",
  "inspection",
]);

export const maintenancePriorityEnum = pgEnum("maintenance_priority", [
  "low",
  "normal",
  "high",
  "urgent",
]);

export const maintenanceEventTypeEnum = pgEnum("maintenance_event_type", [
  "scheduled",
  "started",
  "completed",
  "note",
]);

export const assetPaymentMethodEnum = pgEnum("asset_payment_method", [
  "none",
  "cash",
  "bank",
  "accrued",
]);

/**
 * Asset history is never deleted. An assignment is an event: the current
 * custodian is the latest non-returned event, mirrored onto the asset row for
 * fast lists. Depreciation and valuation entries are immutable evidence.
 */
export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    assetNo: varchar("asset_no", { length: 40 }).notNull(),
    category: varchar("category", { length: 80 }).notNull(),
    name: text("name").notNull(),
    tagNo: varchar("tag_no", { length: 80 }),
    serialNo: varchar("serial_no", { length: 120 }),
    location: text("location").notNull(),
    custodianEmployeeId: uuid("custodian_employee_id").references(() => employees.id, {
      onDelete: "set null",
    }),
    custodianName: varchar("custodian_name", { length: 120 }),
    departmentId: uuid("department_id").references(() => departments.id, {
      onDelete: "set null",
    }),
    costCenterId: uuid("cost_center_id").references(() => costCenters.id, {
      onDelete: "set null",
    }),
    acquisitionDate: date("acquisition_date").notNull(),
    acquisitionCost: numeric("acquisition_cost", { precision: 14, scale: 2 }).notNull(),
    residualValue: numeric("residual_value", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    usefulLifeMonths: integer("useful_life_months").notNull(),
    accumulatedDepreciation: numeric("accumulated_depreciation", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    carryingAmount: numeric("carrying_amount", { precision: 14, scale: 2 }).notNull(),
    status: assetStatusEnum("status").notNull().default("in_service"),
    lastDepreciationDate: date("last_depreciation_date"),
    notes: text("notes"),
    ...auditColumns,
  },
  (table) => ({
    facilityAssetNoIdx: uniqueIndex("assets_facility_asset_no_idx").on(
      table.facilityId,
      table.assetNo,
    ),
    facilityTagIdx: index("assets_facility_tag_idx").on(table.facilityId, table.tagNo),
    facilityCategoryIdx: index("assets_facility_category_idx").on(
      table.facilityId,
      table.category,
    ),
    facilityStatusIdx: index("assets_facility_status_idx").on(table.facilityId, table.status),
    custodianIdx: index("assets_custodian_idx").on(table.custodianEmployeeId),
  }),
);

export const assetAssignments = pgTable(
  "asset_assignments",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "restrict" }),
    eventType: assetAssignmentEventEnum("event_type").notNull(),
    fromEmployeeId: uuid("from_employee_id").references(() => employees.id, {
      onDelete: "set null",
    }),
    toEmployeeId: uuid("to_employee_id").references(() => employees.id, {
      onDelete: "set null",
    }),
    fromLocation: text("from_location"),
    toLocation: text("to_location").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    performedBy: text("performed_by").notNull(),
    note: text("note"),
    ...auditColumns,
  },
  (table) => ({
    assetOccurredIdx: index("asset_assignments_asset_occurred_idx").on(
      table.assetId,
      table.occurredAt,
    ),
    facilityIdx: index("asset_assignments_facility_idx").on(table.facilityId),
  }),
);

export const depreciationRuns = pgTable(
  "depreciation_runs",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    runNo: varchar("run_no", { length: 40 }).notNull(),
    period: date("period").notNull(),
    description: text("description"),
    status: depreciationRunStatusEnum("status").notNull().default("draft"),
    totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).notNull(),
    assetCount: integer("asset_count").notNull(),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, {
      onDelete: "set null",
    }),
    preparedBy: text("prepared_by").notNull(),
    approvedBy: text("approved_by"),
    postedBy: text("posted_by"),
    ...auditColumns,
  },
  (table) => ({
    facilityRunNoIdx: uniqueIndex("depreciation_runs_facility_run_no_idx").on(
      table.facilityId,
      table.runNo,
    ),
    facilityPeriodIdx: index("depreciation_runs_facility_period_idx").on(
      table.facilityId,
      table.period,
    ),
  }),
);

export const depreciationEntries = pgTable(
  "depreciation_entries",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => depreciationRuns.id, { onDelete: "restrict" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "restrict" }),
    period: date("period").notNull(),
    openingCarryingAmount: numeric("opening_carrying_amount", {
      precision: 14,
      scale: 2,
    }).notNull(),
    depreciationAmount: numeric("depreciation_amount", { precision: 14, scale: 2 }).notNull(),
    closingCarryingAmount: numeric("closing_carrying_amount", {
      precision: 14,
      scale: 2,
    }).notNull(),
    usefulLifeMonths: integer("useful_life_months").notNull(),
    costCenterId: uuid("cost_center_id").references(() => costCenters.id, {
      onDelete: "set null",
    }),
    ...auditColumns,
  },
  (table) => ({
    runAssetIdx: uniqueIndex("depreciation_entries_run_asset_idx").on(
      table.runId,
      table.assetId,
    ),
    facilityPeriodIdx: index("depreciation_entries_facility_period_idx").on(
      table.facilityId,
      table.period,
    ),
  }),
);

export const depreciationRunApprovals = pgTable(
  "depreciation_run_approvals",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => depreciationRuns.id, { onDelete: "restrict" }),
    decision: assetDecisionEnum("decision").notNull(),
    actorId: text("actor_id").notNull(),
    role: varchar("role", { length: 32 }).notNull(),
    maxAmount: numeric("max_amount", { precision: 14, scale: 2 }).notNull(),
    reason: text("reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (table) => ({
    runIdx: index("depreciation_run_approvals_run_idx").on(table.runId),
    facilityIdx: index("depreciation_run_approvals_facility_idx").on(table.facilityId),
  }),
);

export const maintenanceOrders = pgTable(
  "maintenance_orders",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "restrict" }),
    orderNo: varchar("order_no", { length: 40 }).notNull(),
    type: maintenanceOrderTypeEnum("type").notNull(),
    priority: maintenancePriorityEnum("priority").notNull().default("normal"),
    status: maintenanceOrderStatusEnum("status").notNull().default("open"),
    scheduledDate: date("scheduled_date"),
    requestedBy: text("requested_by").notNull(),
    assignedToEmployeeId: uuid("assigned_to_employee_id").references(() => employees.id, {
      onDelete: "set null",
    }),
    vendorName: varchar("vendor_name", { length: 160 }),
    description: text("description").notNull(),
    partsCost: numeric("parts_cost", { precision: 14, scale: 2 }).notNull().default("0"),
    laborCost: numeric("labor_cost", { precision: 14, scale: 2 }).notNull().default("0"),
    totalCost: numeric("total_cost", { precision: 14, scale: 2 }).notNull().default("0"),
    paymentMethod: assetPaymentMethodEnum("payment_method").notNull().default("none"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => ({
    facilityOrderNoIdx: uniqueIndex("maintenance_orders_facility_order_no_idx").on(
      table.facilityId,
      table.orderNo,
    ),
    assetIdx: index("maintenance_orders_asset_idx").on(table.assetId),
    facilityStatusIdx: index("maintenance_orders_facility_status_idx").on(
      table.facilityId,
      table.status,
    ),
    scheduledIdx: index("maintenance_orders_scheduled_idx").on(
      table.facilityId,
      table.scheduledDate,
    ),
  }),
);

export const maintenanceEvents = pgTable(
  "maintenance_events",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "restrict" }),
    orderId: uuid("order_id").references(() => maintenanceOrders.id, {
      onDelete: "set null",
    }),
    eventType: maintenanceEventTypeEnum("event_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    description: text("description").notNull(),
    partsUsed: text("parts_used"),
    cost: numeric("cost", { precision: 14, scale: 2 }).notNull().default("0"),
    performedBy: text("performed_by").notNull(),
    ...auditColumns,
  },
  (table) => ({
    assetOccurredIdx: index("maintenance_events_asset_occurred_idx").on(
      table.assetId,
      table.occurredAt,
    ),
    orderIdx: index("maintenance_events_order_idx").on(table.orderId),
    facilityIdx: index("maintenance_events_facility_idx").on(table.facilityId),
  }),
);

export const assetValuations = pgTable(
  "asset_valuations",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "restrict" }),
    valuationNo: varchar("valuation_no", { length: 40 }).notNull(),
    kind: assetValuationKindEnum("kind").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    carryingBefore: numeric("carrying_before", { precision: 14, scale: 2 }).notNull(),
    carryingAfter: numeric("carrying_after", { precision: 14, scale: 2 }).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    reason: text("reason").notNull(),
    status: assetProcessStatusEnum("status").notNull().default("requested"),
    requestedBy: text("requested_by").notNull(),
    approvedBy: text("approved_by"),
    postedBy: text("posted_by"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, {
      onDelete: "set null",
    }),
    ...auditColumns,
  },
  (table) => ({
    facilityValuationNoIdx: uniqueIndex("asset_valuations_facility_valuation_no_idx").on(
      table.facilityId,
      table.valuationNo,
    ),
    assetIdx: index("asset_valuations_asset_idx").on(table.assetId),
    facilityStatusIdx: index("asset_valuations_facility_status_idx").on(
      table.facilityId,
      table.status,
    ),
  }),
);

export const assetDisposals = pgTable(
  "asset_disposals",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "restrict" }),
    disposalNo: varchar("disposal_no", { length: 40 }).notNull(),
    method: varchar("method", { length: 32 }).notNull(),
    disposalDate: date("disposal_date").notNull(),
    proceeds: numeric("proceeds", { precision: 14, scale: 2 }).notNull().default("0"),
    proceedsMethod: assetPaymentMethodEnum("proceeds_method").notNull().default("cash"),
    carryingAmount: numeric("carrying_amount", { precision: 14, scale: 2 }).notNull(),
    gainLoss: numeric("gain_loss", { precision: 14, scale: 2 }).notNull(),
    reason: text("reason").notNull(),
    status: assetProcessStatusEnum("status").notNull().default("requested"),
    requestedBy: text("requested_by").notNull(),
    approvedBy: text("approved_by"),
    completedBy: text("completed_by"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id, {
      onDelete: "set null",
    }),
    ...auditColumns,
  },
  (table) => ({
    facilityDisposalNoIdx: uniqueIndex("asset_disposals_facility_disposal_no_idx").on(
      table.facilityId,
      table.disposalNo,
    ),
    assetIdx: index("asset_disposals_asset_idx").on(table.assetId),
    facilityStatusIdx: index("asset_disposals_facility_status_idx").on(
      table.facilityId,
      table.status,
    ),
  }),
);

export const assetApprovals = pgTable(
  "asset_approvals",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    subjectType: assetApprovalSubjectEnum("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    decision: assetDecisionEnum("decision").notNull(),
    actorId: text("actor_id").notNull(),
    role: varchar("role", { length: 32 }).notNull(),
    maxAmount: numeric("max_amount", { precision: 14, scale: 2 }).notNull(),
    reason: text("reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns,
  },
  (table) => ({
    subjectIdx: index("asset_approvals_subject_idx").on(table.subjectType, table.subjectId),
    facilityIdx: index("asset_approvals_facility_idx").on(table.facilityId),
  }),
);

export const assetTables = [
  assets,
  assetAssignments,
  depreciationRuns,
  depreciationEntries,
  depreciationRunApprovals,
  maintenanceOrders,
  maintenanceEvents,
  assetValuations,
  assetDisposals,
  assetApprovals,
] as const;
