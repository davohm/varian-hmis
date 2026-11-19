# 10 — Kenya Facility Readiness

## 1. Purpose

This document turns Varian HMIS into a system a Kenyan health facility can legally and operationally run on. `09-erp-scope.md` covers the ERP domains; this document covers the **country-specific obligations** that sit on top of them: licences and regulators, data protection, social health insurance, tax invoicing, and statutory health reporting.

It is written from two evidence sets:

1. **Discovery evidence** — 34 screenshots of the incumbent system at Family Afya Modern Medical Centre Limited (`C:\Users\Kabaka\Documents\Projects\PXT\Varia HMIS\Discovery`). These show what the facility already produces today: the MOH statutory return set, the ERP menu, and the KRA/eTIMS integration.
2. **Primary regulator sources** — ODPC, KMPDC, SHA, KRA and MOH, fetched directly (see §3.2).

Nothing here relaxes `03-database-schema.md` or `09-erp-scope.md`. Every addition follows the same conventions: `uuidv7` primary keys, `facility_id` on every operational row, server-side commands with an idempotency key, one transaction, an audit row and an outbox row, append-only clinical/financial records, and numbering allocated by the facility's write authority only.

## 2. How to use this document

- Read after `09-erp-scope.md`. The Kenya prompts **18–22** are specified in §9 and listed in short form in `07-build-prompts.md`.
- Run one prompt at a time. Before each prompt, tell OpenCode: *"Read docs/opencode-handover/*.md first. Follow them exactly. Write tests for every business rule."*
- Load the relevant UI/UX skill before any screen work (`AGENTS.md`).
- Each prompt in §9 carries its own acceptance criteria and a "tests for every business rule" list. Do not mark a prompt done until those tests pass and `npm run typecheck`, `npm run lint` and `npm test` are clean.
- Items marked **[verify]** are things this document could not confirm from a primary source. **They do not block the build.** Each one is a field on an admin configuration screen (§6.6), seeded with a safe default, validated on write, and filled in by the facility. The system must run correctly with the field unset — showing `missing` in the readiness status and blocking only the specific action that truly depends on the value. See §10 for the question-to-field mapping.

## 3. Evidence

### 3.1 Discovery evidence (incumbent system)

The Discovery folder contains 34 PNGs from **Q-Afya Integrated Hospital Management Information System**, running at Family Afya (MAIN facility, store switcher on PHARMACY), KRA PIN `P052292910Q`, invoice prefix `FAH`.

**Group A — MOH statutory report specimens (8 files).** These are the facility's live output and are the acceptance target for Prompt 20:

| File | Report |
|---|---|
| `MOH 705A Report.png` | Under 5 years daily outpatient morbidity summary |
| `MOH 705B Report.png` | Over 5 years daily outpatient morbidity summary |
| `MOH 717.png` | Monthly workload report for health facilities |
| `IDSR WEEKLY EPIDEMIC MONITORING FORM (MOH 505).png` | IDSR weekly epidemic monitoring |
| `DIVISION OF VACCINE AND IMMUNIZATION (MOH 710A).png` | Integrated immunisation / EPI summary |
| `DIVISION OF VACCINE AND IMMUNIZATION ANTIGENS MOVEMENT REPORT (MOH 710B).png` | EPI logistics / antigen movement |
| `MOH 416-EYE CLINIC REGISTER.png` | Eye clinic register |
| `MOH 735 EYE SUMMARY REPORT.png` | Eye summary report |

Every sheet shares one envelope: facility letterhead block (name, P.O. Box, telephone, website, email), county / district (or sub-county), **Epi Week, week ending, month, year**, and a Submitted By / Received By signature block.

**Group B — application discovery (26 files).** Reconstructed feature map:

- **Shell** — Dashboard, Patients, Activities, Accounts, Procurement, Employees, Tools, Reports; patient search; facility switcher; store switcher; Quick Access panel; Queue Manager with per-stage timing (Triage / Consult / Lab / Pharm / Rad) colour-coded by wait.
- **Patients** — Registry, Biometrics, Edit, Chart, Archive, History, **Merge**, Upload Scans, **Bulk SMS**, Appointments Calendar / Book / Allocate, Find Archived. Row actions include **View Data Consent Form** and **Blacklist Patient**.
- **Activities** — Reception & Payments (per-department billing, cashier/insurance bill approval, debtor receipting, **KRA Transactions**, reprint receipt/invoice, void/consolidate, waivers & exemptions request/verify/approve, refunds request/verify/approve/overpayment, direct cash sale, quotation/proforma), ~30 consultation clinics, IP management (admit, ward transfer, bed assignment, discharge summary, charge sheet, gate pass, **Births Notification Register**, **Deaths Register**, mortuary), lab, imaging, pharmacy, theatre, social works.
- **Accounts** — Chart of Accounts (342 ledgers, codes 1000+), Post/Find Transactions, Items Registry, Packages, Consumables, **Petty Cash** (requisition, approval, payment, allocation), Direct Expenses, **Cash & Banking** (cashier collection, transfers, cheques, full bank-reconciliation lifecycle with Check/Approve, refund payment), **Creditor Operations** (creditors, approve payment voucher, post services invoice, subscriptions, external billing config, commission, locum, asset invoice, statutory payments), **Debtor Operations** (set up debtors/schemes, insurance pricing admin, find invoices), **Service Approvals** (insurance pre-auth, approve journals, approve created items, **claims processing**, full dispatch-note chain), Budget Management, Medical Cover Management.
- **Procurement** — Requisition → RFQ → LPO → LPO Verification → GRN → GRN Purchase Invoice → Goods Returned Outwards; inventory (stores, reorder levels, stock request/transfer/issue/taking/adjustment with approval, valuation, expiry, ABC analysis); manufacturing/production; asset management (register, revaluation + approval, disposal, maintenance scheduling, asset count).
- **Employees** — employee master, organogram, discipline, termination, HR documents, attendance, leave (approve/authorize/settings/calendar), payroll (new/edit/settings/benefits), check-in/out, MyHR, duty rota.
- **Tools** — organisation settings (company details incl. **KRA PIN**, branches, clinics, wards, beds, departments), security (users, **upload A/c signature**, approve user creation, access rights + approval, time-outs, ward assignment, multiple store assign), pharmacy/lab/radiology/theatre settings, **Financial Periods**, **Set up IDSR Report**, **Set ICD11 Diagnosis**, **Auto Recognize Income Setup**, **Set up Banks**, Medical Notes.
- **Reports** — ~150 names: financial statements, ledger/journal/voucher, debtor & creditor ageing, stock movement/valuation/expiry, payroll & statutory summaries, HR, lab/radiology/pharmacy/theatre workload, marketing, social works, and the statutory block **MOH 705A/B, 717, 416, 735, 505-IDSR, 710A-DVI, 710B-DVI, 204A/204B, FORM 1A/1B, 301-IPD, 510/511 CWC, 222/270/740 diabetes, TB ACF**.

**Key finding:** the incumbent produces the entire MOH statutory return set from operational data. Varian HMIS today produces none of it. That is the largest single gap this document closes.

### 3.2 Primary regulator sources

| Regulator | Source | What it governs |
|---|---|---|
| KMPDC — Kenya Medical Practitioners and Dentists Council | kmpdc.go.ke, osp.kmpdc.go.ke, registers.kmpdc.go.ke | Facility registration and annual licensing; practitioner annual practice licences and CPD |
| ODPC — Office of the Data Protection Commissioner | odpc.go.ke, dataportal.odpc.go.ke | Data Protection Act 2019 compliance, registration, breaches, DPIA |
| SHA — Social Health Authority | sha.go.ke, econtracting.sha.go.ke, portal.sha.go.ke, afyayangu.go.ke | SHIF / PHF / ECCIF empanelment, tariffs, claims, payment reports |
| KRA — Kenya Revenue Authority | kra.go.ke, etims.kra.go.ke, etims-sbx.kra.go.ke, itax.kra.go.ke | eTIMS electronic tax invoices, PIN, tax obligations |
| MOH — Ministry of Health | health.go.ke, hiskenya.org, kmhfl.health.go.ke, guidelines.health.go.ke | KHIS reporting, MOH forms, guidelines, UHC regulations |
| NSSF | nssf.or.ke, selfservice.nssf.or.ke | Statutory contributions |
| PPB — Pharmacy and Poisons Board | pharmacyboardkenya.org | Pharmacy and pharmacist licensing, controlled drugs |
| KMLTTB — Kenya Medical Laboratory Technicians and Technologists Board | kmlttb.go.ke | Laboratory licensing and quality |
| Radiation Protection Board | — | Imaging / radiological licences |
| KEMSA | kemsa.co.ke | Public-sector medical supplies |

## 4. Regulatory framework

### 4.1 Licensing and facility registration (KMPDC)

- The **Medical Practitioners and Dentists Act (Cap 253)**, as amended by the **Health Laws (Amendment) Act No. 5 of 2019**, requires every health facility to be registered and to hold a current **annual licence**.
- Renewal is through the **Online Services Portal** (`osp.kmpdc.go.ke`). The published notice requires renewal by **30 November**, with penalties applying after **31 December**.
- A **Health Institution Professional Indemnity** certificate is required (sample format published by KMPDC).
- Licence category determines the permitted scope and the fee. The published 2025 schedule includes: Dispensary 5,000; Faith-based dispensary 5,000; Medical clinic 15,000; Eye clinic 15,000; Health centre 15,000; Dental clinic 15,000; Mobile clinic 15,000; Basic health centre 15,000; **Medical centre 20,000**; Comprehensive centre 20,000; Dental centre 20,000; Funeral home 20,000; Maternity home 25,000; Nursing home 30,000; Cottage hospital 30,000; Faith-based L4 30,000; Hospital L4 80,000; Faith-based specialised tertiary referral 80,000; Hospital L5 90,000; Eye hospital L5 90,000. The facility's own category and fee are entered on the fee-schedule screen (§6.6) and drive the renewal alerts.
- **Practitioners** hold an annual practice licence under s.14(1) and must show **CPD compliance**. Foreign-trained doctors need specialist recognition. Ambulance and emergency medical practitioner services have separate KMPDC registration.
- **KEPH level** (1 community → 2 dispensary → 3 health centre → 4 primary referral → 5 secondary referral → 6 tertiary) is the classification the state uses for staffing norms, benefits and reporting.
- Other professional regulators: **PPB** (pharmacy), **KMLTTB** (laboratory), **Radiation Protection Board** (imaging), plus nursing and other councils.

**Varian impact:** a facility must not be able to bill, claim or report as if it were licensed when its licence is expired. Practitioner identity must carry licence and CPD state. Facility identity must carry KMPDC number and KEPH level, because SHA and MOH key off them.

### 4.2 Data protection (ODPC)

- The **Data Protection Act 2019** gives effect to Article 31(c) and (d) of the Constitution. **Registration with ODPC is mandatory** under s.18 and the Data Protection (Registration of Data Controllers and Data Processors) Regulations 2021.
- **Health administration and provision of patient care is a non-exempt purpose.** An entity processing personal data for that purpose must register **regardless of turnover or number of employees**.
- Exemption (only if **both** conditions hold): annual turnover/revenue below **KSh 5 million** **and** fewer than **10 employees**.
- Certificate valid **24 months**; renewal application at least **30 days before expiry**; changes to registered particulars notified in writing within **14 days**.
- Fees: Micro/Small (≤KSh 5M, 1–50 staff) **4,000** (renewal 2,000); Medium (KSh 5–50M, 51–99) **16,000** (renewal 9,000); Large (>KSh 50M, >99) **40,000** (renewal 25,000); public entities and charities/religious **4,000** (renewal 2,000). Acting as both controller and processor requires two separate registrations.
- **Health data is sensitive personal data** (DPA s.2: health status, genetic data, biometric data). Processing requires a lawful basis and, for sensitive data, explicit consent or another specific condition.
- Required apparatus: consent, data-subject rights (access, correction, erasure, portability, objection), a **DPIA** for high-risk processing, a **DPO**, a data-protection policy, breach notification, and data-sharing agreements with processors.
- ODPC publishes a **Guidance Note on the Processing of Health Data**, plus guidance notes on **biometric data**, **children's data**, **consent**, **DPOs**, **DPIAs**, **cross-border data transfers**, the **Data Sharing Code**, and the **public sector**. E-services exist for filing a complaint and **reporting a data breach**.
- ODPC published a **draft notice prescribing additional categories of sensitive personal data** (September 2026) — track, do not assume.

**Varian impact:** consent capture at registration, per-patient sharing flags, data-subject request workflow with a clock, a breach register with a notification clock, retention schedules, a DPO role, per-record access audit, and a cross-border transfer assessment for the clinic→cloud sync path.

### 4.3 Health insurance and the revenue cycle (SHA)

- The **Social Health Insurance Act No. 16 of 2023** (commenced **22 November 2023**) repealed the NHIF Act 1989 and established the **Social Health Authority** and three funds:
  - **Primary Healthcare Fund (PHF)** — outpatient care, maternal/newborn/child health, cancer screening and management, optical health, end-of-life services.
  - **Social Health Insurance Fund (SHIF)** — medical inpatient, maternity and neonatal, renal care, mental health, surgical services.
  - **Emergency, Chronic and Critical Illness Fund (ECCIF)** — ambulance evacuation, accident & emergency, critical illness, palliative care, chronic illnesses.
- A facility must be **empaneled and contracted**. Portals: **e-contracting** (`econtracting.sha.go.ke`), **provider portal** (`portal.sha.go.ke`), member portal (`afyayangu.go.ke`), eligibility check (`eligibility.sha.go.ke`). A facility is identified by its **KMPDC number** in SHA payment reports.
- **Social Health Insurance (General) Regulations 2024**, regulation 37, imposes obligations on an empaneled and contracted provider: provide quality and safe healthcare, subscribe to a quality-improvement certification programme, and meet the claims/records obligations in the schedules. The regulations include the **SHA Claims Form** and an express warning that a claim containing misrepresentation or false, incomplete or misleading information may be **medical fraud punishable under law**.
- SHA publishes **benefit tariffs**, **means testing**, **Lipa Pole Pole** instalments, **claim payment reports** (per facility, by KMPDC number), and operates an **ICD-based adjudication system** that validates claims. Overseas treatment is handled through **POMSF**.
- Private payers, corporate schemes and NHIF-era residual contracts still need contracts, pre-authorisation, claims, debtors, refunds, waivers and exemptions.

**Varian impact:** the revenue-cycle schema in `revenue.ts` is the right backbone, but it needs a SHA layer: empanelment, fund-specific benefit packages and tariffs, SHA claim identifiers and adjudication codes, pre-auth references, remittance allocation tied to SHA payment reports, and reconciliation that ties back to the general ledger.

### 4.4 Tax and invoicing (KRA eTIMS)

- **eTIMS (electronic Tax Invoice Management System)** is mandatory for **all persons engaged in business**. KRA is explicit that *"persons supplying VAT exempt goods and services such as hospitals supplying medical services"* must onboard and issue electronic tax invoices.
- Since **1 January 2024**, a business expense can only be claimed if supported by an electronic tax invoice.
- **System-to-system integration is via API**, in two modes:
  - **VSCU** — Virtual Sales Control Unit, for bulk invoicing, not always online.
  - **OSCU** — Online Sales Control Unit, for always-online invoicing.
  - Published specifications exist for both, plus a **sandbox** (`etims-sbx.kra.go.ke`), and KRA publishes a list of **approved third-party integrators**. Integrators must be vetted and certified.
- **Buyer-initiated invoicing** applies where the seller is a small business or small-scale farmer (turnover ≤ KSh 5 million) and is handled on the eCitizen platform.
- Business expenses **excluded** from eTIMS: emoluments (salaries and wages), imports, air passenger ticketing, investment allowances, interest, fees charged by financial institutions, expenses subject to final withholding tax, and services by non-residents without a permanent establishment.
- Every invoice needs the seller's **KRA PIN** (Family Afya `P052292910Q`) and a valid tax treatment. The PIN and VAT status are entered on the facility profile and tax settings (§6.1, §6.6) and confirmed against eTIMS by the "Test connection" action.

**Varian impact:** a tax-code master, an eTIMS invoice envelope (signature/QR/control number), a durable queue with idempotency and retry, an adapter that can target sandbox or production, and correction by credit note rather than edit.

### 4.5 Statutory health reporting (MOH / KHIS)

MOH operates the national platforms a facility must feed:

| Platform | URL | Relevance |
|---|---|---|
| **KHIS** — Kenya Health Information System (DHIS2) | hiskenya.org | National aggregate reporting; where MOH forms land |
| **KMHFL** — Kenya Master Health Facility List | kmhfl.health.go.ke | Facility registry, KMPDC number |
| **IHRIS** | ihris.health.go.ke | HR / establishment reporting |
| **DamuKE** | damuke.health.go.ke | Blood banking |
| **eCHIS** | echis.go.ke | Community health |
| **KQMH** — Kenya Quality Model for Health | kqmh.uonbi.ac.ke | Quality surveys / accreditation |
| **KHRO** | khro.health.go.ke | Research observatory |
| Guidelines portal | guidelines.health.go.ke | Norms, treatment guidelines, IDSR tools |
| MoH self-service portal | portal.health.go.ke | Facility services |

- The **MOH form set** is the Discovery set: **705A, 705B, 717, 505 (IDSR), 710A, 710B, 416, 735**, plus **204A, 204B, FORM 1A, FORM 1B, 301-IPD, 510, 511, 222, 270, 740** and **TB ACF**.
- **IDSR (MOH 505)** is **weekly**, with **immediate reporting** triggers for epidemic-prone diseases: Acute Jaundice, Acute Malnutrition, AEFI, AFP (poliomyelitis), Anthrax, Cholera, Dengue, Dysentery (bacillary), Guinea Worm Disease, Malaria, Maternal Deaths, Measles, Neonatal deaths, Neonatal Tetanus, Plague, Rabies, Rift Valley Fever, SARI (cluster ≥ 3 cases), Suspected MDR/XDR TB, Typhoid, VHF (Ebola, Marburg, RVF, CCHF), Yellow Fever. MOH maintains live alert pages for Cholera, COVID-19, Ebola and Mpox.
- **Public Health Act Cap 242** governs notifiable disease reporting; the county and sub-county are part of the reporting envelope.
- **Vital registration** — births notification and deaths registration are statutory registers (Discovery has dedicated registers; MOH 717 carries birth and death sections).
- **Draft Quality Healthcare and Patient Safety Bill, 2025** is published by MOH — pending legislation that will impose quality and patient-safety obligations. **UHC Regulations** are also published. Track both.

**Varian impact:** a generic report engine that renders the exact MOH row sets, parameterised by branch and period, with print/Excel/CSV output, an audit trail of every run, and an eventual KHIS/DHIS2 export.

### 4.6 Procurement, inventory and financial control

- **Public Procurement and Asset Disposal Act 2015** for public facilities; **KEMSA** is the primary public supplier; **AGPO** reserves 30% of procurement for youth, women and persons with disability; IFMIS/e-procurement is used by government. Private facilities still need audit-grade procurement.
- Three-way matching (LPO ↔ GRN ↔ supplier invoice), goods returned outwards, stock takes, reorder levels, expiry, and the **append-only stock ledger** as the single stock source of truth (`09-erp-scope.md` §3.3).
- **Pharmacy and Poisons Board** — facility and pharmacist licensing, controlled-drug registers, cold chain. **KMLTTB** — laboratory licensing, ISO 15189/SLMTA quality. **Radiation Protection Board** — imaging licences.
- **Vaccines (MOH 710B)** require the A–H movement ledger: opening stock, received, total stocked, remaining, used, children vaccinated, wasted, wastage rate.
- Audit: Auditor-General and Controller of Budget for public; internal audit for private. Chart of accounts aligned to statutory reporting.

### 4.7 Employment, payroll and statutory contributions

- **Employment Act 2007**, **NSSF Act 2013** (tiered contributions, self-service portal), **SHIF** contributions, **PAYE**, **Housing Levy** (National Housing Development Fund), plus leave, duty rota, locum, overtime and separation.
- Payroll must produce payslips, statutory summaries, cost-centre allocation and an audited approval trail with **separation of duties** (`09-erp-scope.md` §4). Public facilities report to **IHRIS**.
- Statutory rates change with each Finance Act. The system must be **parameterised**, not hard-coded: rates live in `statutory_rates` (§6.6), are effective-dated, and are entered or confirmed by the facility's payroll administrator.

### 4.8 Quality and patient safety

- **Draft Quality Healthcare and Patient Safety Bill, 2025** — pending. Expect obligations around incident reporting, clinical governance, and quality improvement.
- SHA regulation 37 requires providers to **subscribe to a quality improvement certification programme**; SHA empanelment and claims depend on it.
- **KQMH** (Kenya Quality Model for Health) is the national quality survey instrument.

## 5. Kenya readiness capability map

| # | Capability | Obligation | Source | Varian artefact | Prompt |
|---|---|---|---|---|---|
| 1 | Facility regulatory identity | Registration, KEPH, licence, indemnity | KMPDC | `facility_regulatory_profiles`, licence expiry controls | 18 |
| 2 | Practitioner regulatory identity | Annual practice licence, CPD, specialist recognition | KMPDC | `practitioner_registrations` | 18 |
| 3 | Support-service licences | Pharmacy, laboratory, imaging, ambulance | PPB, KMLTTB, RPB, KMPDC | `support_service_licences` | 18 |
| 4 | Statutory employer/tax identifiers | KRA PIN, NSSF employer code, tax compliance | KRA, NSSF | `facility_identifiers` | 18 |
| 5 | Licence expiry control | No billing/claiming/reporting on an expired licence | KMPDC | `getFacilityReadinessStatus`, command guards | 18 |
| 6 | Consent | Lawful basis, explicit consent for sensitive data | ODPC DPA 2019 | `data_consents` | 19 |
| 7 | Data-subject rights | Access, correction, erasure, portability, objection | ODPC | `data_subject_requests` | 19 |
| 8 | Breach management | Breach register, notification clock, ODPC notification | ODPC | `data_breaches` | 19 |
| 9 | Retention and disposal | Retention schedules, legal hold, no hard delete | ODPC / records law | `retention_policies` | 19 |
| 10 | Data sharing and transfer | Processor agreements, cross-border assessment | ODPC | `data_sharing_agreements`, `transfer_assessments` | 19 |
| 11 | Record access audit | Who viewed which chart, when | ODPC | `chart_access_log` (extends `audit_log`) | 19 |
| 12 | DPO and privacy roles | DPO assignment, privacy inbox | ODPC | role `dpo`, `/admin/privacy` | 19 |
| 13 | SHA empanelment | Contracted facility, KMPDC-keyed | SHA | `sha_empanelments` | 22 |
| 14 | Benefit packages and tariffs | Fund-specific coverage and limits | SHA | `benefit_packages`, `benefit_package_items` | 22 |
| 15 | SHA claims and adjudication | Claim ref, adjudication codes, rework | SHA | `claims`, `claim_lines`, `claim_denials` extensions | 22 |
| 16 | SHA remittance reconciliation | Tie payments to claims and GL | SHA | `remittances`, `sha_payment_reconciliation` | 22 |
| 17 | eTIMS tax invoicing | Mandatory electronic tax invoices | KRA | `tax_codes`, `etims_invoice_queue`, adapter | 21 |
| 18 | Payroll statutory deductions | PAYE, NSSF, SHIF, housing levy | KRA, NSSF, SHA | `statutory_rates` (Prompt 18) + payroll engine (ERP-3) | 18 / 15 |
| 19 | MOH report catalogue | Every statutory form, parameterised | MOH / KHIS | `report_catalogue`, `report_runs`, `report_cells` | 20 |
| 20 | MOH form engines | 705A/B, 717, 505, 710A/B, 416, 735, 204A/B, 301, 510/511, 222/270/740, TB ACF | MOH | `report_definitions` + generators | 20 |
| 21 | IDSR immediate notification | Epidemic-prone disease triggers | Public Health Act, MOH | `notifiable_events` | 20 |
| 22 | Vital registers | Births notification, deaths registration | MOH / civil registration | `birth_notifications`, `death_notifications` | 20 |
| 23 | KHIS/DHIS2 export | Machine-readable submission | MOH / KHIS | export adapter | 20 (later phase) |
| 24 | Print-ready statutory documents | MOH letterhead, signature blocks | MOH | report print CSS + PDF | 20 |
| 25 | Quality and patient safety | Pending bill, SHA quality certification | MOH, SHA | track only | — |
| 26 | Admin-editable regulator configuration | Every unconfirmed regulator value is entered, validated and versioned by the facility | All | `facility_settings`, `statutory_rates`, `statutory_fee_schedules`, `sha_adjudication_codes`, `integration_settings` | 18 |

## 6. Data model additions

All tables follow `03-database-schema.md`: `id uuid primary key` default `uuidv7()`, `facility_id uuid not null`, `created_at`, `updated_at`, `created_by text`, `version int default 1`, `pgEnum` for status/type columns, `numeric(12,2)` for money, `timestamptz` for timestamps, indexes on `(facility_id, <lookup>)`, and no hard deletes on clinical/financial rows.

### 6.1 Prompt 18 — master data, licences, identifiers

```text
facility_regulatory_profiles(
  facility_id uuid primary key references facilities(id),
  kmpdc_number text unique, kmhfl_id text,
  keph_level smallint,                       -- 1..6
  facility_category text,                    -- KMPDC licence category
  ownership text,                            -- public | faith_based | private | ngo
  county text, sub_county text, constituency text, ward text,
  licence_no text, licence_issue_date date, licence_expiry_date date,
  licence_status text,                       -- active | expired | suspended | pending
  indemnity_provider text, indemnity_no text, indemnity_expiry_date date,
  sha_facility_code text, sha_empanelment_status text,
  odpc_registration_no text, odpc_category text, odpc_expiry_date date,
  kra_pin text, tcc_no text, tcc_expiry_date date,
  nssf_employer_code text, shif_employer_code text,
  kemsa_supplier_code text, updated_by text)

practitioner_registrations(
  id uuid primary key, facility_id uuid not null, staff_profile_id uuid not null,
  regulator text,                            -- kmpdc | ppb | kmlttb | nck | rpb | other
  profession text,                           -- medical | dental | pharmacy | lab | imaging | nursing
  registration_no text, annual_licence_no text,
  licence_issue_date date, licence_expiry_date date, licence_status text,
  cpd_points numeric(6,1), cpd_cycle text, cpd_status text,
  specialist_recognition text, verified_at timestamptz, verified_by text,
  unique(facility_id, staff_profile_id, regulator))

support_service_licences(
  id uuid primary key, facility_id uuid not null,
  service_type text,                         -- pharmacy | laboratory | imaging | ambulance | mortuary | theatre
  licence_no text, issuing_authority text, issue_date date, expiry_date date,
  status text, conditions text, updated_by text)

facility_identifiers(                        -- generic, extensible
  id uuid primary key, facility_id uuid not null,
  identifier_type text,                      -- kra_pin | nssf | shif | kmpdc | kmhfl | odpc | ppb | kmlttb | rpb | bank | other
  value text, issuing_authority text, valid_from date, valid_to date, status text)

licence_alert_rules(
  id uuid primary key, facility_id uuid not null,
  subject_type text,                         -- facility | practitioner | support_service | odpc | sha
  subject_id uuid, warn_days int[], block_days int[], notify_roles text[],
  enabled boolean)
```

### 6.2 Prompt 19 — data protection

```text
data_consents(
  id uuid primary key, facility_id uuid not null, patient_id uuid not null,
  consent_type text,                         -- treatment | data_processing | payer_sharing | research | sms | biometrics | photography | minor
  consent_version text, consent_text_hash text,
  granted boolean, granted_at timestamptz, granted_by text,
  withdrawn_at timestamptz, withdrawn_by text, source text, document_id uuid,
  valid_from timestamptz, valid_to timestamptz,
  unique(facility_id, patient_id, consent_type, consent_version))

data_subject_requests(
  id uuid primary key, facility_id uuid not null, patient_id uuid not null,
  request_type text,                         -- access | correction | erasure | portability | objection
  status text,                               -- received | verifying | in_progress | completed | rejected
  received_at timestamptz, due_at timestamptz, completed_at timestamptz,
  requested_via text, identity_verified boolean, verified_by text,
  outcome text, rejection_reason text, handled_by text, notes text)

data_breaches(
  id uuid primary key, facility_id uuid not null, reference text unique,
  discovered_at timestamptz, contained_at timestamptz,
  odpc_notified_at timestamptz, affected_subjects int, affected_records int,
  severity text, description text, containment text, root_cause text,
  status text,                               -- detected | contained | notified | closed
  reported_by text, odpc_reference text)

retention_policies(
  id uuid primary key, facility_id uuid not null, entity text, legal_basis text,
  retention_years int, trigger_event text, legal_hold boolean,
  destroy_after date, review_at timestamptz)

data_sharing_agreements(
  id uuid primary key, facility_id uuid not null, counterparty text,
  counterparty_type text,                    -- payer | processor | public_health | research | other
  purpose text, lawful_basis text, odpc_reference text,
  started_on date, expires_on date, status text, document_id uuid)

transfer_assessments(
  id uuid primary key, facility_id uuid not null, transfer_path text,   -- clinic -> cloud
  destination_country text, mechanism text, lawful_basis text,
  assessment_date date, review_date date, status text, approved_by text)

chart_access_log(                            -- who opened which chart
  id uuid primary key, facility_id uuid not null, patient_id uuid not null,
  user_id text, accessed_at timestamptz, access_type text, device_id text, ip text)
```

### 6.3 Prompt 20 — statutory reporting

```text
report_catalogue(
  id uuid primary key, report_code text unique,   -- MOH705A, MOH705B, MOH717, MOH505, MOH710A, MOH710B, MOH416, MOH735, MOH204A, MOH204B, MOH1A, MOH1B, MOH301, MOH510, MOH511, MOH222, MOH270, MOH740, TBACF
  name text, domain text,                    -- morbidity | workload | idsr | epi | eye | inpatient | child_welfare | diabetes | tb
  schedule text,                             -- daily | weekly | monthly | quarterly
  period_type text,                          -- day | epi_week | month
  source_entities text[], output_formats text[], authority text, enabled boolean,
  template_version text)

report_runs(
  id uuid primary key, facility_id uuid not null, report_id uuid not null,
  branch_id uuid, period_start date, period_end date,
  epi_week int, epi_year int, month int, year int,
  status text,                               -- draft | generated | exported | submitted | void
  row_count int, checksum text, generated_by text, generated_at timestamptz,
  exported_file text, submitted_at timestamptz, submitted_by text,
  acknowledgement_ref text, voided_at timestamptz, void_reason text)

report_cells(                                -- generic, renderable, testable
  id uuid primary key, facility_id uuid not null, report_run_id uuid not null,
  section text, row_code text, row_label text, col_key text, col_label text,
  value_numeric numeric(14,2), value_text text, sort_order int, is_total boolean,
  source_query text)                         -- drill-down provenance

report_definitions(                          -- authored row/column metadata
  id uuid primary key, facility_id uuid not null, report_id uuid not null,
  section text, row_code text, row_label text, col_key text, col_label text,
  aggregation text, filter text, sort_order int, is_total boolean, formula text)

notifiable_events(
  id uuid primary key, facility_id uuid not null, patient_id uuid, encounter_id uuid,
  disease_code text, disease_name text, classification text,  -- suspected | probable | confirmed
  onset_date date, detected_at timestamptz, reported_at timestamptz,
  reported_to text, method text, status text, notes text)

birth_notifications(
  id uuid primary key, facility_id uuid not null, patient_id uuid, encounter_id uuid,
  child_mrn text, sex text, birth_weight_kg numeric(5,2), birth_date date,
  notification_no text, notified_at timestamptz, status text)

death_notifications(
  id uuid primary key, facility_id uuid not null, patient_id uuid, encounter_id uuid,
  date_of_death date, cause_code text, cause_text text, place_of_death text,
  notification_no text, notified_at timestamptz, status text)
```

### 6.4 Prompt 21 — eTIMS

```text
tax_codes(
  id uuid primary key, facility_id uuid not null,
  code text, name text, rate numeric(6,4), treatment text,   -- vat_standard | vat_zero | exempt | out_of_scope
  kra_code text, effective_from date, effective_to date, active boolean,
  unique(facility_id, code, effective_from))

etims_invoice_queue(
  id uuid primary key, facility_id uuid not null, idempotency_key uuid unique,
  invoice_id uuid, invoice_no text, credit_note_of uuid,
  document_type text,                        -- invoice | credit_note | debit_note
  integration_mode text,                     -- oscu | vscu
  buyer_pin text, buyer_name text, buyer_type text,
  currency text default 'KES', total_amount numeric(12,2), tax_amount numeric(12,2),
  status text,                               -- pending | transmitting | transmitted | acknowledged | rejected | failed | cancelled
  kra_control_no text, kra_signature text, qr_url text, cu_no text,
  response_code text, response_message text, attempts int default 0,
  next_attempt_at timestamptz, last_error text,
  enqueued_at timestamptz, transmitted_at timestamptz, acknowledged_at timestamptz,
  created_by text)

etims_transmission_log(
  id uuid primary key, facility_id uuid not null, queue_id uuid not null,
  attempt int, request_payload jsonb, response_payload jsonb,
  http_status int, outcome text, created_at timestamptz)
```

### 6.5 Prompt 22 — SHA / SHIF revenue cycle

```text
sha_empanelments(
  id uuid primary key, facility_id uuid not null, kmpdc_number text,
  fund text,                                 -- phf | shif | eccif
  scheme_code text, scheme_name text, contract_no text,
  contract_status text,                      -- active | suspended | expired | terminated
  effective_from date, expiry_date date, tariff_version text,
  quality_cert_program text, quality_cert_expiry date,
  bank_account_id uuid, opened_at timestamptz, closed_at timestamptz, closure_reason text,
  unique(facility_id, fund, scheme_code))

benefit_packages(
  id uuid primary key, facility_id uuid not null, fund text,
  package_code text, name text, care_level text, care_type text,   -- inpatient | outpatient
  effective_from date, effective_to date, active boolean,
  unique(facility_id, fund, package_code, effective_from))

benefit_package_items(
  id uuid primary key, facility_id uuid not null, benefit_package_id uuid not null,
  service_id uuid, item_id uuid, category text,
  coverage text,                              -- full | partial | excluded
  limit_amount numeric(12,2), limit_days int, limit_visits int,
  requires_preauth boolean, preauth_threshold numeric(12,2),
  co_pay_percent numeric(5,2), notes text)

-- extensions to existing revenue tables
payer_contracts:      + fund, + sha_empanelment_id, + tariff_version, + sha_package_id
pre_authorizations:   + sha_auth_ref, + fund, + benefit_package_id, + sha_status
claims:               + sha_claim_ref, + fund, + empanelment_id, + tariff_version,
                      + submission_batch, + adjudication_status, + adjudication_code,
                      + billed_amount, + approved_amount, + paid_amount, + patient_co_pay,
                      + waiver_id, + submitted_at
claim_lines:          + sha_service_code, + unit_price, + quantity, + approved_amount, + denial_code
remittances:          + sha_payment_report_ref, + bank_reference, + payment_date
claim_denials:        + sha_denial_code, + adjudication_reason
invoices:             + is_sha_claimable boolean

sha_payment_reconciliation(
  id uuid primary key, facility_id uuid not null, kmpdc_number text,
  report_period text, sha_reported_amount numeric(12,2),
  facility_invoiced_amount numeric(12,2), matched_amount numeric(12,2),
  unmatched_amount numeric(12,2), variance numeric(12,2),
  status text, generated_by text, generated_at timestamptz)
```

### 6.6 Prompt 18 — admin-input configuration

Every value this document could not confirm from a primary source (the **[verify]** items in §10) is stored as configuration the facility's administrator enters through the UI. Nothing is hard-coded, and no build waits on an answer.

```text
facility_settings(                            -- typed, validated key/value per facility
  id uuid primary key, facility_id uuid not null,
  domain text,                                -- regulatory | privacy | reporting | tax | sha | payroll | quality
  key text, value_text text, value_numeric numeric(14,4), value_json jsonb,
  data_type text,                             -- text | integer | decimal | boolean | date | enum | json
  allowed_values text[], min_value numeric, max_value numeric, regex text,
  is_required boolean, is_secret boolean default false,
  effective_from date, effective_to date,
  updated_by text, updated_at timestamptz,
  unique(facility_id, domain, key, effective_from))

statutory_rates(                              -- PAYE bands, NSSF tiers, SHIF, housing levy
  id uuid primary key, facility_id uuid not null,
  rate_type text,                             -- paye_band | nssf_tier | shif | housing_levy | other
  band_order int, lower_bound numeric(14,2), upper_bound numeric(14,2),
  rate_percent numeric(6,3), fixed_amount numeric(12,2),
  effective_from date, effective_to date, legal_reference text, active boolean,
  unique(facility_id, rate_type, band_order, effective_from))

statutory_fee_schedules(                      -- KMPDC licence fees, ODPC fees, renewal dates
  id uuid primary key, facility_id uuid not null,
  authority text,                             -- kmpdc | odpc | ppb | kmlttb | rpb | nssf | kra
  category text, amount numeric(12,2), currency text default 'KES',
  renewal_month int, renewal_day int, penalty_note text,
  effective_from date, effective_to date, source_url text, active boolean)

sha_adjudication_codes(                       -- SHA response/adjudication code list
  id uuid primary key, facility_id uuid not null,
  code text, description text, category text, -- approved | reduced | rejected | info
  retryable boolean, action_hint text, active boolean,
  unique(facility_id, code))

integration_settings(                         -- eTIMS, KHIS, SHA portal connection config
  id uuid primary key, facility_id uuid not null,
  integration text,                           -- etims | khis | sha_portal | sms | payments
  environment text,                           -- sandbox | production
  base_url text, spec_version text, mode text,   -- oscu | vscu for eTIMS
  credential_ref text,                        -- secret-manager / env key name, never the secret
  timeout_ms int, max_attempts int, backoff_seconds int[],
  enabled boolean, last_verified_at timestamptz, last_verified_by text,
  unique(facility_id, integration, environment))
```

Rules for this table family:

- **Secrets never live in the database.** `credential_ref` names an environment variable or secret-manager entry. The value is read at call time and never returned by a query.
- **Every write is validated.** `data_type` drives coercion; `allowed_values`, `min_value`/`max_value` and `regex` are enforced in the command, not only in the form.
- **Unset is a valid state.** A missing required setting yields `missing` in the readiness status and blocks only the action that depends on it, with the key named in the error.
- **Changes are audited and effective-dated.** A settings change writes an audit row with the old and new value, and takes effect from `effective_from`; past documents re-render against the values in force when they were produced.
- **`integration_settings` is the only place an endpoint lives.** Sandbox and production are separate rows; a sandbox row can never be used when `environment = production` is requested, and vice versa.

## 7. Non-negotiables

These apply to every Kenya prompt in addition to the global non-negotiables in `README.md`.

1. **No write bypasses a command.** Every regulatory write (consent, breach, empanelment, claim, eTIMS transmission, report run) goes through a command with an idempotency key, one transaction, an audit row and an outbox row.
2. **Append-only.** Consents, breaches, report runs, eTIMS queue rows, claims and remittances are never hard deleted. Corrections are reversal/void rows with a reason.
3. **Facility scoping.** Every regulatory row carries `facility_id`. Regulatory data never crosses facilities.
4. **Numbering by the write authority only.** Report run references, claim references, eTIMS control numbers and consent references are allocated by the facility's write authority.
5. **Statutory controls are enforced, not advisory.** An expired KMPDC licence, an expired SHA empanelment, a missing consent or a closed fiscal period must stop the specific action, with the block reason audited.
6. **Reports reconcile.** Every statutory report must reconcile to its source operational data, and every financial report must reconcile to the general ledger and the stock ledger.
7. **Immutable documents.** A submitted report run, a transmitted eTIMS invoice and a submitted claim cannot be edited. Corrections issue a new version, a credit note or a rework row.
8. **Regulator config is data, not code.** Tariffs, benefit limits, statutory rates, eTIMS endpoints and report templates are versioned records with effective dates, never hard-coded constants.
9. **Open questions are configuration, not blockers.** Every **[verify]** item in §10 is an admin-editable, validated field (§6.6). The build proceeds with the field present and a safe default; the facility fills in the real value. A missing value degrades readiness to `missing` and blocks only the dependent action — it never crashes a screen or blocks an unrelated workflow.

## 8. Acceptance criteria

### Global

- V1 clinical acceptance criteria continue to pass.
- All existing tests pass; every new business rule in §9 has a test.
- `npm run typecheck`, `npm run lint` and `npm test` are clean.
- Every new table has a migration, and migrations follow `03-database-schema.md`.
- Every new screen loads the relevant UI/UX skill first and follows `06-ui-design-system.md` plus the Varian palette from `AGENTS.md`.
- Clinic-mode sync carries every new table with the same zero-duplicate guarantees as clinical data.
- Every **[verify]** item in §10 is an editable, validated field (§6.6) with a seeded default; no unconfirmed regulator value is hard-coded or guessed.

### Kenya-specific

- A facility with an expired KMPDC licence cannot finalise an invoice, submit a SHA claim or generate a statutory report for a future period.
- A claim cannot be created without an active SHA empanelment for the fund.
- A report run can be regenerated only inside an open period, and a submitted run cannot be altered.
- Every MOH form renders with the facility letterhead, county/sub-county, Epi Week/week ending/month/year, and the Submitted By / Received By block.
- Every MOH form's arithmetic identities hold (see §9 Prompt 20).
- No eTIMS invoice can be transmitted without a valid facility PIN, and no transmitted invoice can be edited.
- No patient data can be shared with a payer without a valid consent.
- A data-subject request carries a due date and cannot be closed without an outcome.
- Every eTIMS and SHA integration call is idempotent and retry-safe.
- A settings change is effective-dated and audited, and never rewrites a document that was produced under the previous value.

## 9. Kenya build prompts 18–22

Run one at a time. Each prompt assumes the previous one is merged, tested and pushed. Before each prompt: *"Read docs/opencode-handover/*.md first. Follow them exactly. Write tests for every business rule."*

---

### Prompt 18 — Kenya master data, licences and regulatory identifiers

**Objective.** Make the facility's legal identity, licences and regulatory identifiers first-class data so that every downstream control (billing, claiming, reporting, tax) can be enforced.

**Scope in.** Facility regulatory profile; practitioner registrations; support-service licences; generic facility identifiers; licence alert rules; the admin-input configuration tables from §6.6 (`facility_settings`, `statutory_fee_schedules`, `sha_adjudication_codes`, `integration_settings`, `statutory_rates`); readiness status command and query.

**Scope out.** SHA empanelment detail and benefit tariffs (Prompt 22); actual ODPC registration process (facility's legal obligation, only the record is modelled); PPB/KMLTTB/RPB portal integrations.

**Data model.** §6.1 plus §6.6. Add the `regulatory_readiness` domain to `src/server/db/schema/` (one file per aggregate, matching the existing `finance.ts` / `revenue.ts` split) and register them in `db/schema/index.ts`.

**Commands** (`src/server/commands/regulatory.ts`):

| Command | Rules |
|---|---|
| `upsertFacilityRegulatoryProfile` | KRA PIN must match `^P\d{9}[A-Z]$`; KEPH level 1–6; licence status derived from dates if not supplied; county/sub-county required for MOH reporting |
| `updateFacilityLicence` | Cannot backdate an issue date past the previous expiry; a renewal must reference the previous licence row (append, never overwrite) |
| `upsertPractitionerRegistration` | Registration number required per regulator; licence status derived from expiry; `verified_by` required to set `verified_at` |
| `verifyPractitionerLicence` | Only a user with `admin` or the new `regulatory_officer` role can verify; records who verified and when |
| `upsertSupportServiceLicence` | Expiry required; service type must be one of the enum values |
| `createLicenceAlertRule` | `warn_days` and `block_days` must be positive; at least one role must be notified |
| `getFacilityReadinessStatus` | Returns per-domain status: `kmpdc`, `sha`, `odpc`, `tax`, `pharmacy`, `laboratory`, `imaging`, each `compliant` / `expiring` / `expired` / `missing`, with days-to-expiry |
| `listExpiringLicences` | Filter by subject type, days-to-expiry, facility, branch |
| `upsertFacilitySetting` | `data_type` drives coercion; `allowed_values`, `min_value`/`max_value` and `regex` enforced server-side; a required setting cannot be cleared; a secret is stored only as a `credential_ref`, never as a value |
| `upsertStatutoryRate` | Effective dates must not overlap for the same `(rate_type, band_order)`; `lower_bound` ≤ `upper_bound`; rate 0–100; a rate change appends a new row |
| `upsertStatutoryFeeSchedule` | Amount ≥ 0; renewal month 1–12; effective dates must not overlap for `(authority, category)`; `source_url` required |
| `upsertShaAdjudicationCode` | Code unique per facility; category from `approved`/`reduced`/`rejected`/`info`; deactivation is a flag, not a delete |
| `upsertIntegrationSetting` | `environment` and `mode` enums; `credential_ref` required; sandbox and production are separate rows; a raw secret in `base_url` or any text field is rejected |
| `verifyIntegrationConnection` | Read-only health check against the configured endpoint; records `last_verified_at`/`last_verified_by`; never transmits a document |

**Queries** (`src/server/queries/regulatory.ts`): `getFacilityRegulatoryProfile`, `listPractitionerRegistrations`, `listSupportServiceLicences`, `getFacilityReadinessStatus`, `listExpiringLicences`, `getFacilityIdentifiers`, `getFacilitySetting(domain, key)`, `listFacilitySettings(domain)`, `listStatutoryRates(rateType, onDate)`, `listStatutoryFeeSchedules(authority)`, `listShaAdjudicationCodes`, `getIntegrationSetting(integration, environment)`.

**Roles and permissions.** Add `regulatory_officer` to `staff_role_enum`. Grant it read access to all of `/admin/regulatory` and write access to the regulatory commands. `admin` retains full access. `accountant` and `finance_officer` get read access. Existing `getAdminSections` behaviour is preserved.

**Business rules to test (every one needs a test):**

1. KRA PIN format is enforced (`P` + 9 digits + 1 letter); an invalid PIN is rejected with a field error.
2. KEPH level must be 1–6.
3. Licence status is derived correctly from `licence_expiry_date` versus today (`active` / `expiring` / `expired`).
4. A facility licence expiring in 30 days reports `expiring`; expired reports `expired`.
5. `getFacilityReadinessStatus` returns `expired` for a domain whose licence is past expiry and `missing` where no record exists.
6. Practitioner registration is unique per `(facility, practitioner, regulator)`; a duplicate upsert updates rather than inserts.
7. Only `admin` / `regulatory_officer` can verify a practitioner licence; a cashier's attempt returns 403.
8. A licence alert rule with no notify roles is rejected.
9. Renewing a facility licence appends a new row and preserves the previous row (append-only).
10. `listExpiringLicences` returns exactly the rows inside the requested window and nothing outside it.
11. A command replay with the same idempotency key returns the original result and creates no second row.
12. Every regulatory write produces an audit row with `module = 'regulatory'`.
13. A setting value outside `allowed_values`, below `min_value`, above `max_value` or failing `regex` is rejected with a field error naming the key.
14. A required setting left unset makes readiness report `missing` for its domain, and the dependent command's error names the missing key.
15. A setting change is effective-dated and audited with the old and new value; reading a past date returns the value that was in force then.
16. A secret setting returns only its `credential_ref`; no query or API response ever contains the secret value.
17. Two statutory rate rows for the same `(rate_type, band_order)` cannot overlap in effective dates.
18. An `integration_settings` row for `environment = sandbox` is never returned when production is requested, and vice versa.
19. Every key listed in §10 has a seeded row after `npm run db:seed`, so a fresh facility renders every settings screen and reports `missing` — never an error.

**Enforcement hook (the point of the prompt).** Add a `assertFacilityReady(facilityId, domain)` guard used by `billing.ts` (invoice finalisation), `revenue.ts` (claim creation) and Prompt 20's report generation. Default policy: `expired` blocks billing and claiming, warns on reporting; `missing` warns everywhere except where the domain is billing-critical, where it blocks and names the missing key. The policy is data-driven via `licence_alert_rules`.

**UI.** `/admin/regulatory` with sections: facility profile, practitioner registrations, support-service licences, identifiers, alerts, and **settings**. The settings section is tabbed by domain (`regulatory`, `tax`, `reporting`, `sha`, `payroll`, `privacy`, `quality`, `integrations`) and renders each field from its `data_type`, `allowed_values`, range and regex — so a new key needs no new screen. Every field shows its current value, its effective date, who last changed it, and a `missing` badge when unset. Secret fields show only the credential reference and a "Test connection" action. Readiness summary cards at the top (green/amber/red per domain, colour never the only signal — include text labels and days). Practitioner table with licence expiry column and a filter "expiring in 30 days". Load `tastemaker` and `emil-design-eng` first; keep the Varian palette.

**Acceptance criteria.** All 19 rules have passing tests; the readiness screen renders for a facility with one expired licence and shows `expired` with the days count; a facility with an expired licence cannot finalise an invoice (test asserts the thrown error and the audit row); the settings screen renders every §10 key with its seeded default, and entering a value moves readiness from `missing` to `compliant`; typecheck/lint/test clean; migration applied and seeded facility `FAM` carries the profile row with KRA PIN `P052292910Q` and every unconfirmed field left `null` and reported `missing` — never guessed.

**Definition of done.** Migration committed; commands, queries, guard and screen merged; tests green; `07-build-prompts.md` ticked.

---

### Prompt 19 — Data protection (ODPC)

**Objective.** Give the facility the apparatus the Data Protection Act 2019 requires: lawful basis and consent, data-subject rights, breach management, retention, sharing agreements, cross-border transfer assessment, DPO role and per-record access audit.

**Scope in.** Consent capture and withdrawal; data-subject requests; breach register; retention policies; sharing agreements; transfer assessments; chart access log; DPO role and privacy inbox; the `privacy` domain settings from §6.6 (`dsar_sla_days`, `breach_notification_hours`, `consent_validity_months`).

**Scope out.** ODPC portal submission mechanics; encryption at rest (infrastructure, not app); the facility's own registration (a legal obligation, only recorded).

**Data model.** §6.2.

**Commands** (`src/server/commands/privacy.ts`):

| Command | Rules |
|---|---|
| `recordConsent` | Consent version must be unique per `(facility, patient, type, version)`; `granted_at` required when `granted`; a new version supersedes the previous version for that type |
| `withdrawConsent` | Sets `withdrawn_at`; a withdrawn consent cannot be un-withdrawn — record a new consent instead; withdrawal is immediate for all new processing |
| `createDataSubjectRequest` | Computes `due_at` from `facility_settings` key `privacy.dsar_sla_days` (default 30); identity verification flag required before `in_progress` |
| `completeDataSubjectRequest` | Requires an `outcome`; an `erasure` outcome creates a restriction/retention record, never a hard delete |
| `recordBreach` | Reference is allocated from a regulatory scope; `severity` required; `affected_subjects` required |
| `notifyBreach` | Sets `odpc_notified_at`; cannot notify before discovery; records who notified |
| `createSharingAgreement` | Counterparty type and lawful basis required; expiry required for processors |
| `recordTransferAssessment` | Destination country and mechanism required; review date required; approval recorded |
| `exportPatientData` | Produces a complete portable export (record + encounters + invoices + payments + consents + audit) for a data-subject request; only `dpo` / `admin` |
| `restrictPatientRecord` | Marks a patient restricted so future access requires a reason that is audited |
| `logChartAccess` | Called by the patient chart screen; records user, patient, timestamp, device and IP |

**Queries** (`src/server/queries/privacy.ts`): `listConsents`, `getConsentStatus(patientId, type)`, `listDataSubjectRequests`, `getOverdueDataSubjectRequests`, `listBreaches`, `listRetentionDue`, `listSharingAgreements`, `listTransferAssessments`, `getChartAccessHistory`.

**Roles.** Add `dpo` (Data Protection Officer) with full access to `/admin/privacy` and read access to all consent and breach data. `admin` retains access. Clinical roles see only the consent chip on the patient banner, never the privacy workspace.

**Business rules to test:**

1. A consent is `valid` only when `granted` is true, `withdrawn_at` is null and today is within `valid_from`/`valid_to`.
2. Recording a new consent version makes the previous version invalid for new processing.
3. Withdrawing consent takes effect immediately: a payer data share attempted afterwards is refused.
4. A claim or invoice that shares patient data with a payer requires a valid `payer_sharing` consent; without it the command throws and audits the refusal.
5. A minor's `treatment` consent requires a `guardian` consent record; without it the command throws.
6. `createDataSubjectRequest` sets `due_at` = received + the `privacy.dsar_sla_days` setting (default 30); changing the setting affects only requests created afterwards; an `access` request and a `correction` request both get a due date.
7. A request cannot move to `completed` without an `outcome`.
8. An `erasure` request creates a restriction record and does not delete any row (assert the row count is unchanged).
9. A breach cannot be marked notified before `discovered_at`.
10. A breach with `severity = high` and `odpc_notified_at` null is returned by `getOverdueDataSubjectRequests`-style breach alerting (implement `listOverdueBreaches`).
11. `exportPatientData` includes every encounter, invoice, payment and consent for the patient, and nothing for any other patient.
12. A restricted patient chart requires a reason; the reason and the access are written to `chart_access_log`.
13. Only `dpo` / `admin` can run `exportPatientData`; a doctor gets 403.
14. A sharing agreement past its expiry cannot be selected for a new payer data share.
15. Every privacy command writes an audit row and an outbox row; a replay with the same idempotency key returns the original result.

**UI.** `/admin/privacy` with tabs: Consents, Requests, Breaches, Retention, Sharing, Transfers, Access log. Patient banner gains a consent status chip (e.g. "Consent: current", "Consent: missing", "Restricted") that is text + colour, never colour alone. A consent capture dialog at patient registration, versioned and hash-stored. A breach form with a visible notification clock. Load `tastemaker` and `accessibility-audit` first.

**Acceptance criteria.** All 15 rules pass; a patient with no `payer_sharing` consent cannot have a claim created (integration test through `revenue.ts`); an erasure request leaves the database row count unchanged; the consent chip renders on the patient banner; typecheck/lint/test clean.

**Definition of done.** Migration, commands, queries, DPO role, privacy workspace and consent dialog merged; tests green; README privacy section updated.

---

### Prompt 20 — MOH statutory reporting

**Objective.** Reproduce the facility's statutory return set from operational data, parameterised by branch and period, with the exact MOH envelope and arithmetic, print/Excel/CSV output, a full run audit trail, and drill-down to source rows. This is the highest-value gap exposed by the Discovery.

**Scope in.** Report catalogue; generic run + cell store; report definitions; generators for **705A, 705B, 717, 505, 710A, 710B, 416, 735**; notifiable-event triggers; birth and death notification registers; export (screen, print, CSV, XLSX); run submission and void.

**Scope out.** KHIS/DHIS2 machine export (separate later phase, but design the cell store so it can be projected); 204A/204B, FORM 1A/1B, 301, 510/511, 222/270/740 and TB ACF generators (Prompt 20b, queued next); ICD-11 coding beyond what `diagnoses` already stores.

**Data model.** §6.3.

**Commands** (`src/server/commands/reporting.ts`):

| Command | Rules |
|---|---|
| `generateReportRun` | Period must be open (not in a closed fiscal period); period must not be in the future; report must be enabled; `epi_week`/`epi_year` derived from the MOH epi-week definition when the schedule is weekly; idempotent on `(report, branch, period)` |
| `regenerateReportRun` | Allowed only while the run is `draft` or `generated` and the period is still open; increments `template_version` and writes a new `report_cells` set; never mutates a `submitted` run |
| `exportReportRun` | Formats `csv`, `xlsx`, `pdf`; the export must equal the on-screen cells (same checksum) |
| `submitReportRun` | Requires a `generated` run; writes `submitted_at`, `submitted_by`, allocates a submission reference; makes the run immutable |
| `voidReportRun` | Requires a reason; allowed only for `draft`/`generated` runs, or for a `submitted` run by a `regulatory_officer` / `admin`; writes `voided_at` and keeps all cells |
| `createNotifiableEvent` | Immediate notification flag when the disease is on the epidemic-prone list; links the patient and encounter; allocates a reference |
| `submitNotifiableEvent` | Records `reported_at` and `reported_to`; a submitted event appears in the next weekly 505 |
| `createBirthNotification` / `createDeathNotification` | Allocates a notification number; links mother/patient and encounter; feeds MOH 717 and the registers |

**Report definitions — exact row sets.**

**MOH 705A — under-5 daily outpatient morbidity.** Columns: day `01..31` + `Total`. Rows (minimum set, matching the Discovery sheet): 1 Diarrhoea with no dehydration; 2 Diarrhoea with some dehydration; 3 Diarrhoea with severe dehydration; 4 Cholera; 5 Dysentery (bloody diarrhoea); 6 Gastroenteritis; 7 Pneumonia; 8 Severe pneumonia; 9 Upper respiratory tract infections; 10 Lower respiratory tract infections; 11 Asthma; 12 Presumed tuberculosis; 13 Suspected malaria; 14 Tested for malaria; 15 Confirmed malaria; 16 Ear infection; 17 Malnutrition; 18 Anaemia; 19 Meningococcal meningitis; 20 Other meningitis; then the remaining notifiable and residual rows. Each row counts patients under 5 by primary diagnosis.

**MOH 705B — over-5 daily outpatient morbidity.** Same day columns. Rows as in the Discovery sheet: Diarrhoea; Tuberculosis; Dysentery/bloody diarrhoea; Cholera; Meningococcal meningitis; Other meningitis; Tetanus; Poliomyelitis (AFP); Chicken pox; Measles; Hepatitis; Mumps; Suspected malaria; Confirmed malaria; Malaria in pregnancy; Amoebiasis; Typhoid fever; Sexually transmitted infections; Urinary tract infections; Bilharzia (schistosomiasis); Intestinal worms; Malnutrition; Anaemia; Eye infections/conditions; Ear infections/conditions; Upper respiratory tract infections; Asthma; Pneumonia; Other lower respiratory tract infections; Abortion; Dis. of puerperium & childbirth; Hypertension; Mental disorders; Dental disorders; Jiggers infestation; Diseases of the skin; Arthritis, joint pains etc; Poisoning; Road traffic injuries; Death due to road traffic injuries; Other injuries; Sexual violence; Violence related injuries; Burns; and the residual rows. Each row counts patients 5 and over.

**MOH 717 — monthly workload.** Section A outpatient services, columns `NEW`, `RE-ATTENDANCE`, `TOTAL`:
- A.1 General outpatients (filter clinics): A.1.1 Over 5 Male; A.1.2 Over 5 Female; A.1.3 Children Under 5 Male; A.1.4 Children Under 5 Female; A.1.5 Over 60 Years; A.1.5 (total general outpatients).
- A.2 Casualty.
- A.3.0 Direct service patients (sent directly to lab, radiology, pharmacy or procedure room).
- A.3 Specialty clinics: A.3.1 CCC; A.3.2 Chest clinic; A.3.3 Dental clinic; A.3.4 Dermatology special clinic; A.3.5 Diabetic clinic; A.3.6 ENT consultation; A.3.7 Eye consultation; A.3.8 Gynaecology clinic; A.3.9 Maternity; A.3.10 Minor theatre; A.3.11 MOPC clinic; A.3.12 Nutrition; and the remaining specialty rows in the full template.
- Further sections of the template (inpatient, maternity, notifiable, laboratory, imaging) are added in Prompt 20b.

**MOH 505 — IDSR weekly.** Two-column layout, each disease with `<5 Years` cases/deaths, `>=5 Years` cases/deaths, `Total` cases/deaths. Left: Acute Jaundice; Acute Malnutrition; AEFI*; AFP (Poliomyelitis); Anthrax; Cholera; Dengue; Dysentery (Bacillary); Guinea Worm Disease (Dracunculiasis); Malaria; Maternal Deaths; Measles. Right: Neonatal deaths; Neonatal Tetanus; Others (Specify); Plague; Rabies; Rift Valley Fever; SARI (Cluster >=3 cases); Suspected MDR/XDR TB; Typhoid; VHF***; Yellow Fever. Laboratory block: Malaria; Shigella Dysentery; Tuberculosis (MDR/XDR); Typhoid, each with `Tested` and `+ve` for `<5`, `>=5` and `Total`. Footnotes: `*Adverse Events Following Immunization`, `**Acute Flaccid Paralysis`, `***Viral Haemorrhagic Fever: Ebola, Marburg, Rift Valley Fever, Crimean Congo Haemorrhagic Fever`.

**MOH 710A — EPI coverage.** Columns day `01..31` + `Total`. Rows: BCG; OPV (within two weeks); OPV1; OPV2; OPV3; IPV (given with OPV3); DPT+HIB+HEPB1; DPT+HIB+HEPB2; DPT+HIB+HEPB3; Pneumococcal1; Pneumococcal2; Pneumococcal3; Rota1; Rota2; Vitamin A; Yellow Fever; Measles1; Measles2; Tetanus toxoid for pregnant woman (TT1–TT5 rows); plus the remaining antigen rows in the template.

**MOH 710B — antigen movement.** Per antigen, rows: [A] Doses in stock at the beginning of the month; [B] Doses received within the month; [C] Total doses stocked in the month (A+B); [D] Doses remaining at the end of the month; [E] Doses used in the month; [F] No. of children vaccinated during the month; [G] Doses wasted in the month; [H] Wastage rate in the month. Ends with the Submitted By / Received By signature block.

**MOH 416 — eye clinic register.** Visit-level register with columns: No; Visit Id; Branch; Patient No; Patient Name; Age; Gender; County; Residence; Phone; V.A(RE); V.A(LE); Disability Type; Impression; Final Diagnosis; Management; Date; Time Registered; Time Seen; Registered By; Seen By; Pay Type; Last Stage; Referral. Summary blocks: Depts Breakdown (New / Revisit / Review / Walk-In / Total); Doctors Breakdown; Diagnosis Breakdown; Patients Residency Breakdown (Branch / Total / Percentage); Branches Breakdown; Patients Seen/Not Seen Summary (total seen, total not seen, direct service patients, net patients seen/clerks); Queue Stage Breakdown; Age Breakdown (`<5`, `5-<16`, `≥16` × New/Revisit × Male/Female); Visual Acuity (Low Vision VA in better eye 6/18–3/60; Blind VA in better eye <3/60–NPL, by sex).

**MOH 735 — eye summary.** A Total Workload (age `<5 yrs`, `5-<16 yrs`, `≥16 yrs` × New M/F, Revisits M/F); B Visual Acuity (Low Vision, Blind × M/F); C Inpatient Work Load – Eye Ward (number of beds, admissions, discharges); D Clinical Diagnosis (Normal eye; Amblyopia; Aphakia; Cataract; Cerebral Visual Impairment; Chalazion; Conjunctival Growths; Conjunctivitis Allergic/Bacterial/Fungal/Viral; Corneal Scar – injury or infection; Corneal Ulcer; Corneal/Conjunctival FB; and the remaining rows) × Normal (6/6–6/18) / Low Vision (>6/18–3/60) / Blind (<3/60–NPL) × age band × M/F.

**Arithmetic identities that must be enforced and tested.**

1. 705A and 705B: every row `Total` = sum of day columns.
2. 705A and 705B: a day total equals the count of qualifying encounters for that day (reconciles to `encounters` + `diagnoses`).
3. 717: `A.1.5 Total general outpatients` = sum of A.1.1–A.1.4 for both NEW and RE-ATTENDANCE; each `TOTAL` column = NEW + RE-ATTENDANCE.
4. 705A/B + 717 must not double count: a patient counted in 705A is under 5, in 705B is 5 and over, and 717's under-5 rows equal 705A's totals for the same period (test the identity).
5. 710B: `C = A + B`; `D = C − E − G`; wastage rate `H = G / E` (guard divide-by-zero).
6. 505: `Total cases = <5 cases + >=5 cases`; same for deaths; laboratory `Tested` and `+ve` totals equal the age-band sums.
7. 416: `Net patients seen/clerks` = total seen − total not seen; residency percentages sum to 100%.
8. 735: diagnosis `Total` = Normal + Low Vision + Blind.
9. Every run's `row_count` equals the number of `report_cells` rows written, and `checksum` is stable for identical inputs.

**Queries** (`src/server/queries/reporting.ts`): `getReportCatalogue`, `getReportRun`, `listReportRuns`, `getReportCells`, `drillDownReportCell`, `listNotifiableEvents`, `listOverdueNotifiableEvents`, `getReportRunAuditTrail`.

**Roles.** `regulatory_officer` and `admin` can generate, export, submit and void. `finance_officer`, `accountant` and `revenue_cycle_officer` can generate and export the reports in their domain. All clinical roles have read access to the report workspace. Export and submit are audited.

**Business rules to test (in addition to the arithmetic identities):**

1. A report cannot be generated for a future period.
2. A report cannot be generated for a period in a closed fiscal period.
3. A weekly report derives the MOH epi week and epi year correctly for a date (including a date that falls in the previous calendar year).
4. `generateReportRun` is idempotent: a second call with the same `(report, branch, period)` returns the same run and writes no new cells.
5. `regenerateReportRun` on a `submitted` run is refused.
6. `voidReportRun` requires a reason and preserves every cell.
7. `exportReportRun` produces a file whose checksum matches the on-screen cells.
8. A submitted run appears in the audit trail with submitter and timestamp and cannot be regenerated.
9. An immediate notifiable event (e.g. cholera) sets the immediate flag and appears in the next weekly 505's total.
10. A birth notification increases the relevant 717 birth rows; a death notification increases the death rows.
11. A report cell's `source_query` returns exactly the rows that produced the cell value (drill-down reconciliation test).
12. Every command writes an audit row and an outbox row; a replay returns the original result.

**UI.** `/reports` workspace. Left: catalogue grouped by domain (Morbidity, Workload, IDSR, EPI, Eye, Inpatient, Child Welfare, Diabetes, TB). Parameter panel: branch, period type, period, epi week (auto-derived, overridable). Preview: the MOH sheet exactly as in the Discovery — letterhead block, county/district, Epi Week / week ending / month / year, the grid, and the Submitted By / Received By block. Actions: Generate, Regenerate, Export (CSV/XLSX/PDF), Submit, Void. A "Source" drawer per cell for drill-down. A runs table with status and checksum. Load `tastemaker`, `emil-design-eng` and `accessibility-audit` first; print CSS for the statutory layout.

**Acceptance criteria.** All arithmetic identities and all 12 rules have passing tests; 705A, 705B, 717, 505, 710A, 710B, 416 and 735 render from a seeded month of data and match the Discovery sheet structure; the 705A/705B/717 cross-form identity holds; drill-down returns the exact source rows; typecheck/lint/test clean.

**Definition of done.** Migration, report engine, eight generators, reporting workspace and exports merged; tests green; the eight Discovery sheets are attached to the PR as the visual acceptance reference.

---

### Prompt 21 — eTIMS electronic tax invoicing (KRA)

**Objective.** Make every invoice a KRA-valid electronic tax invoice with a durable, idempotent, retry-safe transmission queue and a correction path that never edits a transmitted invoice.

**Scope in.** Tax code master; eTIMS invoice envelope and queue; OSCU/VSCU adapters with sandbox and production targets; automatic enqueue on invoice finalisation; retry with backoff; credit notes; transmission log; KRA transactions screen.

**Scope out.** VAT return filing (KRA portal, not app); PAYE/NSSF/SHIF payroll taxes (Prompt 15 / ERP-3); buyer-initiated invoicing for small suppliers (facility is the seller, not the buyer).

**Data model.** §6.4.

**Commands** (`src/server/commands/tax.ts`):

| Command | Rules |
|---|---|
| `upsertTaxCode` | Rate 0–100; effective dating must not overlap another row for the same `(facility, code)` |
| `enqueueEtimsInvoice` | Facility must have a valid KRA PIN; invoice must be finalised; `idempotency_key` unique; allocates nothing (KRA allocates the control number) |
| `transmitEtimsInvoice` | Only `pending` / `failed`; calls the adapter; on success stores `kra_control_no`, `kra_signature`, `qr_url`, `cu_no`, sets `acknowledged`; on failure records the error and schedules `next_attempt_at` |
| `retryEtimsInvoice` | Honours backoff from `integration_settings`; caps attempts at the configured `max_attempts`; never retransmits an `acknowledged` invoice |
| `cancelEtimsInvoice` | Issues a **credit note** linked to the original; never mutates the original |
| `getEtimsInvoiceStatus` | Returns queue state, attempts, last error, control number, QR |
| `reconcileEtimsQueue` | Flags invoices still `pending` past a threshold and produces a report |

**Integration adapter** (`src/server/integrations/etims/`): `client.ts` (config, signing, request/response mapping), `oscu.ts`, `vscu.ts`, `sandbox.ts`, `spec.ts` (field mapping driven by `integration_settings.spec_version`, so a new specification version is a configuration row plus a mapping module — not an edit to the queue). Endpoints, mode, spec version, timeout, attempts and backoff all come from `integration_settings` (§6.6) and env-held credentials, never hard-coded. The adapter must be testable against a stubbed HTTP client.

**Business rules to test:**

1. A facility without a KRA PIN cannot enqueue an invoice (command throws, audits).
2. Invoice numbers are allocated per facility and year with no gaps and no repeats, and the prefix is the facility's (`FAH`).
3. A duplicate `idempotency_key` returns the existing queue row and does not double-enqueue.
4. The sum of invoice lines equals `total_amount`; the tax amount is derived from `tax_codes`, not typed in.
5. A VAT-exempt service produces a valid eTIMS invoice with the exempt treatment and a zero tax amount.
6. A transmitted (`acknowledged`) invoice cannot be edited; the only path is a credit note (assert the original row is byte-identical after the attempt).
7. A failed transmission retries with backoff and `attempts` increments; a retry after a 5xx does not create a duplicate KRA control number (stub the adapter to return the same control number and assert one queue row).
8. A 4xx rejection stores `response_code` / `response_message` and does not retry automatically.
9. `cancelEtimsInvoice` creates a credit note whose amount equals the original and whose `credit_note_of` points at the original; the original stays `acknowledged`.
10. The printed invoice shows the KRA signature/QR and the control number.
11. Sandbox and production endpoints are separate configuration and a sandbox run can never write to the production endpoint.
12. Every queue row has an audit row and an outbox row; the outbox payload is the exact KRA request.
13. `reconcileEtimsQueue` returns exactly the stale `pending` rows and nothing else.

**UI.** `/finance/tax` — the KRA transactions screen, mirroring the Discovery: a filterable table (trans no, invoice no, company, date, patient, amount, status), a "Generate KRA eTIMS signature" action, retry, status refresh, QR preview, and print. Load `tastemaker` and `emil-design-eng` first.

**Acceptance criteria.** All 13 rules pass; an invoice can be finalised, enqueued, transmitted against a stubbed adapter and printed with a signature; a credit note path is tested; typecheck/lint/test clean.

**Definition of done.** Migration, tax master, queue, adapters, commands, queries, KRA screen and print template merged; tests green; `docs/OPERATORS.md` documents the sandbox/production switch.

---

### Prompt 22 — SHA / SHIF revenue cycle

**Objective.** Complete the revenue cycle so a facility can be empaneled, verify eligibility, price against fund tariffs, build and submit claims, handle adjudication and denials, and reconcile SHA payments to the ledger.

**Scope in.** SHA empanelment; fund-specific benefit packages and tariffs; SHA claim identifiers and adjudication; pre-authorisation references; remittance allocation; payment-report reconciliation; waiver/exemption approval.

**Scope out.** The private-payer claims path already in `revenue.ts` (extend, do not replace); SHA portal UI (facility-side only); POMSF overseas referrals.

**Data model.** §6.5, plus `sha_adjudication_codes` from §6.6 for the SHA response code list.

**Commands** (`src/server/commands/revenue.ts` additions, or a new `src/server/commands/sha.ts`):

| Command | Rules |
|---|---|
| `createEmpanelment` | Requires a KMPDC number and an active facility licence; `(facility, fund, scheme)` unique |
| `updateEmpanelmentStatus` | Status transitions are validated; closing requires a reason; closing blocks new claims |
| `createBenefitPackage` | Effective dating must not overlap; a package must belong to one fund |
| `createShaClaim` | Requires an `active` empanelment for the fund; every line must be covered by the benefit package (or explicitly co-paid/excluded); pre-auth required above the threshold; amount = sum of lines |
| `submitShaClaim` | Requires a `draft` claim; allocates `sha_claim_ref` and `submission_batch`; only a user who did not prepare the claim (separation of duties) |
| `recordShaRemittance` | Requires an `approved`/`paid` claim; allocates against claim lines; cannot exceed the approved amount without a waiver/exemption approval |
| `recordShaDenial` | Requires a code that exists in `sha_adjudication_codes` and a reason; a denied claim can be reworked into a new version, never edited |
| `reworkShaClaim` | Copies the denied claim into a new draft with the denial reason attached; links the two |
| `reconcileShaPaymentReport` | Imports the published payment report by KMPDC number and period; matches to claims; computes variance; posts the cash to the ledger |
| `verifyShaEligibility` | Records the eligibility check result against the patient and payer |
| `approveWaiver` / `approveExemption` | Requires a reason and an approver other than the requester; links to the invoice/claim |

**Business rules to test:**

1. A claim cannot be created without an `active` SHA empanelment for the fund.
2. A claim cannot be created for an expired or terminated empanelment.
3. A claim line whose benefit package coverage is `excluded` is rejected or converted to a patient co-pay, never silently billed to SHA.
4. A line above the `preauth_threshold` without a pre-authorisation is rejected.
5. `createShaClaim` amount equals the sum of its lines (assert to the cent).
6. Pre-authorisation expiry blocks a claim that relies on an expired authorisation.
7. A claim cannot be submitted by the same user who prepared it (segregation of duties).
8. `sha_claim_ref` is allocated once and never changes across rework.
9. A remittance cannot exceed `approved_amount` without a waiver/exemption approval (assert the refusal and the audit row).
10. A remittance allocates to specific claim lines and the allocation sums to the remittance amount.
11. A denied claim requires a code and reason, and a rework creates a new linked draft rather than editing the original.
12. `reconcileShaPaymentReport` matches by KMPDC number and period; an unmatched SHA payment produces a variance row and cannot be silently written off.
13. The reconciliation posts cash to the general ledger and the trial balance still balances (integration test through `ledger.ts`).
14. Every claim is traceable to an encounter and an invoice (test the join returns the source rows).
15. Every SHA command writes an audit row and an outbox row; a replay with the same idempotency key returns the original result.

**Queries** (`src/server/queries/sha.ts`): `listEmpanelments`, `getBenefitPackage`, `getPatientBenefitCoverage`, `listShaClaims`, `getShaClaim`, `listShaRemittances`, `getShaReconciliation`, `getShaClaimAging`.

**Roles.** `revenue_cycle_officer` owns the SHA workspace. `finance_officer` and `accountant` get read access plus remittance and reconciliation. `cashier` can verify eligibility and record a co-pay. `admin` retains all. Separation of duties is enforced in the command layer, not only hidden in the UI.

**UI.** `/finance/revenue/sha` with tabs: Empanelment, Eligibility, Pre-authorisation, Claims, Remittances, Reconciliation, Denials. Claim builder shows the benefit package coverage per line (covered / co-pay / excluded / pre-auth required) before submission. Reconciliation shows SHA reported vs facility invoiced vs matched with variance. Denials show the reason and a rework action. Load `tastemaker`, `emil-design-eng` and `accessibility-audit` first.

**Acceptance criteria.** All 15 rules pass; an end-to-end test takes a patient from eligibility check → pre-auth → claim → adjudication → remittance → ledger posting → reconciliation with a balanced trial balance; typecheck/lint/test clean.

**Definition of done.** Migration, SHA commands/queries, workspace and print-ready claim/remittance documents merged; tests green; the SHA layer is documented in `docs/OPERATORS.md`.

---

### Prompt 20b (queued) — remaining statutory forms

After Prompt 20 lands, extend the same engine to **MOH 204A, 204B, FORM 1A, FORM 1B, 301-IPD, 510, 511, 222, 270, 740 and TB ACF**, plus the remaining sections of MOH 717 (inpatient, maternity, notifiable, laboratory, imaging) and the full MOH 710A antigen row set. Reuse `report_catalogue`, `report_runs`, `report_cells` and `report_definitions` unchanged; only add definitions and generators. Then add the KHIS/DHIS2 export adapter.

## 10. Open questions — captured as admin-input fields

None of these block the build. Each one is a field the facility's administrator completes through the UI, with the default and validation shown. Until it is filled in, the value is `null`, `getFacilityReadinessStatus` reports `missing` for that domain, and only the action that depends on it is blocked — with the missing key named in the error. The storage for each is defined in §6.6.

| # | Question | Entered at — field | Default / validation | Owner |
|---|---|---|---|---|
| 1 | KMPDC number, KEPH level and licence category | `/admin/regulatory` → Facility profile: `facility_regulatory_profiles.kmpdc_number`, `.keph_level`, `.facility_category` | `null`; KEPH integer 1–6; category from the KMPDC category list | Facility |
| 2 | KMPDC fee schedule and next renewal date | `/admin/regulatory` → Fees: `statutory_fee_schedules` (authority `kmpdc`); profile `licence_expiry_date` | `null`; amount ≥ 0; renewal month 1–12 | KMPDC / facility |
| 3 | ODPC registration number, category, expiry | `/admin/regulatory` → Facility profile: `odpc_registration_no`, `.odpc_category`, `.odpc_expiry_date` | `null`; expiry must be a future date at entry | Facility |
| 4 | Whether the cloud deployment is inside Kenya | `/admin/privacy` → Transfers: `transfer_assessments.destination_country` | `Kenya`; assessment required before identified data may sync to cloud | Facility / vendor |
| 5 | SHA empanelment status per fund, scheme codes, tariff version | `/finance/revenue/sha` → Empanelment: `sha_empanelments` | `null`; fund enum `phf`/`shif`/`eccif`; unique per `(facility, fund, scheme_code)` | SHA / facility |
| 6 | SHA claim data set and adjudication code list | `/finance/revenue/sha` → Codes: `sha_adjudication_codes`; `benefit_package_items.sha_service_code` | Seeded with the codes published in the regulations; editable per facility | SHA |
| 7 | eTIMS specification version and sandbox credentials | `/admin/regulatory/settings?tab=integrations` → `integration_settings` (integration `etims`) | `spec_version` `null`; `credential_ref` required; sandbox and production are separate rows | KRA / integrator |
| 8 | KHIS/DHIS2 export format and manual-versus-API reporting | `/admin/regulatory/settings?tab=reporting` → `facility_settings` domain `reporting`: `khis_submission_mode`, `khis_api_url`, `khis_org_unit_id` | `manual`; mode enum `manual`/`api`; URL required only when `api` | MOH / KHIS |
| 9 | Statutory rates: PAYE bands, NSSF tiers, SHIF, housing levy | `/admin/regulatory/settings?tab=payroll` → `statutory_rates` (ERP-3 payroll reads the same rows) | Seeded from the latest published schedule and flagged for confirmation; effective-dated, never overwritten | KRA / NSSF / SHA |
| 10 | PPB, KMLTTB and Radiation Protection Board licence numbers and expiry | `/admin/regulatory` → Support services: `support_service_licences` | `null`; `expiry_date` required; service type from enum | Facility |
| 11 | Status of the Draft Quality Healthcare and Patient Safety Bill, 2025 | `/admin/settings/quality` → `facility_settings` domain `quality`: `quality_bill_status` | `pending`; tracking only, never enforced in logic | MOH |
| 12 | Data-subject request SLA and breach notification window | `/admin/privacy` → Settings: `facility_settings` domain `privacy`: `dsar_sla_days`, `breach_notification_hours`, `consent_validity_months` | `30` days, `72` hours, `12` months; positive integers; change is audited | ODPC / facility |

**Handling a supplied answer.** When the facility provides a real value, the admin enters it in the field above and the readiness status moves from `missing` to `compliant` (or `expiring`). Update the Default column here at the same time so this document remains the record of what was assumed. Values that a regulator revises later are new effective-dated rows, never edits to the old row.

## 11. Regulator reference

| Regulator | Portal | Notes |
|---|---|---|
| KMPDC | kmpdc.go.ke · osp.kmpdc.go.ke · registers.kmpdc.go.ke | Annual facility licence, practitioner licence, CPD |
| ODPC | odpc.go.ke · dataportal.odpc.go.ke | Registration, breach reporting, complaints, guidance notes |
| SHA | sha.go.ke · econtracting.sha.go.ke · portal.sha.go.ke · afyayangu.go.ke | Empanelment, tariffs, claims, payment reports |
| KRA | kra.go.ke · etims.kra.go.ke · etims-sbx.kra.go.ke · itax.kra.go.ke | eTIMS, PIN, tax obligations |
| MOH | health.go.ke · hiskenya.org · kmhfl.health.go.ke · guidelines.health.go.ke | KHIS, KMHFL, guidelines, UHC regulations |
| NSSF | nssf.or.ke · selfservice.nssf.or.ke | Statutory contributions |
| PPB | pharmacyboardkenya.org | Pharmacy licensing |
| KMLTTB | kmlttb.go.ke | Laboratory licensing |
| KEMSA | kemsa.co.ke | Public medical supplies |

## 12. Traceability

| Kenya requirement | Prompt | Artifact |
|---|---|---|
| Facility / practitioner / support-service licences | 18 | `facility_regulatory_profiles`, `practitioner_registrations`, `support_service_licences` |
| Consent, rights, breach, retention, transfer | 19 | `data_consents`, `data_subject_requests`, `data_breaches`, `retention_policies`, `transfer_assessments` |
| MOH statutory returns | 20 / 20b | `report_catalogue`, `report_runs`, `report_cells`, generators |
| IDSR immediate notification | 20 | `notifiable_events` |
| Births and deaths notification | 20 | `birth_notifications`, `death_notifications` |
| eTIMS | 21 | `tax_codes`, `etims_invoice_queue`, adapter |
| SHA / SHIF | 22 | `sha_empanelments`, `benefit_packages`, `sha_payment_reconciliation` |
| Statutory payroll deductions | 18 / 15 (ERP-3) | `statutory_rates` + payroll engine |
| Unconfirmed regulator values | 18 | `facility_settings`, `statutory_fee_schedules`, `sha_adjudication_codes`, `integration_settings` and the §10 fields |
