"use client";

import { useState } from "react";

import {
  Field,
  INPUT_CLASS,
  Panel,
  StatusPill,
} from "@/components/finance/finance-primitives";
import {
  BUTTON_CLASS,
  formatDate,
  SUBTLE_BUTTON_CLASS,
  todayIso,
  type HrPanelProps,
} from "@/components/hr/hr-types";

function leaveTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "approved") return "success";
  if (status === "requested") return "warning";
  if (status === "rejected") return "danger";
  return "neutral";
}

export function LeavePanel({ data, canWrite, busy, run }: HrPanelProps) {
  const [employeeId, setEmployeeId] = useState("");
  const [leaveType, setLeaveType] = useState("annual");
  const [startDate, setStartDate] = useState(todayIso());
  const [endDate, setEndDate] = useState(todayIso());
  const [reason, setReason] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "requestLeave",
      { employeeId, leaveType, startDate, endDate, reason },
      "Leave request submitted",
    );
    if (ok) {
      setEmployeeId("");
      setReason("");
    }
  }

  async function decide(id: string, decision: "approved" | "rejected") {
    const reason = reasons[id]?.trim() ?? "";
    if (decision === "rejected" && !reason) {
      await run("decideLeave", { leaveRequestId: id, decision }, "A reason is required to reject leave");
      return;
    }
    const ok = await run(
      "decideLeave",
      { leaveRequestId: id, decision, reason: reason || null },
      decision === "approved" ? "Leave approved" : "Leave rejected",
    );
    if (ok) setReasons((current) => ({ ...current, [id]: "" }));
  }

  return (
    <div className="space-y-4">
      {canWrite ? (
        <Panel
          title="Request leave"
          description="Approved leave cannot overlap another approved leave period."
        >
          <form onSubmit={submit} className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
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
              <Field label="Leave type">
                <select className={INPUT_CLASS} value={leaveType} onChange={(e) => setLeaveType(e.target.value)}>
                  <option value="annual">Annual</option>
                  <option value="sick">Sick</option>
                  <option value="maternity">Maternity</option>
                  <option value="paternity">Paternity</option>
                  <option value="unpaid">Unpaid</option>
                  <option value="compassionate">Compassionate</option>
                </select>
              </Field>
              <Field label="Reason">
                <input className={INPUT_CLASS} value={reason} onChange={(e) => setReason(e.target.value)} required />
              </Field>
              <Field label="Start date">
                <input type="date" className={INPUT_CLASS} value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
              </Field>
              <Field label="End date">
                <input type="date" className={INPUT_CLASS} value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
              </Field>
            </div>
            <button type="submit" className={BUTTON_CLASS} disabled={busy}>
              Submit request
            </button>
          </form>
        </Panel>
      ) : null}

      <Panel title="Leave register" description="A different user must decide each request." testId="hr-leave-list">
        <div className="space-y-3">
          {data.leave.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No leave has been requested yet.</p>
          ) : (
            data.leave.map((leave) => (
              <div key={leave.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {leave.employeeName} <span className="text-muted-foreground">· {leave.leaveType}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatDate(leave.startDate)} to {formatDate(leave.endDate)} · {leave.days} days
                    </p>
                    <p className="mt-1 text-sm text-foreground">{leave.reason}</p>
                    {leave.rejectedReason ? (
                      <p className="mt-1 text-xs text-[var(--status-critical-foreground)]">
                        Rejected: {leave.rejectedReason}
                      </p>
                    ) : null}
                  </div>
                  <StatusPill tone={leaveTone(leave.status)}>{leave.status}</StatusPill>
                </div>
                {canWrite && leave.status === "requested" ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input
                      className={`${INPUT_CLASS} max-w-xs`}
                      value={reasons[leave.id] ?? ""}
                      onChange={(e) => setReasons((current) => ({ ...current, [leave.id]: e.target.value }))}
                      placeholder="Decision note (required to reject)"
                      aria-label={`Decision note for ${leave.employeeName}`}
                    />
                    <button
                      type="button"
                      className={SUBTLE_BUTTON_CLASS}
                      disabled={busy}
                      onClick={() => void decide(leave.id, "approved")}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className={SUBTLE_BUTTON_CLASS}
                      disabled={busy}
                      onClick={() => void decide(leave.id, "rejected")}
                    >
                      Reject
                    </button>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </Panel>
    </div>
  );
}
