# 01 — Product Requirements (PRD)

## 1. Goal
Clinic patients get registered, seen, tested, treated and sent home cared for.
**North-star metric:** patient visits completed through to discharge per day.

## 2. Context
Outpatient clinics and multi-branch medical centres in Kenya with unreliable internet. The clinic must keep working fully on its LAN when the internet is down and sync to the cloud when it returns.

## 3. Users / roles
| Role | Key job |
|---|---|
| receptionist | Find/register patients, check into queue |
| triage_nurse | Record vitals, triage category, route to doctor |
| doctor | SOAP notes, diagnoses, lab orders, prescriptions |
| lab_tech | Collect samples, enter and verify results |
| pharmacist | Dispense from batches (FEFO), manage stock |
| cashier | Bill, take payments (Cash, M-Pesa, card, insurance), receipts |
| admin | Facilities, branches, stores, staff, prices, catalogs, audit |

A user may hold multiple roles; access is scoped to assigned facilities/branches.

## 4. Patient journey
Reception → Triage → Doctor → (Lab ↔ Doctor) → Pharmacy → Cashier → Discharge.
Each hand-off is a `queue_entries` row; every station sees its live queue.

## 5. Modules & requirements

### 5.1 Reception & Registry
- Search by name, phone, national ID, MRN (debounced, < 300 ms on 100k patients).
- Duplicate warning on matching phone + DOB or national ID.
- Register: names, DOB/estimated age, sex, phone, national ID, address, next of kin, payer (Cash / SHA / Insurance + member no.), allergies.
- MRN format `FAM-YY-NNNNN`, sequential per facility per year.
- Start visit (encounter) and queue to Triage.

### 5.2 Triage
- Queue ordered by priority then arrival.
- Vitals: BP, HR, RR, Temp °C, SpO2 %, weight, height, BMI (auto), pain score, MUAC for children.
- Triage category: red / yellow / green with out-of-range highlighting.
- Chief complaint, nurse comments, next steps; route to doctor/room.

### 5.3 Doctor (OPD)
- Pinned patient banner: name, age, sex, MRN, allergies, latest vitals, payer.
- SOAP notes, ICD-10 diagnoses (primary/secondary).
- Lab orders from catalog, prescriptions (drug, dose, route, frequency, days, auto-qty).
- View returned lab results in the same encounter; history of past visits.
- Discharge / refer / admit-request outcome.

### 5.4 Laboratory
- Worklist: pending collection, collected, in progress, completed.
- Sample ID, collection time, result entry per parameter with reference range auto-flag (H/L/critical).
- Verification by a second action; result visible to doctor immediately.

### 5.5 Pharmacy
- Prescription queue; stock by store and batch with expiry.
- FEFO batch suggestion; partial dispense with reason; label print.
- Stock receive, adjust, transfer — all as ledger entries.

### 5.6 Cashier
- Bill auto-built from consultation, lab tests, dispensed drugs via price list for payer.
- Payments: cash, M-Pesa (ref code), card, insurance (auth no.); split tender.
- Sequential receipt numbers `FAM-R-YY-NNNNNN`; receipts immutable, voids by reversal.
- Cashier session open/close with end-of-day reconciliation.

### 5.7 Administration
- Facilities, branches, departments, rooms, stores (Pharmacy, Main Store, Lab).
- Staff accounts + roles + facility scopes; deactivate.
- Catalogs: items, lab tests, services, price lists, ICD-10 import.
- Audit log viewer (user, action, module, entity, timestamp, device, IP).
- Sync monitor (local mode): status, pending count, last sync, failed rows + retry.

## 6. Non-functional
- Works offline on clinic LAN; no data loss on power cut (UPS + Postgres durability).
- Page interactions < 200 ms on LAN; supports 30 concurrent stations per clinic.
- All mutations audited; no hard deletes of clinical/financial records.
- Data protection: Kenya Data Protection Act 2019 — least-privilege access, encrypted backups.
- Mobile/tablet usable (≥ 768 px), desktop optimised.

## 7. Out of scope for V1
Inpatient wards, theatre, radiology PACS and patient portal are not part of the V1 clinical release.

The ERP scope is not abandoned. Finance and revenue cycle, procurement and inventory, HR and payroll, assets and maintenance, and ERP management reporting are specified in [09-erp-scope.md](09-erp-scope.md) and delivered after V1 through the ERP build prompts.

## 8. Acceptance (V1 done when)
1. Reception registers a patient; triage sees them within 2 s on another computer.
2. Full journey through discharge works with internet unplugged at the clinic server.
3. Reconnecting syncs all records to the cloud with zero duplicates.
4. Receipt and MRN numbers never repeat or skip under concurrent use.
5. A user without a role cannot open or call that role's screens or actions.
