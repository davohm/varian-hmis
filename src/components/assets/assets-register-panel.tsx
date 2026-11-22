"use client";

import { useState, type FormEvent } from "react";

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
  assetStatusTone,
  BUTTON_CLASS,
  formatDate,
  formatMoney,
  SUBTLE_BUTTON_CLASS,
  todayIso,
  type AssetsPanelProps,
} from "@/components/assets/assets-types";

export function RegisterPanel({ data, canWrite, busy, run, selectAsset }: AssetsPanelProps) {
  const [category, setCategory] = useState("");
  const [name, setName] = useState("");
  const [tagNo, setTagNo] = useState("");
  const [serialNo, setSerialNo] = useState("");
  const [location, setLocation] = useState("");
  const [custodianEmployeeId, setCustodianEmployeeId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [costCenterId, setCostCenterId] = useState("");
  const [acquisitionDate, setAcquisitionDate] = useState(todayIso());
  const [acquisitionCost, setAcquisitionCost] = useState("");
  const [residualValue, setResidualValue] = useState("0");
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("60");
  const [notes, setNotes] = useState("");

  const [eventType, setEventType] = useState("assigned");
  const [toEmployeeId, setToEmployeeId] = useState("");
  const [toLocation, setToLocation] = useState("");
  const [assignmentNote, setAssignmentNote] = useState("");

  const detail = data.detail;

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "createAsset",
      {
        category: category.trim(),
        name: name.trim(),
        tagNo: tagNo.trim() || null,
        serialNo: serialNo.trim() || null,
        location: location.trim(),
        custodianEmployeeId: custodianEmployeeId || null,
        departmentId: departmentId || null,
        costCenterId: costCenterId || null,
        acquisitionDate,
        acquisitionCost,
        residualValue,
        usefulLifeMonths: Number(usefulLifeMonths),
        notes: notes.trim() || null,
      },
      "Asset registered",
    );
    if (ok) {
      setCategory("");
      setName("");
      setTagNo("");
      setSerialNo("");
      setLocation("");
      setCustodianEmployeeId("");
      setAcquisitionCost("");
      setResidualValue("0");
      setNotes("");
    }
  }

  async function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail) return;
    const ok = await run(
      "assignAsset",
      {
        assetId: detail.id,
        eventType,
        toEmployeeId: toEmployeeId || null,
        toLocation: toLocation.trim(),
        note: assignmentNote.trim() || null,
      },
      "Custodian and location updated",
    );
    if (ok) {
      setToEmployeeId("");
      setToLocation("");
      setAssignmentNote("");
    }
  }

  return (
    <div className="space-y-4">
      {canWrite ? (
        <Panel
          title="Register an asset"
          description="Numbers are allocated per facility. Depreciation starts from cost, residual value and useful life."
          testId="asset-create-panel"
        >
          <form onSubmit={register} className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Category">
                <input
                  className={INPUT_CLASS}
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  maxLength={80}
                  placeholder="e.g. Equipment"
                  required
                />
              </Field>
              <Field label="Asset name">
                <input
                  className={INPUT_CLASS}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={500}
                  placeholder="e.g. Ultrasound scanner"
                  required
                />
              </Field>
              <Field label="Location">
                <input
                  className={INPUT_CLASS}
                  value={location}
                  onChange={(event) => setLocation(event.target.value)}
                  maxLength={500}
                  placeholder="Room or department"
                  required
                />
              </Field>
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <Field label="Tag number" hint="Optional">
                <input
                  className={INPUT_CLASS}
                  value={tagNo}
                  onChange={(event) => setTagNo(event.target.value)}
                  maxLength={80}
                />
              </Field>
              <Field label="Serial number" hint="Optional">
                <input
                  className={INPUT_CLASS}
                  value={serialNo}
                  onChange={(event) => setSerialNo(event.target.value)}
                  maxLength={120}
                />
              </Field>
              <Field label="Custodian" hint="Optional">
                <select
                  className={INPUT_CLASS}
                  value={custodianEmployeeId}
                  onChange={(event) => setCustodianEmployeeId(event.target.value)}
                >
                  <option value="">Not assigned</option>
                  {data.employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Department" hint="Optional">
                <select
                  className={INPUT_CLASS}
                  value={departmentId}
                  onChange={(event) => setDepartmentId(event.target.value)}
                >
                  <option value="">None</option>
                  {data.departments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="grid gap-3 md:grid-cols-5">
              <Field label="Cost centre" hint="Optional">
                <select
                  className={INPUT_CLASS}
                  value={costCenterId}
                  onChange={(event) => setCostCenterId(event.target.value)}
                >
                  <option value="">None</option>
                  {data.costCenters.map((center) => (
                    <option key={center.id} value={center.id}>
                      {center.code} · {center.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Acquisition date">
                <input
                  type="date"
                  className={INPUT_CLASS}
                  value={acquisitionDate}
                  onChange={(event) => setAcquisitionDate(event.target.value)}
                  required
                />
              </Field>
              <Field label="Acquisition cost">
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  className={INPUT_CLASS}
                  value={acquisitionCost}
                  onChange={(event) => setAcquisitionCost(event.target.value)}
                  required
                />
              </Field>
              <Field label="Residual value">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className={INPUT_CLASS}
                  value={residualValue}
                  onChange={(event) => setResidualValue(event.target.value)}
                />
              </Field>
              <Field label="Useful life (months)">
                <input
                  type="number"
                  min="1"
                  max="1200"
                  className={INPUT_CLASS}
                  value={usefulLifeMonths}
                  onChange={(event) => setUsefulLifeMonths(event.target.value)}
                  required
                />
              </Field>
            </div>
            <Field label="Notes" hint="Optional">
              <input
                className={INPUT_CLASS}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                maxLength={2000}
              />
            </Field>
            <button type="submit" className={BUTTON_CLASS} disabled={busy}>
              Register asset
            </button>
          </form>
        </Panel>
      ) : null}

      <Panel
        title="Asset register"
        description="Custodian and location are mirrored from the append-only assignment history."
        testId="assets-register-list"
      >
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Asset</th>
                <th scope="col" className={TH_CLASS}>Name</th>
                <th scope="col" className={TH_CLASS}>Location</th>
                <th scope="col" className={TH_CLASS}>Custodian</th>
                <th scope="col" className={TH_CLASS}>Status</th>
                <th scope="col" className={TH_CLASS}>Cost</th>
                <th scope="col" className={TH_CLASS}>Accumulated</th>
                <th scope="col" className={TH_CLASS}>Carrying</th>
                <th scope="col" className={TH_CLASS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.assets.length === 0 ? (
                <EmptyRow colSpan={9} message="No assets have been registered yet." />
              ) : (
                data.assets.map((asset) => (
                  <tr key={asset.id}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>
                      <span className="block">{asset.assetNo}</span>
                      {asset.tagNo ? (
                        <span className="block text-xs text-muted-foreground">{asset.tagNo}</span>
                      ) : null}
                    </td>
                    <td className={TD_CLASS}>{asset.name}</td>
                    <td className={TD_CLASS}>{asset.location}</td>
                    <td className={TD_CLASS}>{asset.custodianName ?? "Unassigned"}</td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={assetStatusTone(asset.status)}>{asset.status}</StatusPill>
                    </td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                      {formatMoney(asset.acquisitionCost)}
                    </td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                      {formatMoney(asset.accumulatedDepreciation)}
                    </td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                      {formatMoney(asset.carryingAmount)}
                    </td>
                    <td className={TD_CLASS}>
                      <button
                        type="button"
                        className={SUBTLE_BUTTON_CLASS}
                        onClick={() => selectAsset(asset.id)}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {detail ? (
        <>
          <Panel
            title={`Asset history · ${detail.assetNo}`}
            description="Assignment events and valuation or disposal history are retained for audit."
            testId="assets-register-detail"
          >
            <div className="mb-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-4">
              <span>Acquired {formatDate(detail.acquisitionDate)}</span>
              <span>Useful life {detail.usefulLifeMonths} months</span>
              <span>Department {detail.departmentName ?? "None"}</span>
              <span>Cost centre {detail.costCenterName ?? "None"}</span>
            </div>
            <div className="overflow-x-auto">
              <table className={TABLE_CLASS}>
                <thead>
                  <tr>
                    <th scope="col" className={TH_CLASS}>When</th>
                    <th scope="col" className={TH_CLASS}>Event</th>
                    <th scope="col" className={TH_CLASS}>From</th>
                    <th scope="col" className={TH_CLASS}>To</th>
                    <th scope="col" className={TH_CLASS}>Custodian</th>
                    <th scope="col" className={TH_CLASS}>By</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.assignments.length === 0 ? (
                    <EmptyRow colSpan={6} message="No custody events recorded for this asset." />
                  ) : (
                    detail.assignments.map((assignment) => (
                      <tr key={assignment.id}>
                        <td className={TD_CLASS}>{formatDate(assignment.occurredAt)}</td>
                        <td className={TD_CLASS}>{assignment.eventType}</td>
                        <td className={TD_CLASS}>{assignment.fromLocation ?? "None"}</td>
                        <td className={TD_CLASS}>{assignment.toLocation}</td>
                        <td className={TD_CLASS}>{assignment.custodianName ?? "Unassigned"}</td>
                        <td className={`${TD_CLASS} font-mono text-xs`}>{assignment.performedBy}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Panel>

          {canWrite ? (
            <Panel
              title="Record custody change"
              description="Append-only event. The current custodian and location are updated on the asset."
            >
              <form onSubmit={assign} className="space-y-3">
                <div className="grid gap-3 md:grid-cols-3">
                  <Field label="Event">
                    <select
                      className={INPUT_CLASS}
                      value={eventType}
                      onChange={(event) => setEventType(event.target.value)}
                    >
                      <option value="assigned">Assigned</option>
                      <option value="transferred">Transferred</option>
                      <option value="returned">Returned</option>
                    </select>
                  </Field>
                  <Field label="New custodian" hint="Optional on return">
                    <select
                      className={INPUT_CLASS}
                      value={toEmployeeId}
                      onChange={(event) => setToEmployeeId(event.target.value)}
                      disabled={eventType === "returned"}
                    >
                      <option value="">Unassigned</option>
                      {data.employees.map((employee) => (
                        <option key={employee.id} value={employee.id}>
                          {employee.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="New location">
                    <input
                      className={INPUT_CLASS}
                      value={toLocation}
                      onChange={(event) => setToLocation(event.target.value)}
                      placeholder={detail.location}
                      required
                    />
                  </Field>
                </div>
                <Field label="Note" hint="Optional">
                  <input
                    className={INPUT_CLASS}
                    value={assignmentNote}
                    onChange={(event) => setAssignmentNote(event.target.value)}
                    maxLength={1000}
                  />
                </Field>
                <button type="submit" className={BUTTON_CLASS} disabled={busy}>
                  Record custody change
                </button>
              </form>
            </Panel>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
