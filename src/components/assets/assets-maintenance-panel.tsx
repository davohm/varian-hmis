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
  type AssetsPanelProps,
} from "@/components/assets/assets-types";

export function MaintenancePanel({ data, canWrite, busy, run }: AssetsPanelProps) {
  const [assetId, setAssetId] = useState("");
  const [type, setType] = useState("corrective");
  const [priority, setPriority] = useState("normal");
  const [scheduledDate, setScheduledDate] = useState("");
  const [assignedToEmployeeId, setAssignedToEmployeeId] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [description, setDescription] = useState("");
  const [partsCost, setPartsCost] = useState("0");
  const [laborCost, setLaborCost] = useState("0");
  const [paymentMethod, setPaymentMethod] = useState("none");

  const [noteOrderId, setNoteOrderId] = useState("");
  const [note, setNote] = useState("");

  async function createOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "createMaintenanceOrder",
      {
        assetId,
        type,
        priority,
        scheduledDate: scheduledDate || null,
        assignedToEmployeeId: assignedToEmployeeId || null,
        vendorName: vendorName.trim() || null,
        description: description.trim(),
        partsCost,
        laborCost,
        paymentMethod,
      },
      "Maintenance order raised",
    );
    if (ok) {
      setAssetId("");
      setScheduledDate("");
      setVendorName("");
      setDescription("");
      setPartsCost("0");
      setLaborCost("0");
      setPaymentMethod("none");
    }
  }

  async function start(orderId: string) {
    await run("startMaintenanceOrder", { orderId, note: null }, "Maintenance work started");
  }

  async function complete(orderId: string) {
    await run("completeMaintenanceOrder", { orderId, note: null }, "Maintenance work completed");
  }

  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!noteOrderId) return;
    const ok = await run(
      "addMaintenanceNote",
      { orderId: noteOrderId, description: note.trim() },
      "Maintenance note recorded",
    );
    if (ok) setNote("");
  }

  const selectedOrder = data.orders.find((order) => order.id === noteOrderId);

  return (
    <div className="space-y-4">
      {canWrite ? (
        <Panel
          title="Raise a maintenance order"
          description="Orders are numbered per facility. Costs are posted only when the work is completed."
          testId="maintenance-create-panel"
        >
          <form onSubmit={createOrder} className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Asset">
                <select
                  className={INPUT_CLASS}
                  value={assetId}
                  onChange={(event) => setAssetId(event.target.value)}
                  required
                >
                  <option value="">Select an asset</option>
                  {data.assets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.assetNo} · {asset.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Type">
                <select
                  className={INPUT_CLASS}
                  value={type}
                  onChange={(event) => setType(event.target.value)}
                >
                  <option value="corrective">Corrective</option>
                  <option value="preventive">Preventive</option>
                  <option value="inspection">Inspection</option>
                </select>
              </Field>
              <Field label="Priority">
                <select
                  className={INPUT_CLASS}
                  value={priority}
                  onChange={(event) => setPriority(event.target.value)}
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </Field>
            </div>
            <div className="grid gap-3 md:grid-cols-4">
              <Field label="Scheduled date" hint="Optional">
                <input
                  type="date"
                  className={INPUT_CLASS}
                  value={scheduledDate}
                  onChange={(event) => setScheduledDate(event.target.value)}
                />
              </Field>
              <Field label="Assigned to" hint="Optional">
                <select
                  className={INPUT_CLASS}
                  value={assignedToEmployeeId}
                  onChange={(event) => setAssignedToEmployeeId(event.target.value)}
                >
                  <option value="">Unassigned</option>
                  {data.employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Vendor" hint="Optional">
                <input
                  className={INPUT_CLASS}
                  value={vendorName}
                  onChange={(event) => setVendorName(event.target.value)}
                  maxLength={160}
                />
              </Field>
              <Field label="Payment method" hint="Required when costs are entered">
                <select
                  className={INPUT_CLASS}
                  value={paymentMethod}
                  onChange={(event) => setPaymentMethod(event.target.value)}
                >
                  <option value="none">No cost</option>
                  <option value="cash">Cash</option>
                  <option value="bank">Bank</option>
                  <option value="accrued">Accrued</option>
                </select>
              </Field>
            </div>
            <Field label="Description">
              <textarea
                className={`${INPUT_CLASS} h-20 py-2`}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={2000}
                required
              />
            </Field>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Parts cost">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className={INPUT_CLASS}
                  value={partsCost}
                  onChange={(event) => setPartsCost(event.target.value)}
                />
              </Field>
              <Field label="Labour cost">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className={INPUT_CLASS}
                  value={laborCost}
                  onChange={(event) => setLaborCost(event.target.value)}
                />
              </Field>
            </div>
            <button type="submit" className={BUTTON_CLASS} disabled={busy}>
              Raise maintenance order
            </button>
          </form>
        </Panel>
      ) : null}

      <Panel
        title="Maintenance orders"
        description="Work moves from open to in progress to completed. Events remain on the asset history."
        testId="maintenance-order-list"
      >
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Order</th>
                <th scope="col" className={TH_CLASS}>Asset</th>
                <th scope="col" className={TH_CLASS}>Type</th>
                <th scope="col" className={TH_CLASS}>Priority</th>
                <th scope="col" className={TH_CLASS}>Status</th>
                <th scope="col" className={TH_CLASS}>Cost</th>
                <th scope="col" className={TH_CLASS}>Journal</th>
                <th scope="col" className={TH_CLASS}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.orders.length === 0 ? (
                <EmptyRow colSpan={8} message="No maintenance orders have been raised yet." />
              ) : (
                data.orders.map((order) => (
                  <tr key={order.id}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{order.orderNo}</td>
                    <td className={TD_CLASS}>{order.assetName}</td>
                    <td className={TD_CLASS}>{order.type}</td>
                    <td className={TD_CLASS}>{order.priority}</td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={assetStatusTone(order.status)}>{order.status}</StatusPill>
                    </td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                      {formatMoney(order.totalCost)}
                    </td>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{order.entryNo ?? "None"}</td>
                    <td className={TD_CLASS}>
                      <div className="flex flex-wrap gap-2">
                        {canWrite && order.status === "open" ? (
                          <button
                            type="button"
                            className={SUBTLE_BUTTON_CLASS}
                            disabled={busy}
                            onClick={() => void start(order.id)}
                          >
                            Start
                          </button>
                        ) : null}
                        {canWrite && order.status === "in_progress" ? (
                          <button
                            type="button"
                            className={BUTTON_CLASS}
                            disabled={busy}
                            onClick={() => void complete(order.id)}
                          >
                            Complete
                          </button>
                        ) : null}
                        {canWrite ? (
                          <button
                            type="button"
                            className={SUBTLE_BUTTON_CLASS}
                            onClick={() => setNoteOrderId(order.id)}
                          >
                            Note
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {canWrite && selectedOrder ? (
        <Panel
          title={`Add note · ${selectedOrder.orderNo}`}
          description="Notes join the asset's maintenance history without changing order costs."
        >
          <form onSubmit={addNote} className="space-y-3">
            <Field label="Note">
              <textarea
                className={`${INPUT_CLASS} h-20 py-2`}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={2000}
                required
              />
            </Field>
            <button type="submit" className={BUTTON_CLASS} disabled={busy}>
              Record note
            </button>
          </form>
        </Panel>
      ) : null}

      {data.detail && data.detail.maintenanceEvents.length > 0 ? (
        <Panel
          title="Maintenance history"
          description={`Recent events for ${data.detail.assetNo}.`}
          testId="maintenance-event-list"
        >
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th scope="col" className={TH_CLASS}>When</th>
                  <th scope="col" className={TH_CLASS}>Event</th>
                  <th scope="col" className={TH_CLASS}>Description</th>
                  <th scope="col" className={TH_CLASS}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.detail.maintenanceEvents.map((event) => (
                  <tr key={event.id}>
                    <td className={TD_CLASS}>{formatDate(event.occurredAt)}</td>
                    <td className={TD_CLASS}>{event.eventType}</td>
                    <td className={TD_CLASS}>{event.description}</td>
                    <td className={`${TD_CLASS} text-right font-mono tabular-nums`}>
                      {formatMoney(event.cost)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
