export const ADMIN_SECTIONS = [
  "setup",
  "staff",
  "catalogs",
  "prices",
  "audit",
  "sync",
  "regulatory",
] as const;

export type AdminSection = (typeof ADMIN_SECTIONS)[number];

interface AdminSectionMeta {
  label: string;
  description: string;
  href: string;
}

export const ADMIN_SECTION_META: Record<AdminSection, AdminSectionMeta> = {
  setup: {
    label: "Facility setup",
    description: "Facilities, branches, departments, rooms and stores.",
    href: "/admin/setup",
  },
  staff: {
    label: "Staff",
    description: "Staff accounts, role scopes and administration access.",
    href: "/admin/staff",
  },
  catalogs: {
    label: "Catalogs",
    description: "Services, items, lab tests and ICD-10 codes.",
    href: "/admin/catalogs",
  },
  prices: {
    label: "Price lists",
    description: "Payer price lists and their price rows.",
    href: "/admin/prices",
  },
  audit: {
    label: "Audit",
    description: "Filterable, append-only audit activity.",
    href: "/admin/audit",
  },
  sync: {
    label: "Sync",
    description: "Outbox health, failed rows and retry controls.",
    href: "/admin/sync",
  },
  regulatory: {
    label: "Regulatory",
    description: "Licences, regulatory identifiers, readiness and statutory settings.",
    href: "/admin/regulatory",
  },
};

/** Every mutation command belongs to exactly one administration section. */
export const ADMIN_COMMAND_SECTIONS: Record<string, AdminSection> = {
  createFacility: "setup",
  updateFacility: "setup",
  setFacilityActive: "setup",
  createBranch: "setup",
  updateBranch: "setup",
  setBranchActive: "setup",
  createDepartment: "setup",
  updateDepartment: "setup",
  setDepartmentActive: "setup",
  createRoom: "setup",
  updateRoom: "setup",
  setRoomActive: "setup",
  createStore: "setup",
  updateStore: "setup",
  setStoreActive: "setup",
  createStaff: "staff",
  updateStaff: "staff",
  setStaffActive: "staff",
  changeStaffRole: "staff",
  setAdminSectionAccess: "staff",
  createItem: "catalogs",
  updateItem: "catalogs",
  setItemActive: "catalogs",
  createLabTest: "catalogs",
  updateLabTest: "catalogs",
  setLabTestActive: "catalogs",
  createService: "catalogs",
  updateService: "catalogs",
  setServiceActive: "catalogs",
  importIcd10: "catalogs",
  createPriceList: "prices",
  updatePriceList: "prices",
  setPriceListActive: "prices",
  upsertPrice: "prices",
  removePrice: "prices",
  upsertFacilityRegulatoryProfile: "regulatory",
  updateFacilityLicence: "regulatory",
  upsertPractitionerRegistration: "regulatory",
  verifyPractitionerLicence: "regulatory",
  upsertSupportServiceLicence: "regulatory",
  createLicenceAlertRule: "regulatory",
  upsertFacilitySetting: "regulatory",
  upsertStatutoryRate: "regulatory",
  upsertStatutoryFeeSchedule: "regulatory",
  upsertShaAdjudicationCode: "regulatory",
  upsertIntegrationSetting: "regulatory",
  verifyIntegrationConnection: "regulatory",
  upsertFacilityIdentifier: "regulatory",
};

export function isAdminSection(value: string): value is AdminSection {
  return (ADMIN_SECTIONS as readonly string[]).includes(value);
}

export function adminSectionForPath(pathname: string): AdminSection | null {
  const slug = pathname.replace(/\/+$/, "").split("/")[2];
  return slug && isAdminSection(slug) ? slug : null;
}
