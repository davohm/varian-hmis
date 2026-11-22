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
  type ProcurementPanelProps,
} from "@/components/procurement/procurement-types";

export function SuppliersPanel({
  data,
  canWrite,
  busy,
  run,
}: Pick<ProcurementPanelProps, "data" | "canWrite" | "busy" | "run">) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [terms, setTerms] = useState("30");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "createSupplier",
      {
        code,
        name,
        contactName: contact || null,
        phone: phone || null,
        email: email || null,
        paymentTermsDays: Number(terms),
      },
      "Supplier added",
    );
    if (ok) {
      setCode("");
      setName("");
      setContact("");
      setPhone("");
      setEmail("");
      setTerms("30");
    }
  }

  return (
    <div className="space-y-4">
      {canWrite ? (
        <Panel title="Add supplier" description="Suppliers are scoped to this facility.">
          <form onSubmit={submit} className="grid gap-3 md:grid-cols-3">
            <Field label="Code">
              <input
                className={INPUT_CLASS}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="SUP-001"
                required
              />
            </Field>
            <Field label="Supplier name" className="md:col-span-2">
              <input
                className={INPUT_CLASS}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Registered supplier name"
                required
              />
            </Field>
            <Field label="Contact person">
              <input
                className={INPUT_CLASS}
                value={contact}
                onChange={(event) => setContact(event.target.value)}
              />
            </Field>
            <Field label="Phone">
              <input
                className={INPUT_CLASS}
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </Field>
            <Field label="Email">
              <input
                type="email"
                className={INPUT_CLASS}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field label="Payment terms (days)">
              <input
                type="number"
                min={0}
                max={365}
                className={INPUT_CLASS}
                value={terms}
                onChange={(event) => setTerms(event.target.value)}
                required
              />
            </Field>
            <div className="flex items-end md:col-span-3">
              <button type="submit" className={BUTTON_CLASS} disabled={busy}>
                Add supplier
              </button>
            </div>
          </form>
        </Panel>
      ) : null}

      <Panel
        title="Supplier register"
        description={`${data.suppliers.length} supplier${data.suppliers.length === 1 ? "" : "s"}`}
        testId="procurement-supplier-list"
      >
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>Code</th>
                <th scope="col" className={TH_CLASS}>Name</th>
                <th scope="col" className={TH_CLASS}>Contact</th>
                <th scope="col" className={TH_CLASS}>Terms</th>
                <th scope="col" className={TH_CLASS}>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.suppliers.length === 0 ? (
                <EmptyRow colSpan={5} message="No suppliers have been registered yet." />
              ) : (
                data.suppliers.map((supplier) => (
                  <tr key={supplier.id}>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{supplier.code}</td>
                    <td className={TD_CLASS}>{supplier.name}</td>
                    <td className={TD_CLASS}>
                      {[supplier.contactName, supplier.phone, supplier.email]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </td>
                    <td className={TD_CLASS}>{supplier.paymentTermsDays} days</td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={supplier.active ? "success" : "neutral"}>
                        {supplier.active ? "Active" : "Inactive"}
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
