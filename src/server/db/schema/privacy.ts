import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { newId } from "../../../lib/uuid";

import { patients } from "./patients";
import { auditColumns, facilities } from "./tenancy";

export const dataConsents = pgTable(
  "data_consents",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    consentType: text("consent_type").notNull(),
    consentVersion: text("consent_version").notNull(),
    consentTextHash: text("consent_text_hash"),
    granted: boolean("granted").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    grantedBy: text("granted_by"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnBy: text("withdrawn_by"),
    source: text("source"),
    documentId: uuid("document_id"),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => ({
    facilityPatientTypeVersionIdx: uniqueIndex("data_consents_facility_patient_type_version_idx").on(
      table.facilityId,
      table.patientId,
      table.consentType,
      table.consentVersion,
    ),
    facilityPatientTypeIdx: index("data_consents_facility_patient_type_idx").on(
      table.facilityId,
      table.patientId,
      table.consentType,
    ),
    facilityIdx: index("data_consents_facility_idx").on(table.facilityId),
  }),
);

export const dataSubjectRequests = pgTable(
  "data_subject_requests",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    requestType: text("request_type").notNull(),
    status: text("status").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    requestedVia: text("requested_via"),
    identityVerified: boolean("identity_verified").notNull().default(false),
    verifiedBy: text("verified_by"),
    outcome: text("outcome"),
    rejectionReason: text("rejection_reason"),
    handledBy: text("handled_by"),
    notes: text("notes"),
    ...auditColumns,
  },
  (table) => ({
    facilityStatusIdx: index("data_subject_requests_facility_status_idx").on(
      table.facilityId,
      table.status,
    ),
    facilityDueIdx: index("data_subject_requests_facility_due_idx").on(
      table.facilityId,
      table.dueAt,
    ),
    facilityPatientIdx: index("data_subject_requests_facility_patient_idx").on(
      table.facilityId,
      table.patientId,
    ),
  }),
);

export const dataBreaches = pgTable(
  "data_breaches",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    reference: text("reference").notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull(),
    containedAt: timestamp("contained_at", { withTimezone: true }),
    odpcNotifiedAt: timestamp("odpc_notified_at", { withTimezone: true }),
    affectedSubjects: integer("affected_subjects"),
    affectedRecords: integer("affected_records"),
    severity: text("severity").notNull(),
    description: text("description"),
    containment: text("containment"),
    rootCause: text("root_cause"),
    status: text("status").notNull(),
    reportedBy: text("reported_by"),
    odpcReference: text("odpc_reference"),
    ...auditColumns,
  },
  (table) => ({
    facilityReferenceIdx: uniqueIndex("data_breaches_facility_reference_idx").on(
      table.facilityId,
      table.reference,
    ),
    facilityStatusIdx: index("data_breaches_facility_status_idx").on(table.facilityId, table.status),
    facilitySeverityIdx: index("data_breaches_facility_severity_idx").on(
      table.facilityId,
      table.severity,
    ),
  }),
);

export const retentionPolicies = pgTable(
  "retention_policies",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    entity: text("entity").notNull(),
    legalBasis: text("legal_basis"),
    retentionYears: integer("retention_years"),
    triggerEvent: text("trigger_event"),
    legalHold: boolean("legal_hold").notNull().default(false),
    destroyAfter: date("destroy_after"),
    reviewAt: timestamp("review_at", { withTimezone: true }),
    ...auditColumns,
  },
  (table) => ({
    facilityEntityIdx: index("retention_policies_facility_entity_idx").on(
      table.facilityId,
      table.entity,
    ),
    facilityReviewIdx: index("retention_policies_facility_review_idx").on(
      table.facilityId,
      table.reviewAt,
    ),
  }),
);

export const dataSharingAgreements = pgTable(
  "data_sharing_agreements",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    counterparty: text("counterparty").notNull(),
    counterpartyType: text("counterparty_type"),
    purpose: text("purpose"),
    lawfulBasis: text("lawful_basis"),
    odpcReference: text("odpc_reference"),
    startedOn: date("started_on"),
    expiresOn: date("expires_on"),
    status: text("status"),
    documentId: uuid("document_id"),
    ...auditColumns,
  },
  (table) => ({
    facilityExpiryIdx: index("data_sharing_agreements_facility_expiry_idx").on(
      table.facilityId,
      table.expiresOn,
    ),
    facilityCounterpartyIdx: index("data_sharing_agreements_facility_counterparty_idx").on(
      table.facilityId,
      table.counterparty,
    ),
  }),
);

export const transferAssessments = pgTable(
  "transfer_assessments",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    transferPath: text("transfer_path"),
    destinationCountry: text("destination_country"),
    mechanism: text("mechanism"),
    lawfulBasis: text("lawful_basis"),
    assessmentDate: date("assessment_date"),
    reviewDate: date("review_date"),
    status: text("status"),
    approvedBy: text("approved_by"),
    ...auditColumns,
  },
  (table) => ({
    facilityReviewIdx: index("transfer_assessments_facility_review_idx").on(
      table.facilityId,
      table.reviewDate,
    ),
  }),
);

export const chartAccessLog = pgTable(
  "chart_access_log",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    userId: text("user_id"),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow(),
    accessType: text("access_type"),
    deviceId: text("device_id"),
    ip: text("ip"),
    reason: text("reason"),
    ...auditColumns,
  },
  (table) => ({
    facilityPatientIdx: index("chart_access_log_facility_patient_idx").on(
      table.facilityId,
      table.patientId,
      table.accessedAt,
    ),
    facilityAccessedIdx: index("chart_access_log_facility_accessed_idx").on(
      table.facilityId,
      table.accessedAt,
    ),
  }),
);
