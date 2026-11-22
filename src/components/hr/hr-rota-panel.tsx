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
  SUBTLE_BUTTON_CLASS,
  todayIso,
  type HrPanelProps,
} from "@/components/hr/hr-types";

function attendanceTone(status: string): "success" | "warning" | "danger" | "info" {
  if (status === "present") return "success";
  if (status === "half_day") return "warning";
  if (status === "absent") return "danger";
  return "info";
}

export function RotaPanel({ data, canWrite, busy, run }: HrPanelProps) {
  const [shiftCode, setShiftCode] = useState("");
  const [shiftName, setShiftName] = useState("");
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("17:00");
  const [shiftId, setShiftId] = useState("");
  const [assignEmployeeId, setAssignEmployeeId] = useState("");
  const [assignedDate, setAssignedDate] = useState(todayIso());
  const [attendanceEmployeeId, setAttendanceEmployeeId] = useState("");
  const [workDate, setWorkDate] = useState(todayIso());
  const [status, setStatus] = useState("present");
  const [hours, setHours] = useState("8");
  const [note, setNote] = useState("");

  async function submitShift(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "createShiftTemplate",
      { code: shiftCode, name: shiftName, startTime, endTime },
      "Shift template created",
    );
    if (ok) {
      setShiftCode("");
      setShiftName("");
    }
  }

  async function submitAssignment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "assignShift",
      { employeeId: assignEmployeeId, shiftTemplateId: shiftId, assignedDate },
      "Shift assigned",
    );
    if (ok) setAssignEmployeeId("");
  }

  async function submitAttendance(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "recordAttendance",
      {
        employeeId: attendanceEmployeeId,
        workDate,
        status,
        hoursWorked: Number(hours),
        note: note || null,
      },
      "Attendance recorded",
    );
    if (ok) {
      setAttendanceEmployeeId("");
      setNote("");
    }
  }

  return (
    <div className="space-y-4">
      {canWrite ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="Shift template" description="Define the standard start and end time.">
            <form onSubmit={submitShift} className="space-y-3">
              <Field label="Code">
                <input className={INPUT_CLASS} value={shiftCode} onChange={(e) => setShiftCode(e.target.value)} placeholder="DAY" required />
              </Field>
              <Field label="Name">
                <input className={INPUT_CLASS} value={shiftName} onChange={(e) => setShiftName(e.target.value)} placeholder="Day shift" required />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Start">
                  <input type="time" className={INPUT_CLASS} value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
                </Field>
                <Field label="End">
                  <input type="time" className={INPUT_CLASS} value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
                </Field>
              </div>
              <button type="submit" className={SUBTLE_BUTTON_CLASS} disabled={busy}>
                Add shift
              </button>
            </form>
          </Panel>

          <Panel title="Assign shift" description="A single shift per employee per day.">
            <form onSubmit={submitAssignment} className="space-y-3">
              <Field label="Employee">
                <select className={INPUT_CLASS} value={assignEmployeeId} onChange={(e) => setAssignEmployeeId(e.target.value)} required>
                  <option value="">Select employee</option>
                  {data.payrollEmployees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.employeeNo} {employee.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Shift">
                <select className={INPUT_CLASS} value={shiftId} onChange={(e) => setShiftId(e.target.value)} required>
                  <option value="">Select shift</option>
                  {data.shiftTemplates.filter((shift) => shift.active).map((shift) => (
                    <option key={shift.id} value={shift.id}>
                      {shift.code} {shift.startTime}-{shift.endTime}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Date">
                <input type="date" className={INPUT_CLASS} value={assignedDate} onChange={(e) => setAssignedDate(e.target.value)} required />
              </Field>
              <button type="submit" className={SUBTLE_BUTTON_CLASS} disabled={busy || data.shiftTemplates.length === 0}>
                Assign
              </button>
            </form>
          </Panel>

          <Panel title="Record attendance" description="Absent and leave days record zero hours.">
            <form onSubmit={submitAttendance} className="space-y-3">
              <Field label="Employee">
                <select className={INPUT_CLASS} value={attendanceEmployeeId} onChange={(e) => setAttendanceEmployeeId(e.target.value)} required>
                  <option value="">Select employee</option>
                  {data.payrollEmployees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.employeeNo} {employee.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Work date">
                <input type="date" className={INPUT_CLASS} value={workDate} onChange={(e) => setWorkDate(e.target.value)} required />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Status">
                  <select className={INPUT_CLASS} value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="present">Present</option>
                    <option value="half_day">Half day</option>
                    <option value="absent">Absent</option>
                    <option value="leave">Leave</option>
                  </select>
                </Field>
                <Field label="Hours">
                  <input type="number" min="0" max="24" step="0.25" className={INPUT_CLASS} value={hours} onChange={(e) => setHours(e.target.value)} required />
                </Field>
              </div>
              <Field label="Note">
                <input className={INPUT_CLASS} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <button type="submit" className={BUTTON_CLASS} disabled={busy}>
                Save attendance
              </button>
            </form>
          </Panel>
        </div>
      ) : null}

      <Panel title="Shift templates" description="Available rota patterns at this facility." testId="hr-shift-list">
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Code</th>
                <th scope="col" className={TH_CLASS}>Name</th>
                <th scope="col" className={TH_CLASS}>Time</th>
                <th scope="col" className={TH_CLASS}>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.shiftTemplates.length === 0 ? (
                <EmptyRow colSpan={4} message="No shift templates have been created yet." />
              ) : (
                data.shiftTemplates.map((shift) => (
                  <tr key={shift.id}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{shift.code}</td>
                    <td className={TD_CLASS}>{shift.name}</td>
                    <td className={`${TD_CLASS} font-mono tabular-nums`}>{shift.startTime}-{shift.endTime}</td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={shift.active ? "success" : "neutral"}>
                        {shift.active ? "active" : "inactive"}
                      </StatusPill>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Attendance" description="Most recent records across the facility." testId="hr-attendance-list">
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Employee</th>
                <th scope="col" className={TH_CLASS}>Date</th>
                <th scope="col" className={TH_CLASS}>Status</th>
                <th scope="col" className={TH_CLASS}>Hours</th>
                <th scope="col" className={TH_CLASS}>Note</th>
              </tr>
            </thead>
            <tbody>
              {data.attendance.length === 0 ? (
                <EmptyRow colSpan={5} message="No attendance has been recorded yet." />
              ) : (
                data.attendance.map((row) => (
                  <tr key={row.id}>
                    <td className={TD_CLASS}>{row.employeeName}</td>
                    <td className={TD_CLASS}>{formatDate(row.workDate)}</td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={attendanceTone(row.status)}>{row.status.replaceAll("_", " ")}</StatusPill>
                    </td>
                    <td className={`${TD_CLASS} font-mono tabular-nums`}>{row.hoursWorked}</td>
                    <td className={TD_CLASS}>{row.note ?? "—"}</td>
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
