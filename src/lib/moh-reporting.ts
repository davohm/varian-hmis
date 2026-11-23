import { computeReportChecksum, daysInMonth, pad2, type ChecksumCell } from "./reporting";

export const MOH_REPORT_CODES = ["MOH705A", "MOH705B", "MOH717", "MOH505", "MOH710A", "MOH710B", "MOH416", "MOH735"] as const;
export type MohReportCode = (typeof MOH_REPORT_CODES)[number];
export function isMohReportCode(value: string): value is MohReportCode {
  return (MOH_REPORT_CODES as readonly string[]).includes(value);
}

export interface MohCell {
  section?: string | null;
  rowCode?: string | null;
  rowLabel?: string | null;
  colKey?: string | null;
  colLabel?: string | null;
  valueNumeric?: string | number | null;
  valueText?: string | null;
  sortOrder: number;
  isTotal?: boolean;
  sourceQuery?: string | null;
}

export interface MohReportTemplate {
  reportCode: MohReportCode;
  sections: Array<{ key: string; label: string; rows: Array<{ rowCode: string; rowLabel: string; isTotal?: boolean; formula?: string }>; columns: Array<{ colKey: string; colLabel: string }> }>;
}

/** Controlled antigen vocabulary shared by the 710A dose grid and 710B movement ledger. */
export const MOH710B_ANTIGENS = ["BCG", "OPV", "IPV", "DPT+HIB+HEPB", "Pneumococcal", "Rota", "Vitamin A", "Yellow Fever", "Measles", "Tetanus toxoid"] as const;

const IMMUNIZATION_DOSE_ALIASES: Record<string, string> = {
  bcg: "BCG",
  opv0: "OPV0", "opv at birth": "OPV0", "opv birth": "OPV0", "opv within two weeks": "OPV0",
  ipv: "IPV", "ipv given with opv3": "IPV",
  vita: "VITA", "vitamin a": "VITA",
  yf: "YF", "yellow fever": "YF",
};

for (let n = 1; n <= 3; n++) {
  IMMUNIZATION_DOSE_ALIASES[`opv${n}`] = `OPV${n}`;
  IMMUNIZATION_DOSE_ALIASES[`penta${n}`] = `PENTA${n}`;
  IMMUNIZATION_DOSE_ALIASES[`dpt hib hepb${n}`] = `PENTA${n}`;
  IMMUNIZATION_DOSE_ALIASES[`dpt${n}`] = `PENTA${n}`;
  IMMUNIZATION_DOSE_ALIASES[`pcv${n}`] = `PCV${n}`;
  IMMUNIZATION_DOSE_ALIASES[`pneumococcal${n}`] = `PCV${n}`;
  IMMUNIZATION_DOSE_ALIASES[`rota${n}`] = `ROTA${n}`;
}
for (let n = 1; n <= 2; n++) {
  IMMUNIZATION_DOSE_ALIASES[`mr${n}`] = `MR${n}`;
  IMMUNIZATION_DOSE_ALIASES[`measles${n}`] = `MR${n}`;
}
for (let n = 1; n <= 5; n++) IMMUNIZATION_DOSE_ALIASES[`tt${n}`] = `TT${n}`;

function normalizeText(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, " ").replace(/[^a-z0-9+]/g, " ").replace(/\s+/g, " ").trim();
}

/** Map an operational immunisation code/name to a MOH 710A row code. */
export function normalizeImmunizationDoseCode(value: string | null | undefined): string | null {
  const raw = normalizeText(value);
  if (!raw) return null;
  const key = raw.replace(/\+/g, " ").replace(/\s+/g, " ").trim();
  if (IMMUNIZATION_DOSE_ALIASES[key]) return IMMUNIZATION_DOSE_ALIASES[key];
  if (/\bbcg\b/.test(key)) return "BCG";
  if (/\bipv\b/.test(key)) return "IPV";
  if (/\bopv\b/.test(key)) {
    const n = key.match(/\bopv\s*([0-3])\b/)?.[1];
    return `OPV${n ?? "0"}`;
  }
  if (/\bpenta\b|\bdpt\b|\bhib\b|\bhepb\b/.test(key)) {
    const n = key.match(/([1-3])/)?.[1] ?? "1";
    return `PENTA${n}`;
  }
  if (/\bpcv\b|pneumococcal/.test(key)) {
    const n = key.match(/([1-3])/)?.[1] ?? "1";
    return `PCV${n}`;
  }
  if (/\brota\b/.test(key)) {
    const n = key.match(/([1-3])/)?.[1] ?? "1";
    return `ROTA${n}`;
  }
  if (/vitamin\s*a|\bvita\b/.test(key)) return "VITA";
  if (/yellow\s*fever|\byf\b/.test(key)) return "YF";
  if (/measles|\bmr\b/.test(key)) {
    const n = key.match(/([1-3])/)?.[1] ?? "1";
    return `MR${n}`;
  }
  if (/tetanus|\btt\b/.test(key)) {
    const n = key.match(/([1-5])/)?.[1] ?? "1";
    return `TT${n}`;
  }
  return null;
}

/** Map an operational antigen/item to a MOH 710B antigen row family. */
export function normalizeMoh710BAntigen(value: string | null | undefined): string | null {
  const dose = normalizeImmunizationDoseCode(value);
  if (dose === "BCG") return "BCG";
  if (dose?.startsWith("OPV")) return "OPV";
  if (dose === "IPV") return "IPV";
  if (dose?.startsWith("PENTA")) return "DPT+HIB+HEPB";
  if (dose?.startsWith("PCV")) return "Pneumococcal";
  if (dose?.startsWith("ROTA")) return "Rota";
  if (dose === "VITA") return "Vitamin A";
  if (dose === "YF") return "Yellow Fever";
  if (dose?.startsWith("MR")) return "Measles";
  if (dose?.startsWith("TT")) return "Tetanus toxoid";
  const raw = normalizeText(value);
  if (/\bbcg\b/.test(raw)) return "BCG";
  if (/\bopv\b/.test(raw)) return "OPV";
  if (/\bipv\b/.test(raw)) return "IPV";
  if (/penta|\bdpt\b|\bhib\b|\bhepb\b/.test(raw)) return "DPT+HIB+HEPB";
  if (/pneumococcal|\bpcv\b/.test(raw)) return "Pneumococcal";
  if (/\brota\b/.test(raw)) return "Rota";
  if (/vitamin\s*a|\bvita\b/.test(raw)) return "Vitamin A";
  if (/yellow\s*fever|\byf\b/.test(raw)) return "Yellow Fever";
  if (/measles|\bmr\b/.test(raw)) return "Measles";
  if (/tetanus|\btt\b/.test(raw)) return "Tetanus toxoid";
  return null;
}

export const EYE_DIAGNOSIS_ROW_CODES = ["normal_eye", "amblyopia", "aphakia", "cataract", "cvi", "chalazion", "conj_growth", "conj_allergic", "conj_bacterial", "conj_fungal", "conj_viral", "corneal_scar", "corneal_ulcer", "corneal_fb", "glaucoma", "refractive", "uveitis", "other"] as const;

const EYE_DIAGNOSIS_ALIASES: Record<string, string> = {
  normal: "normal_eye", "normal eye": "normal_eye",
  cvi: "cvi", "cerebral visual impairment": "cvi",
  "conjunctival growths": "conj_growth", "conj growth": "conj_growth",
  "corneal scar injury or infection": "corneal_scar", "corneal scar": "corneal_scar",
  "corneal conjunctival fb": "corneal_fb", "corneal fb": "corneal_fb", "foreign body": "corneal_fb",
  "refractive error": "refractive", "other eye conditions": "other",
};

/** Map an operational eye diagnosis code/name to a MOH 735 diagnosis row. */
export function normalizeEyeDiagnosisCode(value: string | null | undefined): string | null {
  const raw = normalizeText(value);
  if (!raw) return null;
  if (EYE_DIAGNOSIS_ALIASES[raw]) return EYE_DIAGNOSIS_ALIASES[raw]!;
  if ((EYE_DIAGNOSIS_ROW_CODES as readonly string[]).includes(raw)) return raw;
  const match = [
    ["amblyopia", "amblyopia"], ["aphakia", "aphakia"], ["cataract", "cataract"], ["chalazion", "chalazion"],
    ["allergic", "conj_allergic"], ["bacterial", "conj_bacterial"], ["fungal", "conj_fungal"], ["viral", "conj_viral"],
    ["conjunctiv", "conj_viral"], ["ulcer", "corneal_ulcer"], ["glaucoma", "glaucoma"],
    ["refractive", "refractive"], ["uveitis", "uveitis"],
  ].find(([needle]) => raw.includes(needle));
  return match?.[1] ?? "other";
}

export function normalizeEyeVisualAcuity(value: string | null | undefined): "normal" | "low_vision" | "blind" | null {
  const raw = normalizeText(value);
  if (!raw) return null;
  if (/^(normal|6\/6|6\/6 6\/18|6 18)$/.test(raw) || raw.includes("normal")) return "normal";
  if (/low vision|low|6 18 3 60|3 60/.test(raw)) return "low_vision";
  if (/blind|npl|3 60 npl|no perception/.test(raw)) return "blind";
  return null;
}

export function eyeAgeBand(age: number): "lt5" | "5_15" | "ge16" {
  if (age < 5) return "lt5";
  if (age < 16) return "5_15";
  return "ge16";
}

export function monthDayColumns(year: number, month: number): Array<{ colKey: string; colLabel: string }> {
  const days = daysInMonth(year, month);
  const cols: Array<{ colKey: string; colLabel: string }> = [];
  for (let d = 1; d <= days; d++) cols.push({ colKey: `d${pad2(d)}`, colLabel: pad2(d) });
  cols.push({ colKey: "total", colLabel: "Total" });
  return cols;
}

const DISEASE_ROWS_705A: Array<[string, string]> = [
  ["1", "Diarrhoea with no dehydration"],
  ["2", "Diarrhoea with some dehydration"],
  ["3", "Diarrhoea with severe dehydration"],
  ["4", "Cholera"],
  ["5", "Dysentery (bloody diarrhoea)"],
  ["6", "Gastroenteritis"],
  ["7", "Pneumonia"],
  ["8", "Severe pneumonia"],
  ["9", "Upper respiratory tract infections"],
  ["10", "Lower respiratory tract infections"],
  ["11", "Asthma"],
  ["12", "Presumed tuberculosis"],
  ["13", "Suspected malaria"],
  ["14", "Tested for malaria"],
  ["15", "Confirmed malaria"],
  ["16", "Ear infection"],
  ["17", "Malnutrition"],
  ["18", "Anaemia"],
  ["19", "Meningococcal meningitis"],
  ["20", "Other meningitis"],
  ["21", "Neonatal sepsis"],
  ["22", "Measles"],
  ["23", "Tetanus"],
  ["24", "Other notifiable conditions"],
  ["25", "All other diseases"],
  ["99", "TOTAL"],
];

const DISEASE_ROWS_705B: Array<[string, string]> = [
  ["1", "Diarrhoea"],
  ["2", "Tuberculosis"],
  ["3", "Dysentery/bloody diarrhoea"],
  ["4", "Cholera"],
  ["5", "Meningococcal meningitis"],
  ["6", "Other meningitis"],
  ["7", "Tetanus"],
  ["8", "Poliomyelitis (AFP)"],
  ["9", "Chicken pox"],
  ["10", "Measles"],
  ["11", "Hepatitis"],
  ["12", "Mumps"],
  ["13", "Suspected malaria"],
  ["14", "Confirmed malaria"],
  ["15", "Malaria in pregnancy"],
  ["16", "Amoebiasis"],
  ["17", "Typhoid fever"],
  ["18", "Sexually transmitted infections"],
  ["19", "Urinary tract infections"],
  ["20", "Bilharzia (schistosomiasis)"],
  ["21", "Intestinal worms"],
  ["22", "Malnutrition"],
  ["23", "Anaemia"],
  ["24", "Eye infections/conditions"],
  ["25", "Ear infections/conditions"],
  ["26", "Upper respiratory tract infections"],
  ["27", "Asthma"],
  ["28", "Pneumonia"],
  ["29", "Other lower respiratory tract infections"],
  ["30", "Abortion"],
  ["31", "Dis. of puerperium & childbirth"],
  ["32", "Hypertension"],
  ["33", "Mental disorders"],
  ["34", "Dental disorders"],
  ["35", "Jiggers infestation"],
  ["36", "Diseases of the skin"],
  ["37", "Arthritis, joint pains etc"],
  ["38", "Poisoning"],
  ["39", "Road traffic injuries"],
  ["40", "Death due to road traffic injuries"],
  ["41", "Other injuries"],
  ["42", "Sexual violence"],
  ["43", "Violence related injuries"],
  ["44", "Burns"],
  ["45", "Snake bite"],
  ["46", "Dog bite"],
  ["47", "Diabetes"],
  ["48", "Epilepsy"],
  ["49", "Other convulsive disorders"],
  ["50", "Rheumatic fever"],
  ["51", "Brucellosis"],
  ["52", "Rickets"],
  ["53", "Cerebral palsy"],
  ["54", "Other"],
  ["99", "TOTAL"],
];

export function moh705ATemplate(year: number, month: number): MohReportTemplate {
  return { reportCode: "MOH705A", sections: [{ key: "A", label: "Under-5 daily outpatient morbidity", columns: monthDayColumns(year, month), rows: DISEASE_ROWS_705A.map(([rowCode, rowLabel]) => ({ rowCode, rowLabel, isTotal: rowCode === "99" })) }] };
}
export function moh705BTemplate(year: number, month: number): MohReportTemplate {
  return { reportCode: "MOH705B", sections: [{ key: "A", label: "Over-5 daily outpatient morbidity", columns: monthDayColumns(year, month), rows: DISEASE_ROWS_705B.map(([rowCode, rowLabel]) => ({ rowCode, rowLabel, isTotal: rowCode === "99" })) }] };
}

export function moh717Template(): MohReportTemplate {
  const cols = [{ colKey: "new", colLabel: "NEW" }, { colKey: "re_att", colLabel: "RE-ATTENDANCE" }, { colKey: "total", colLabel: "TOTAL" }];
  return {
    reportCode: "MOH717",
    sections: [
      { key: "A1", label: "A.1 General outpatients", columns: cols, rows: [
        { rowCode: "A.1.1", rowLabel: "Over 5 Male" },
        { rowCode: "A.1.2", rowLabel: "Over 5 Female" },
        { rowCode: "A.1.3", rowLabel: "Children Under 5 Male" },
        { rowCode: "A.1.4", rowLabel: "Children Under 5 Female" },
        { rowCode: "A.1.5T", rowLabel: "Total general outpatients", isTotal: true, formula: "A.1.1+A.1.2+A.1.3+A.1.4" },
        { rowCode: "A.1.60", rowLabel: "Over 60 Years" },
      ]},
      { key: "A2", label: "A.2 Casualty", columns: cols, rows: [{ rowCode: "A.2.1", rowLabel: "Casualty" }] },
      { key: "A3", label: "A.3 Specialty clinics", columns: cols, rows: [
        { rowCode: "A.3.0", rowLabel: "Direct service patients" },
        { rowCode: "A.3.1", rowLabel: "CCC" },
        { rowCode: "A.3.2", rowLabel: "Chest clinic" },
        { rowCode: "A.3.3", rowLabel: "Dental clinic" },
        { rowCode: "A.3.4", rowLabel: "Dermatology special clinic" },
        { rowCode: "A.3.5", rowLabel: "Diabetic clinic" },
        { rowCode: "A.3.6", rowLabel: "ENT consultation" },
        { rowCode: "A.3.7", rowLabel: "Eye consultation" },
        { rowCode: "A.3.8", rowLabel: "Gynaecology clinic" },
        { rowCode: "A.3.9", rowLabel: "Maternity" },
        { rowCode: "A.3.10", rowLabel: "Minor theatre" },
        { rowCode: "A.3.11", rowLabel: "MOPC clinic" },
        { rowCode: "A.3.12", rowLabel: "Nutrition" },
      ]},
      { key: "B", label: "B. Births and deaths", columns: cols, rows: [
        { rowCode: "B.1", rowLabel: "Birth notifications" },
        { rowCode: "B.2", rowLabel: "Death notifications" },
      ]},
    ],
  };
}

export function moh505Template(): MohReportTemplate {
  const cols = [
    { colKey: "lt5_cases", colLabel: "<5 Years Cases" }, { colKey: "lt5_deaths", colLabel: "<5 Years Deaths" },
    { colKey: "ge5_cases", colLabel: ">=5 Years Cases" }, { colKey: "ge5_deaths", colLabel: ">=5 Years Deaths" },
    { colKey: "total_cases", colLabel: "Total Cases" }, { colKey: "total_deaths", colLabel: "Total Deaths" },
  ];
  const left: Array<[string, string]> = [
    ["AJ", "Acute Jaundice"], ["AM", "Acute Malnutrition"], ["AEFI", "AEFI*"], ["AFP", "AFP (Poliomyelitis)"],
    ["ANT", "Anthrax"], ["CHOL", "Cholera"], ["DENG", "Dengue"], ["DYS", "Dysentery (Bacillary)"],
    ["GWD", "Guinea Worm Disease (Dracunculiasis)"], ["MAL", "Malaria"], ["MATD", "Maternal Deaths"], ["MEA", "Measles"],
  ];
  const right: Array<[string, string]> = [
    ["NEOD", "Neonatal deaths"], ["NNT", "Neonatal Tetanus"], ["OTH", "Others (Specify)"], ["PLG", "Plague"],
    ["RAB", "Rabies"], ["RVF", "Rift Valley Fever"], ["SARI", "SARI (Cluster >=3 cases)"], ["MDRTB", "Suspected MDR/XDR TB"],
    ["TYP", "Typhoid"], ["VHF", "VHF***"], ["YF", "Yellow Fever"],
  ];
  const labCols = [
    { colKey: "lt5_tested", colLabel: "<5 Tested" }, { colKey: "lt5_pos", colLabel: "<5 +ve" },
    { colKey: "ge5_tested", colLabel: ">=5 Tested" }, { colKey: "ge5_pos", colLabel: ">=5 +ve" },
    { colKey: "total_tested", colLabel: "Total Tested" }, { colKey: "total_pos", colLabel: "Total +ve" },
  ];
  return {
    reportCode: "MOH505",
    sections: [
      { key: "LEFT", label: "IDSR Weekly - Left", columns: cols, rows: left.map(([c, l]) => ({ rowCode: c, rowLabel: l })) },
      { key: "RIGHT", label: "IDSR Weekly - Right", columns: cols, rows: right.map(([c, l]) => ({ rowCode: c, rowLabel: l })) },
      { key: "LAB", label: "Laboratory", columns: labCols, rows: [
        { rowCode: "L_MAL", rowLabel: "Malaria" }, { rowCode: "L_SHIG", rowLabel: "Shigella Dysentery" },
        { rowCode: "L_TB", rowLabel: "Tuberculosis (MDR/XDR)" }, { rowCode: "L_TYP", rowLabel: "Typhoid" },
      ]},
    ],
  };
}

export function moh710ATemplate(year: number, month: number): MohReportTemplate {
  const rows: Array<[string, string]> = [
    ["BCG", "BCG"], ["OPV0", "OPV (within two weeks)"], ["OPV1", "OPV1"], ["OPV2", "OPV2"], ["OPV3", "OPV3"],
    ["IPV", "IPV (given with OPV3)"], ["PENTA1", "DPT+HIB+HEPB1"], ["PENTA2", "DPT+HIB+HEPB2"], ["PENTA3", "DPT+HIB+HEPB3"],
    ["PCV1", "Pneumococcal1"], ["PCV2", "Pneumococcal2"], ["PCV3", "Pneumococcal3"], ["ROTA1", "Rota1"], ["ROTA2", "Rota2"],
    ["VITA", "Vitamin A"], ["YF", "Yellow Fever"], ["MR1", "Measles1"], ["MR2", "Measles2"],
    ["TT1", "Tetanus toxoid TT1"], ["TT2", "Tetanus toxoid TT2"], ["TT3", "Tetanus toxoid TT3"], ["TT4", "Tetanus toxoid TT4"], ["TT5", "Tetanus toxoid TT5"],
  ];
  return { reportCode: "MOH710A", sections: [{ key: "A", label: "EPI coverage", columns: monthDayColumns(year, month), rows: rows.map(([rowCode, rowLabel]) => ({ rowCode, rowLabel })) }] };
}

export function moh710BTemplate(): MohReportTemplate {
  const antigens = MOH710B_ANTIGENS;
  const rows = antigens.flatMap((ag) => [
    { rowCode: `${ag}:A`, rowLabel: `${ag} - [A] Doses in stock at beginning of month` },
    { rowCode: `${ag}:B`, rowLabel: `${ag} - [B] Doses received within the month` },
    { rowCode: `${ag}:C`, rowLabel: `${ag} - [C] Total doses stocked (A+B)`, isTotal: true, formula: "A+B" },
    { rowCode: `${ag}:D`, rowLabel: `${ag} - [D] Doses remaining at end of month` },
    { rowCode: `${ag}:E`, rowLabel: `${ag} - [E] Doses used in the month` },
    { rowCode: `${ag}:F`, rowLabel: `${ag} - [F] No. of children vaccinated` },
    { rowCode: `${ag}:G`, rowLabel: `${ag} - [G] Doses wasted in the month` },
    { rowCode: `${ag}:H`, rowLabel: `${ag} - [H] Wastage rate in the month`, isTotal: true, formula: "G/E" },
  ]);
  return { reportCode: "MOH710B", sections: [{ key: "A", label: "Antigen movement and wastage", columns: [{ colKey: "value", colLabel: "Value" }], rows }] };
}

export function moh416Template(): MohReportTemplate {
  return {
    reportCode: "MOH416",
    sections: [
      { key: "REGISTER", label: "Eye clinic register", columns: [
        { colKey: "no", colLabel: "No" }, { colKey: "visit_id", colLabel: "Visit Id" }, { colKey: "branch", colLabel: "Branch" },
        { colKey: "patient_no", colLabel: "Patient No" }, { colKey: "patient_name", colLabel: "Patient Name" }, { colKey: "age", colLabel: "Age" },
        { colKey: "gender", colLabel: "Gender" }, { colKey: "county", colLabel: "County" }, { colKey: "residence", colLabel: "Residence" },
        { colKey: "phone", colLabel: "Phone" }, { colKey: "va_re", colLabel: "V.A(RE)" }, { colKey: "va_le", colLabel: "V.A(LE)" },
        { colKey: "disability", colLabel: "Disability Type" }, { colKey: "impression", colLabel: "Impression" }, { colKey: "diagnosis", colLabel: "Final Diagnosis" },
        { colKey: "management", colLabel: "Management" }, { colKey: "date", colLabel: "Date" }, { colKey: "time_reg", colLabel: "Time Registered" },
        { colKey: "time_seen", colLabel: "Time Seen" }, { colKey: "registered_by", colLabel: "Registered By" }, { colKey: "seen_by", colLabel: "Seen By" },
        { colKey: "pay_type", colLabel: "Pay Type" }, { colKey: "last_stage", colLabel: "Last Stage" }, { colKey: "referral", colLabel: "Referral" },
      ], rows: [] },
      { key: "SUMMARY", label: "Summary", columns: [{ colKey: "value", colLabel: "Value" }], rows: [
        { rowCode: "total_seen", rowLabel: "Total seen" }, { rowCode: "total_not_seen", rowLabel: "Total not seen" },
        { rowCode: "direct_service", rowLabel: "Direct service patients" }, { rowCode: "net_seen", rowLabel: "Net patients seen/clerks", isTotal: true },
      ]},
      { key: "DEPTS", label: "Depts breakdown", columns: [{ colKey: "value", colLabel: "Value" }], rows: [
        { rowCode: "new", rowLabel: "New" }, { rowCode: "revisit", rowLabel: "Revisit" }, { rowCode: "review", rowLabel: "Review" },
        { rowCode: "walk_in", rowLabel: "Walk-In" }, { rowCode: "total", rowLabel: "Total", isTotal: true },
      ]},
      { key: "DOCTORS", label: "Doctors breakdown", columns: [{ colKey: "value", colLabel: "Value" }], rows: [] },
      { key: "DIAGNOSIS", label: "Diagnosis breakdown", columns: [{ colKey: "value", colLabel: "Value" }], rows: [] },
      { key: "RESIDENCY", label: "Patients residency breakdown", columns: [{ colKey: "value", colLabel: "Value" }, { colKey: "percent", colLabel: "Percentage" }], rows: [] },
      { key: "BRANCHES", label: "Branches breakdown", columns: [{ colKey: "value", colLabel: "Value" }], rows: [] },
      { key: "QUEUE", label: "Queue stage breakdown", columns: [{ colKey: "value", colLabel: "Value" }], rows: [
        { rowCode: "waiting", rowLabel: "Waiting" }, { rowCode: "called", rowLabel: "Called" }, { rowCode: "in_service", rowLabel: "In service" },
        { rowCode: "done", rowLabel: "Done" }, { rowCode: "cancelled", rowLabel: "Cancelled" },
      ]},
      { key: "AGE", label: "Age breakdown", columns: [{ colKey: "value", colLabel: "Value" }], rows: (["lt5", "5_15", "ge16"] as const).flatMap((age) =>
        (["new", "revisit"] as const).flatMap((visit) => (["m", "f"] as const).map((sex) => ({
          rowCode: `${age}_${visit}_${sex}`,
          rowLabel: `${age === "lt5" ? "<5" : age === "5_15" ? "5-<16" : ">=16"} ${visit} ${sex === "m" ? "M" : "F"}`,
        }))),
      )},
      { key: "VISUAL_ACUITY", label: "Visual acuity", columns: [{ colKey: "value", colLabel: "Value" }], rows: [
        { rowCode: "low_vision_m", rowLabel: "Low vision M" }, { rowCode: "low_vision_f", rowLabel: "Low vision F" },
        { rowCode: "blind_m", rowLabel: "Blind M" }, { rowCode: "blind_f", rowLabel: "Blind F" },
      ]},
    ],
  };
}

export function moh735Template(): MohReportTemplate {
  const ageCols = [
    { colKey: "lt5_new_m", colLabel: "<5 New M" }, { colKey: "lt5_new_f", colLabel: "<5 New F" }, { colKey: "lt5_rev_m", colLabel: "<5 Revisits M" }, { colKey: "lt5_rev_f", colLabel: "<5 Revisits F" },
    { colKey: "5_15_new_m", colLabel: "5-<16 New M" }, { colKey: "5_15_new_f", colLabel: "5-<16 New F" }, { colKey: "5_15_rev_m", colLabel: "5-<16 Revisits M" }, { colKey: "5_15_rev_f", colLabel: "5-<16 Revisits F" },
    { colKey: "ge16_new_m", colLabel: ">=16 New M" }, { colKey: "ge16_new_f", colLabel: ">=16 New F" }, { colKey: "ge16_rev_m", colLabel: ">=16 Revisits M" }, { colKey: "ge16_rev_f", colLabel: ">=16 Revisits F" },
  ];
  const diagCols = (["lt5", "5_15", "ge16"] as const).flatMap((age) => {
    const ageLabel = age === "lt5" ? "<5" : age === "5_15" ? "5-<16" : ">=16";
    return (["normal", "lv", "blind"] as const).flatMap((acuity) => {
      const acuityLabel = acuity === "normal" ? "Normal" : acuity === "lv" ? "Low Vision" : "Blind";
      return ([["m", "M"], ["f", "F"]] as const).map(([sex, sexLabel]) => ({
        colKey: `${acuity}_${age}_${sex}`,
        colLabel: `${acuityLabel} ${ageLabel} ${sexLabel}`,
      }));
    });
  }).concat([{ colKey: "total", colLabel: "Total" }]);
  const diagRows: Array<[string, string]> = [
    ["normal_eye", "Normal eye"], ["amblyopia", "Amblyopia"], ["aphakia", "Aphakia"], ["cataract", "Cataract"],
    ["cvi", "Cerebral Visual Impairment"], ["chalazion", "Chalazion"], ["conj_growth", "Conjunctival Growths"],
    ["conj_allergic", "Conjunctivitis Allergic"], ["conj_bacterial", "Conjunctivitis Bacterial"], ["conj_fungal", "Conjunctivitis Fungal"], ["conj_viral", "Conjunctivitis Viral"],
    ["corneal_scar", "Corneal Scar - injury or infection"], ["corneal_ulcer", "Corneal Ulcer"], ["corneal_fb", "Corneal/Conjunctival FB"],
    ["glaucoma", "Glaucoma"], ["refractive", "Refractive error"], ["uveitis", "Uveitis"], ["other", "Other eye conditions"],
  ];
  return {
    reportCode: "MOH735",
    sections: [
      { key: "A", label: "A Total Workload", columns: ageCols, rows: [{ rowCode: "workload", rowLabel: "Total workload" }] },
      { key: "B", label: "B Visual Acuity", columns: [{ colKey: "lv_m", colLabel: "Low Vision M" }, { colKey: "lv_f", colLabel: "Low Vision F" }, { colKey: "blind_m", colLabel: "Blind M" }, { colKey: "blind_f", colLabel: "Blind F" }], rows: [{ rowCode: "va", rowLabel: "Visual acuity" }] },
      { key: "C", label: "C Inpatient Work Load - Eye Ward", columns: [{ colKey: "beds", colLabel: "Number of beds" }, { colKey: "admissions", colLabel: "Admissions" }, { colKey: "discharges", colLabel: "Discharges" }], rows: [{ rowCode: "ward", rowLabel: "Eye ward" }] },
      { key: "D", label: "D Clinical Diagnosis", columns: diagCols, rows: diagRows.map(([rowCode, rowLabel]) => ({ rowCode, rowLabel })) },
    ],
  };
}

export function templateFor(reportCode: MohReportCode, year: number, month: number): MohReportTemplate {
  switch (reportCode) {
    case "MOH705A": return moh705ATemplate(year, month);
    case "MOH705B": return moh705BTemplate(year, month);
    case "MOH717": return moh717Template();
    case "MOH505": return moh505Template();
    case "MOH710A": return moh710ATemplate(year, month);
    case "MOH710B": return moh710BTemplate();
    case "MOH416": return moh416Template();
    case "MOH735": return moh735Template();
  }
}

export function emptyCellsFromTemplate(template: MohReportTemplate): MohCell[] {
  const cells: MohCell[] = [];
  let sort = 0;
  for (const section of template.sections) {
    for (const row of section.rows) {
      for (const col of section.columns) {
        cells.push({ section: section.key, rowCode: row.rowCode, rowLabel: row.rowLabel, colKey: col.colKey, colLabel: col.colLabel, valueNumeric: 0, valueText: null, sortOrder: sort++, isTotal: Boolean(row.isTotal) });
      }
    }
  }
  return cells;
}

export function checksumCells(cells: MohCell[]): string {
  const mapped: ChecksumCell[] = cells.map((c) => ({ section: c.section, rowCode: c.rowCode, colKey: c.colKey, valueNumeric: c.valueNumeric == null ? null : String(c.valueNumeric), valueText: c.valueText, sortOrder: c.sortOrder, isTotal: c.isTotal }));
  return computeReportChecksum(mapped);
}

export function sumRow(cells: MohCell[], section: string, rowCode: string, excludeColKeys = ["total"]) {
  return cells.filter((c) => c.section === section && c.rowCode === rowCode && c.colKey && !excludeColKeys.includes(c.colKey)).reduce((n, c) => n + Number(c.valueNumeric ?? 0), 0);
}

export function setCell(cells: MohCell[], section: string, rowCode: string, colKey: string, value: number | string | null, sourceQuery?: string | null) {
  const cell = cells.find((c) => c.section === section && c.rowCode === rowCode && c.colKey === colKey);
  if (!cell) return;
  if (typeof value === "number") { cell.valueNumeric = value; cell.valueText = null; }
  else { cell.valueText = value; cell.valueNumeric = null; }
  if (sourceQuery !== undefined) cell.sourceQuery = sourceQuery;
}

export function finalizeDailyTotals(cells: MohCell[], section: string) {
  const rowCodes = Array.from(new Set(cells.filter((c) => c.section === section).map((c) => c.rowCode).filter(Boolean))) as string[];
  for (const rowCode of rowCodes) {
    const total = sumRow(cells, section, rowCode, ["total"]);
    setCell(cells, section, rowCode, "total", total);
  }
}
