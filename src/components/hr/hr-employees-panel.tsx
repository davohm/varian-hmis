"use client";

import { useState } from "react";

import {
  EmptyRow,
  Field,
  INPUT_CLASS,
  Panel,
  StatusPill,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
} from "@/components/finance/finance-primitives";
import {
  BUTTON_CLASS,
  formatDate,
  type HrPanelProps,
} from "@/components/hr/hr-types";

function statusTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "active") return "success";
  if (status === "on_leave") return "warning";
  if (status === "terminated") return "danger";
  return "neutral";
}

export function EmployeesPanel({ data, canWrite, busy, run }: HrPanelProps) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [nationalId, setNationalId] = useState("");
  const [phone, setPhone] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [dateOfJoining, setDateOfJoining] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "createEmployee",
      {
        firstName,
        lastName,
        nationalId: nationalId || null,
        phone: phone || null,
        bankName: bankName || null,
        bankAccountNumber: bankAccount || null,
        dateOfJoining: dateOfJoining || null,
      },
      "Employee registered",
    );
    if (ok) {
      setFirstName("");
      setLastName("");
      setNationalId("");
      setPhone("");
      setBankName("");
      setBankAccount("");
      setDateOfJoining("");
    }
  }

  return (
    <div className="space-y-4">
      {canWrite ? (
        <Panel
          title="Register employee"
          description="Personnel records are retained and retired by status, never deleted."
        >
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <Field label="First name">
                <input className={INPUT_CLASS} value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
              </Field>
              <Field label="Last name">
                <input className={INPUT_CLASS} value={lastName} onChange={(e) => setLastName(e.target.value)} required />
              </Field>
              <Field label="National ID">
                <input className={INPUT_CLASS} value={nationalId} onChange={(e) => setNationalId(e.target.value)} />
              </Field>
              <Field label="Phone">
                <input className={INPUT_CLASS} value={phone} onChange={(e) => setPhone(e.target.value)} />
              </Field>
              <Field label="Bank">
                <input className={INPUT_CLASS} value={bankName} onChange={(e) => setBankName(e.target.value)} />
              </Field>
              <Field label="Bank account">
                <input className={INPUT_CLASS} value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} />
              </Field>
              <Field label="Date of joining">
                <input type="date" className={INPUT_CLASS} value={dateOfJoining} onChange={(e) => setDateOfJoining(e.target.value)} />
              </Field>
            </div>
            <button type="submit" className={BUTTON_CLASS} disabled={busy}>
              Register employee
            </button>
          </form>
        </Panel>
      ) : null}

      <Panel title="Employees" description="Active and retired personnel at this facility." testId="hr-employee-list">
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Number</th>
                <th scope="col" className={TH_CLASS}>Name</th>
                <th scope="col" className={TH_CLASS}>National ID</th>
                <th scope="col" className={TH_CLASS}>Bank</th>
                <th scope="col" className={TH_CLASS}>Joined</th>
                <th scope="col" className={TH_CLASS}>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.employees.length === 0 ? (
                <EmptyRow colSpan={6} message="No employees have been registered yet." />
              ) : (
                data.employees.map((employee) => (
                  <tr key={employee.id}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{employee.employeeNo}</td>
                    <td className={TD_CLASS}>{employee.name}</td>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{employee.nationalId ?? "—"}</td>
                    <td className={TD_CLASS}>{employee.bankName ?? "—"}</td>
                    <td className={TD_CLASS}>{employee.dateOfJoining ? formatDate(employee.dateOfJoining) : "—"}</td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={statusTone(employee.employmentStatus)}>
                        {employee.employmentStatus.replaceAll("_", " ")}
                      </StatusPill>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
