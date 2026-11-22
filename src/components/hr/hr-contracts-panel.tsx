"use client";

import { useState } from "react";

import {
  EmptyRow,
  Field,
  INPUT_CLASS,
  Panel,
  StatusPill,
  SubHeading,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
} from "@/components/finance/finance-primitives";
import {
  BUTTON_CLASS,
  formatDate,
  formatMoney,
  SUBTLE_BUTTON_CLASS,
  todayIso,
  type HrPanelProps,
} from "@/components/hr/hr-types";

export function ContractsPanel({ data, canWrite, busy, run }: HrPanelProps) {
  const [positionCode, setPositionCode] = useState("");
  const [positionTitle, setPositionTitle] = useState("");
  const [grade, setGrade] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [positionId, setPositionId] = useState("");
  const [contractType, setContractType] = useState("permanent");
  const [startDate, setStartDate] = useState(todayIso());
  const [endDate, setEndDate] = useState("");
  const [salary, setSalary] = useState("");

  async function submitPosition(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "createPosition",
      { code: positionCode, title: positionTitle, grade: grade || null },
      "Position created",
    );
    if (ok) {
      setPositionCode("");
      setPositionTitle("");
      setGrade("");
    }
  }

  async function submitContract(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "createEmploymentContract",
      {
        employeeId,
        positionId,
        contractType,
        startDate,
        endDate: endDate || null,
        basicSalary: salary,
      },
      "Contract recorded",
    );
    if (ok) {
      setEmployeeId("");
      setPositionId("");
      setSalary("");
      setEndDate("");
    }
  }

  return (
    <div className="space-y-4">
      {canWrite ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="New position" description="Positions are the cost-bearing roles used by contracts.">
            <form onSubmit={submitPosition} className="space-y-3">
              <Field label="Code">
                <input className={INPUT_CLASS} value={positionCode} onChange={(e) => setPositionCode(e.target.value)} placeholder="NURSE-01" required />
              </Field>
              <Field label="Title">
                <input className={INPUT_CLASS} value={positionTitle} onChange={(e) => setPositionTitle(e.target.value)} placeholder="Staff Nurse" required />
              </Field>
              <Field label="Grade">
                <input className={INPUT_CLASS} value={grade} onChange={(e) => setGrade(e.target.value)} />
              </Field>
              <button type="submit" className={SUBTLE_BUTTON_CLASS} disabled={busy}>
                Add position
              </button>
            </form>
          </Panel>

          <Panel title="New contract" description="Creating a contract retires the employee's prior active contract.">
            <form onSubmit={submitContract} className="space-y-3">
              <Field label="Employee">
                <select className={INPUT_CLASS} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required>
                  <option value="">Select employee</option>
                  {data.payrollEmployees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.employeeNo} {employee.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Position">
                <select className={INPUT_CLASS} value={positionId} onChange={(e) => setPositionId(e.target.value)} required>
                  <option value="">Select position</option>
                  {data.positions.filter((position) => position.active).map((position) => (
                    <option key={position.id} value={position.id}>
                      {position.code} {position.title}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="grid gap-3 md:grid-cols-3">
                <Field label="Type">
                  <select className={INPUT_CLASS} value={contractType} onChange={(e) => setContractType(e.target.value)}>
                    <option value="permanent">Permanent</option>
                    <option value="fixed_term">Fixed term</option>
                    <option value="internship">Internship</option>
                    <option value="locum">Locum</option>
                  </select>
                </Field>
                <Field label="Start date">
                  <input type="date" className={INPUT_CLASS} value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
                </Field>
                <Field label="End date">
                  <input type="date" className={INPUT_CLASS} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                </Field>
              </div>
              <Field label="Basic salary">
                <input type="number" min="0" step="0.01" className={INPUT_CLASS} value={salary} onChange={(e) => setSalary(e.target.value)} required />
              </Field>
              <button
                type="submit"
                className={BUTTON_CLASS}
                disabled={busy || data.positions.length === 0 || data.payrollEmployees.length === 0}
              >
                Record contract
              </button>
            </form>
          </Panel>
        </div>
      ) : null}

      <Panel title="Positions" description="Facility roles available for assignment." testId="hr-position-list">
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Code</th>
                <th scope="col" className={TH_CLASS}>Title</th>
                <th scope="col" className={TH_CLASS}>Department</th>
                <th scope="col" className={TH_CLASS}>Grade</th>
                <th scope="col" className={TH_CLASS}>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.positions.length === 0 ? (
                <EmptyRow colSpan={5} message="No positions have been created yet." />
              ) : (
                data.positions.map((position) => (
                  <tr key={position.id}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{position.code}</td>
                    <td className={TD_CLASS}>{position.title}</td>
                    <td className={TD_CLASS}>{position.departmentName ?? "—"}</td>
                    <td className={TD_CLASS}>{position.grade ?? "—"}</td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={position.active ? "success" : "neutral"}>
                        {position.active ? "active" : "retired"}
                      </StatusPill>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Contracts" description="The active contract is the pay basis for payroll." testId="hr-contract-list">
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Employee</th>
                <th scope="col" className={TH_CLASS}>Position</th>
                <th scope="col" className={TH_CLASS}>Type</th>
                <th scope="col" className={TH_CLASS}>Start</th>
                <th scope="col" className={TH_CLASS}>End</th>
                <th scope="col" className={TH_CLASS}>Basic salary</th>
                <th scope="col" className={TH_CLASS}>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.contracts.length === 0 ? (
                <EmptyRow colSpan={7} message="No contracts have been recorded yet." />
              ) : (
                data.contracts.map((contract) => (
                  <tr key={contract.id}>
                    <td className={TD_CLASS}>{contract.employeeName}</td>
                    <td className={TD_CLASS}>{contract.positionTitle}</td>
                    <td className={TD_CLASS}>{contract.contractType.replaceAll("_", " ")}</td>
                    <td className={TD_CLASS}>{formatDate(contract.startDate)}</td>
                    <td className={TD_CLASS}>{contract.endDate ? formatDate(contract.endDate) : "—"}</td>
                    <td className={`${TD_CLASS} font-mono tabular-nums`}>{formatMoney(contract.basicSalary)}</td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={contract.active ? "success" : "neutral"}>
                        {contract.active ? "active" : "superseded"}
                      </StatusPill>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      <SubHeading title="Pay basis" description="Only active contracts covering the payroll period are included in a run." />
    </div>
  );
}
