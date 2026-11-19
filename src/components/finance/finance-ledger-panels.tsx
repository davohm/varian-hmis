"use client";

import { Check, Pencil, Plus, RotateCcw, ShieldAlert, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { useFinanceCommand } from "@/components/finance/use-finance-command";

import {
  EmptyRow,
  Field,
  INPUT_CLASS,
  NUMERIC_CLASS,
  Panel,
  StatusPill,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
} from "@/components/finance/finance-primitives";
import {
  formatDate,
  formatMoney,
  todayIso,
  type FinancePanelProps,
  type JournalRow,
  type LedgerAccountRow,
} from "@/components/finance/finance-types";
import { Button } from "@/components/ui/button";
import { LEDGER_ACCOUNT_TYPES, LEDGER_ACCOUNT_TYPE_LABELS } from "@/lib/finance";

/* ------------------------------------------------------------------ */
/* Chart of accounts and cost centres                                  */
/* ------------------------------------------------------------------ */

export function AccountsPanel({ data, canWrite, refresh }: FinancePanelProps) {
  const { busy, error, run, clearError } = useFinanceCommand(refresh);
  const [editing, setEditing] = useState<LedgerAccountRow | null>(null);
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("asset");
  const [systemRole, setSystemRole] = useState("");
  const [active, setActive] = useState(true);
  const [showCostCenterForm, setShowCostCenterForm] = useState(false);
  const [centerCode, setCenterCode] = useState("");
  const [centerName, setCenterName] = useState("");

  function resetAccountForm() {
    setEditing(null);
    setShowAccountForm(false);
    setCode("");
    setName("");
    setType("asset");
    setSystemRole("");
    setActive(true);
    clearError();
  }

  function startEdit(account: LedgerAccountRow) {
    setEditing(account);
    setShowAccountForm(true);
    setCode(account.code);
    setName(account.name);
    setType(account.type);
    setSystemRole(account.systemRole ?? "");
    setActive(account.active);
    clearError();
  }

  async function submitAccount(event: FormEvent) {
    event.preventDefault();
    const ok = editing
      ? await run(
          "updateLedgerAccount",
          {
            accountId: editing.id,
            name,
            active,
            systemRole: systemRole.trim() ? systemRole.trim() : null,
          },
          "Account updated",
        )
      : await run(
          "createLedgerAccount",
          { code, name, type, systemRole: systemRole.trim() ? systemRole.trim() : null },
          "Account created",
        );
    if (ok) resetAccountForm();
  }

  async function submitCostCenter(event: FormEvent) {
    event.preventDefault();
    const ok = await run("createCostCenter", { code: centerCode, name: centerName }, "Cost centre created");
    if (ok) {
      setShowCostCenterForm(false);
      setCenterCode("");
      setCenterName("");
    }
  }

  return (
    <div className="space-y-4">
      <Panel
        testId="finance-accounts-panel"
        title="Chart of accounts"
        description="The facility chart. Codes are immutable; corrections keep the ledger append-only."
        action={
          canWrite ? (
            <Button size="sm" onClick={() => { resetAccountForm(); setShowAccountForm(true); }}>
              <Plus /> New account
            </Button>
          ) : null
        }
      >
        {showAccountForm && canWrite ? (
          <form
            onSubmit={(event) => void submitAccount(event)}
            className="mb-4 grid gap-3 rounded-lg border border-border bg-muted/40 p-3 md:grid-cols-4"
            data-testid="finance-account-form"
          >
            <Field label="Code">
              <input
                className={INPUT_CLASS}
                value={code}
                disabled={!!editing}
                onChange={(event) => setCode(event.target.value)}
                placeholder="e.g. 1010"
                required
              />
            </Field>
            <Field label="Name">
              <input
                className={INPUT_CLASS}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Petty cash"
                required
              />
            </Field>
            <Field label="Type">
              <select
                className={INPUT_CLASS}
                value={type}
                disabled={!!editing}
                onChange={(event) => setType(event.target.value)}
              >
                {LEDGER_ACCOUNT_TYPES.map((accountType) => (
                  <option key={accountType} value={accountType}>
                    {LEDGER_ACCOUNT_TYPE_LABELS[accountType]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="System role" hint="Optional lowercase snake_case">
              <input
                className={INPUT_CLASS}
                value={systemRole}
                onChange={(event) => setSystemRole(event.target.value)}
                placeholder="e.g. service_revenue"
              />
            </Field>
            {editing ? (
              <label className="flex items-center gap-2 self-end text-sm text-foreground md:col-span-4">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(event) => setActive(event.target.checked)}
                  className="size-4 accent-[var(--brand-navy)]"
                />
                Active — available for new postings
              </label>
            ) : null}
            {error ? (
              <p role="alert" className="text-xs text-destructive md:col-span-4">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2 md:col-span-4">
              <Button type="submit" size="sm" disabled={busy}>
                {editing ? "Save account" : "Create account"}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={resetAccountForm}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}

        <div className="overflow-x-auto">
          <table className={TABLE_CLASS} data-testid="finance-accounts-table">
            <thead>
              <tr>
                <th className={TH_CLASS}>Code</th>
                <th className={TH_CLASS}>Account</th>
                <th className={TH_CLASS}>Type</th>
                <th className={TH_CLASS}>Normal</th>
                <th className={TH_CLASS}>System role</th>
                <th className={TH_CLASS}>Status</th>
                {canWrite ? <th className={TH_CLASS}>Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.accounts.length === 0 ? (
                <EmptyRow colSpan={canWrite ? 7 : 6} message="No accounts yet. Create the first ledger account." />
              ) : (
                data.accounts.map((account) => (
                  <tr key={account.id} data-testid={`finance-account-${account.code}`}>
                    <td className={`${TD_CLASS} font-mono`}>{account.code}</td>
                    <td className={TD_CLASS}>{account.name}</td>
                    <td className={`${TD_CLASS} capitalize`}>{account.type}</td>
                    <td className={`${TD_CLASS} capitalize`}>{account.normalBalance}</td>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{account.systemRole ?? "—"}</td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={account.active ? "success" : "neutral"}>
                        {account.active ? "Active" : "Inactive"}
                      </StatusPill>
                    </td>
                    {canWrite ? (
                      <td className={TD_CLASS}>
                        <Button size="xs" variant="outline" onClick={() => startEdit(account)}>
                          <Pencil /> Edit
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        testId="finance-cost-centers-panel"
        title="Cost centres"
        description="Optional dimensions for reporting by department or branch."
        action={
          canWrite ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setShowCostCenterForm((value) => !value); clearError(); }}
            >
              <Plus /> New cost centre
            </Button>
          ) : null
        }
      >
        {showCostCenterForm && canWrite ? (
          <form
            onSubmit={(event) => void submitCostCenter(event)}
            className="mb-4 grid gap-3 rounded-lg border border-border bg-muted/40 p-3 md:grid-cols-3"
            data-testid="finance-cost-center-form"
          >
            <Field label="Code">
              <input className={INPUT_CLASS} value={centerCode} onChange={(event) => setCenterCode(event.target.value)} required />
            </Field>
            <Field label="Name">
              <input className={INPUT_CLASS} value={centerName} onChange={(event) => setCenterName(event.target.value)} required />
            </Field>
            <div className="flex items-end gap-2">
              <Button type="submit" size="sm" disabled={busy}>Create</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setShowCostCenterForm(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS} data-testid="finance-cost-centers-table">
            <thead>
              <tr>
                <th className={TH_CLASS}>Code</th>
                <th className={TH_CLASS}>Name</th>
                <th className={TH_CLASS}>Branch</th>
                <th className={TH_CLASS}>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.costCenters.length === 0 ? (
                <EmptyRow colSpan={4} message="No cost centres defined." />
              ) : (
                data.costCenters.map((center) => (
                  <tr key={center.id}>
                    <td className={`${TD_CLASS} font-mono`}>{center.code}</td>
                    <td className={TD_CLASS}>{center.name}</td>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{center.branchId ?? "Facility-wide"}</td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={center.active ? "success" : "neutral"}>
                        {center.active ? "Active" : "Inactive"}
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

/* ------------------------------------------------------------------ */
/* Fiscal periods                                                      */
/* ------------------------------------------------------------------ */

export function FiscalPeriodsPanel({ data, canWrite, refresh }: FinancePanelProps) {
  const { busy, error, run, clearError } = useFinanceCommand(refresh);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await run(
      "openFiscalPeriod",
      { name, startDate, endDate },
      "Fiscal period opened",
    );
    if (ok) {
      setShowForm(false);
      setName("");
      setStartDate("");
      setEndDate("");
    }
  }

  return (
    <Panel
      testId="finance-periods-panel"
      title="Fiscal periods"
      description="Postings are only accepted while an overlapping period is open. Closing is permanent."
      action={
        canWrite ? (
          <Button size="sm" onClick={() => { setShowForm((value) => !value); clearError(); }}>
            <Plus /> New period
          </Button>
        ) : null
      }
    >
      {showForm && canWrite ? (
        <form
          onSubmit={(event) => void submit(event)}
          className="mb-4 grid gap-3 rounded-lg border border-border bg-muted/40 p-3 md:grid-cols-4"
          data-testid="finance-period-form"
        >
          <Field label="Period name">
            <input className={INPUT_CLASS} value={name} onChange={(event) => setName(event.target.value)} placeholder="FY2026 Q1" required />
          </Field>
          <Field label="Start date">
            <input type="date" className={INPUT_CLASS} value={startDate} onChange={(event) => setStartDate(event.target.value)} required />
          </Field>
          <Field label="End date">
            <input type="date" className={INPUT_CLASS} value={endDate} onChange={(event) => setEndDate(event.target.value)} required />
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit" size="sm" disabled={busy}>Open period</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
          </div>
          {error ? <p role="alert" className="text-xs text-destructive md:col-span-4">{error}</p> : null}
        </form>
      ) : null}
      <div className="overflow-x-auto">
        <table className={TABLE_CLASS} data-testid="finance-periods-table">
          <thead>
            <tr>
              <th className={TH_CLASS}>Period</th>
              <th className={TH_CLASS}>From</th>
              <th className={TH_CLASS}>To</th>
              <th className={TH_CLASS}>Status</th>
              <th className={TH_CLASS}>Closed</th>
              {canWrite ? <th className={TH_CLASS}>Action</th> : null}
            </tr>
          </thead>
          <tbody>
            {data.periods.length === 0 ? (
              <EmptyRow colSpan={canWrite ? 6 : 5} message="No fiscal periods yet. Open a period before posting journals." />
            ) : (
              data.periods.map((period) => (
                <tr key={period.id}>
                  <td className={`${TD_CLASS} font-medium`}>{period.name}</td>
                  <td className={TD_CLASS}>{formatDate(period.startDate)}</td>
                  <td className={TD_CLASS}>{formatDate(period.endDate)}</td>
                  <td className={TD_CLASS}>
                    <StatusPill tone={period.status === "open" ? "success" : "neutral"}>
                      {period.status === "open" ? "Open" : "Closed"}
                    </StatusPill>
                  </td>
                  <td className={`${TD_CLASS} text-xs text-muted-foreground`}>
                    {period.closedAt ? formatDate(period.closedAt) : "—"}
                  </td>
                  {canWrite ? (
                    <td className={TD_CLASS}>
                      {period.status === "open" ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void run("closeFiscalPeriod", { periodId: period.id }, "Fiscal period closed")}
                        >
                          <ShieldAlert /> Close
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">Locked</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Journals                                                            */
/* ------------------------------------------------------------------ */

interface DraftLine {
  key: string;
  accountId: string;
  debit: string;
  credit: string;
  description: string;
}

function blankLine(): DraftLine {
  return { key: crypto.randomUUID(), accountId: "", debit: "", credit: "", description: "" };
}

export function JournalsPanel({ data, canWrite, refresh }: FinancePanelProps) {
  const { busy, error, run, clearError } = useFinanceCommand(refresh);
  const [showForm, setShowForm] = useState(false);
  const [entryDate, setEntryDate] = useState(todayIso());
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([blankLine(), blankLine()]);
  const [reversing, setReversing] = useState<JournalRow | null>(null);
  const [reverseDate, setReverseDate] = useState(todayIso());
  const [reverseReason, setReverseReason] = useState("");

  const debitTotal = lines.reduce((total, line) => total + (Number(line.debit) || 0), 0);
  const creditTotal = lines.reduce((total, line) => total + (Number(line.credit) || 0), 0);
  const balanced = Math.round(debitTotal * 100) === Math.round(creditTotal * 100);

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  async function submitJournal(event: FormEvent) {
    event.preventDefault();
    if (!balanced || debitTotal <= 0) {
      toast.error("Debits must equal credits before a journal can be posted");
      return;
    }
    const ok = await run(
      "postManualJournal",
      {
        entryDate,
        description,
        lines: lines.map((line) => ({
          accountId: line.accountId,
          debit: line.debit || "0",
          credit: line.credit || "0",
          description: line.description.trim() ? line.description.trim() : null,
        })),
      },
      "Journal posted",
    );
    if (ok) {
      setShowForm(false);
      setDescription("");
      setLines([blankLine(), blankLine()]);
    }
  }

  async function submitReversal(event: FormEvent) {
    event.preventDefault();
    if (!reversing) return;
    const ok = await run(
      "reverseJournal",
      { entryId: reversing.id, entryDate: reverseDate, reason: reverseReason },
      "Reversal posted",
    );
    if (ok) {
      setReversing(null);
      setReverseReason("");
    }
  }

  return (
    <div className="space-y-4">
      <Panel
        testId="finance-journals-panel"
        title="Journals"
        description="Every money movement enters the ledger through a balanced journal. Reversals are append-only."
        action={
          canWrite ? (
            <Button size="sm" onClick={() => { setShowForm((value) => !value); clearError(); }}>
              <Plus /> Post journal
            </Button>
          ) : null
        }
      >
        {showForm && canWrite ? (
          <form
            onSubmit={(event) => void submitJournal(event)}
            className="mb-4 space-y-3 rounded-lg border border-border bg-muted/40 p-3"
            data-testid="finance-journal-form"
          >
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Entry date">
                <input type="date" className={INPUT_CLASS} value={entryDate} onChange={(event) => setEntryDate(event.target.value)} required />
              </Field>
              <Field label="Description">
                <input className={INPUT_CLASS} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="e.g. Monthly rent" required />
              </Field>
            </div>

            <div className="space-y-2">
              <div className="grid grid-cols-[2fr_1fr_1fr_2fr_auto] gap-2 text-xs font-medium text-muted-foreground">
                <span>Account</span>
                <span>Debit</span>
                <span>Credit</span>
                <span>Line note</span>
                <span aria-hidden="true" />
              </div>
              {lines.map((line) => (
                <div key={line.key} className="grid grid-cols-[2fr_1fr_1fr_2fr_auto] gap-2">
                  <select
                    className={INPUT_CLASS}
                    value={line.accountId}
                    onChange={(event) => updateLine(line.key, { accountId: event.target.value })}
                    aria-label="Journal line account"
                    required
                  >
                    <option value="">Select account…</option>
                    {data.accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} — {account.name}
                      </option>
                    ))}
                  </select>
                  <input
                    className={INPUT_CLASS}
                    inputMode="decimal"
                    value={line.debit}
                    onChange={(event) => updateLine(line.key, { debit: event.target.value, credit: "" })}
                    placeholder="0.00"
                    aria-label="Debit amount"
                  />
                  <input
                    className={INPUT_CLASS}
                    inputMode="decimal"
                    value={line.credit}
                    onChange={(event) => updateLine(line.key, { credit: event.target.value, debit: "" })}
                    placeholder="0.00"
                    aria-label="Credit amount"
                  />
                  <input
                    className={INPUT_CLASS}
                    value={line.description}
                    onChange={(event) => updateLine(line.key, { description: event.target.value })}
                    placeholder="Optional"
                    aria-label="Line note"
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={lines.length <= 2}
                    onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}
                    aria-label="Remove journal line"
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" size="sm" variant="outline" onClick={() => setLines((current) => [...current, blankLine()])}>
                <Plus /> Add line
              </Button>
              <span className="font-mono text-sm tabular-nums text-foreground">Debit {formatMoney(debitTotal.toFixed(2))}</span>
              <span className="font-mono text-sm tabular-nums text-foreground">Credit {formatMoney(creditTotal.toFixed(2))}</span>
              <StatusPill tone={balanced ? "success" : "danger"}>
                {balanced ? "Balanced" : "Out of balance"}
              </StatusPill>
            </div>

            {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy || !balanced || debitTotal <= 0}>
                Post journal
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
          </form>
        ) : null}

        {reversing && canWrite ? (
          <form
            onSubmit={(event) => void submitReversal(event)}
            className="mb-4 space-y-3 rounded-lg border border-[var(--status-warning)] bg-[var(--status-warning-background)] p-3"
            data-testid="finance-reversal-form"
          >
            <p className="text-sm font-medium text-[var(--status-warning-foreground)]">
              Reverse {reversing.entryNo} — {reversing.description}
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Reversal date">
                <input type="date" className={INPUT_CLASS} value={reverseDate} onChange={(event) => setReverseDate(event.target.value)} required />
              </Field>
              <Field label="Reason">
                <input className={INPUT_CLASS} value={reverseReason} onChange={(event) => setReverseReason(event.target.value)} placeholder="Why is this being reversed?" required />
              </Field>
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy}>Post reversal</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setReversing(null)}>Cancel</Button>
            </div>
          </form>
        ) : null}

        <div className="overflow-x-auto">
          <table className={TABLE_CLASS} data-testid="finance-journals-table">
            <thead>
              <tr>
                <th className={TH_CLASS}>Entry</th>
                <th className={TH_CLASS}>Date</th>
                <th className={TH_CLASS}>Description</th>
                <th className={TH_CLASS}>Source</th>
                <th className={TH_CLASS}>Status</th>
                <th className={`${TH_CLASS} text-right`}>Debit</th>
                <th className={`${TH_CLASS} text-right`}>Credit</th>
                {canWrite ? <th className={TH_CLASS}>Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.journals.length === 0 ? (
                <EmptyRow colSpan={canWrite ? 8 : 7} message="No journals in this date range." />
              ) : (
                data.journals.map((journal) => (
                  <tr key={journal.id} data-testid={`finance-journal-${journal.entryNo}`}>
                    <td className={`${TD_CLASS} font-mono`}>{journal.entryNo}</td>
                    <td className={TD_CLASS}>{formatDate(journal.entryDate)}</td>
                    <td className={TD_CLASS}>
                      <span className="block max-w-xs truncate" title={journal.description}>{journal.description}</span>
                      {journal.reversalReason ? (
                        <span className="block text-xs text-muted-foreground">{journal.reversalReason}</span>
                      ) : null}
                    </td>
                    <td className={`${TD_CLASS} capitalize`}>{journal.sourceType}</td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={journal.status === "posted" ? "success" : "warning"}>
                        {journal.status}
                      </StatusPill>
                    </td>
                    <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{formatMoney(journal.debit)}</td>
                    <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{formatMoney(journal.credit)}</td>
                    {canWrite ? (
                      <td className={TD_CLASS}>
                        {journal.status === "posted" ? (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => {
                              setReversing(journal);
                              setReverseDate(todayIso());
                              setReverseReason("");
                              clearError();
                            }}
                          >
                            <RotateCcw /> Reverse
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">Reversed</span>
                        )}
                      </td>
                    ) : null}
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

/* ------------------------------------------------------------------ */
/* Trial balance                                                       */
/* ------------------------------------------------------------------ */

export function TrialBalancePanel({ data, openTab }: FinancePanelProps) {
  const trial = data.trialBalance;
  return (
    <Panel
      testId="finance-trial-balance-panel"
      title="Trial balance"
      description="Net debit and credit positions for every account with postings in the selected range."
      action={
        <StatusPill tone={trial?.balanced ? "success" : "danger"}>
          {trial?.balanced ? "Balanced" : "Out of balance"}
        </StatusPill>
      }
    >
      {!trial || trial.rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground" data-testid="finance-trial-empty">
          No postings in this date range. Post a journal to prove the ledger.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS} data-testid="finance-trial-table">
            <thead>
              <tr>
                <th className={TH_CLASS}>Code</th>
                <th className={TH_CLASS}>Account</th>
                <th className={TH_CLASS}>Type</th>
                <th className={`${TH_CLASS} text-right`}>Debit</th>
                <th className={`${TH_CLASS} text-right`}>Credit</th>
                <th className={`${TH_CLASS} text-right`}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {trial.rows.map((row) => (
                <tr key={row.accountId}>
                  <td className={`${TD_CLASS} font-mono`}>{row.code}</td>
                  <td className={TD_CLASS}>{row.name}</td>
                  <td className={`${TD_CLASS} capitalize`}>{row.type}</td>
                  <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{row.debit === "0.00" ? "—" : formatMoney(row.debit)}</td>
                  <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{row.credit === "0.00" ? "—" : formatMoney(row.credit)}</td>
                  <td className={`${TD_CLASS} ${NUMERIC_CLASS} font-medium`}>{formatMoney(row.balance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-muted/50 font-semibold">
                <td className={TD_CLASS} colSpan={3}>Totals</td>
                <td className={`${TD_CLASS} ${NUMERIC_CLASS}`} data-testid="finance-trial-debit-total">{formatMoney(trial.debit)}</td>
                <td className={`${TD_CLASS} ${NUMERIC_CLASS}`} data-testid="finance-trial-credit-total">{formatMoney(trial.credit)}</td>
                <td className={TD_CLASS} />
              </tr>
            </tfoot>
          </table>
          <p className="mt-3 text-xs text-muted-foreground">
            Need detail? Open the{" "}
            <button type="button" className="font-medium text-primary underline" onClick={() => openTab("ledger")}>
              general ledger
            </button>
            .
          </p>
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* General ledger                                                      */
/* ------------------------------------------------------------------ */

export function GeneralLedgerPanel({ data, accountId, onAccountChange }: FinancePanelProps) {
  const ledger = data.generalLedger;
  return (
    <Panel
      testId="finance-general-ledger-panel"
      title="General ledger"
      description="Chronological postings for one account, with a running balance."
      action={
        <select
          className={`${INPUT_CLASS} w-72`}
          value={accountId}
          onChange={(event) => onAccountChange(event.target.value)}
          aria-label="General ledger account"
          data-testid="finance-ledger-account-select"
        >
          <option value="">Select an account…</option>
          {data.accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.code} — {account.name}
            </option>
          ))}
        </select>
      }
    >
      {!accountId ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Choose an account to view its ledger activity.
        </p>
      ) : !ledger ? (
        <p className="py-8 text-center text-sm text-muted-foreground">That account was not found.</p>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">Account</p>
              <p className="mt-0.5 text-sm font-medium">{ledger.account.code} — {ledger.account.name}</p>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">Opening balance</p>
              <p className="mt-0.5 font-mono text-sm tabular-nums">{formatMoney(ledger.openingBalance)}</p>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">Closing balance</p>
              <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{formatMoney(ledger.closingBalance)}</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS} data-testid="finance-ledger-table">
              <thead>
                <tr>
                  <th className={TH_CLASS}>Date</th>
                  <th className={TH_CLASS}>Entry</th>
                  <th className={TH_CLASS}>Description</th>
                  <th className={`${TH_CLASS} text-right`}>Debit</th>
                  <th className={`${TH_CLASS} text-right`}>Credit</th>
                  <th className={`${TH_CLASS} text-right`}>Running balance</th>
                </tr>
              </thead>
              <tbody>
                {ledger.rows.length === 0 ? (
                  <EmptyRow colSpan={6} message="No postings for this account in the selected range." />
                ) : (
                  ledger.rows.map((row) => (
                    <tr key={`${row.entryId}-${row.lineDescription ?? ""}`}>
                      <td className={TD_CLASS}>{formatDate(row.entryDate)}</td>
                      <td className={`${TD_CLASS} font-mono`}>{row.entryNo}</td>
                      <td className={TD_CLASS}>{row.lineDescription || row.description}</td>
                      <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{row.debit === "0.00" ? "—" : formatMoney(row.debit)}</td>
                      <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{row.credit === "0.00" ? "—" : formatMoney(row.credit)}</td>
                      <td className={`${TD_CLASS} ${NUMERIC_CLASS} font-medium`}>{formatMoney(row.runningBalance)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="size-3.5 text-[var(--status-normal)]" aria-hidden="true" />
            Balances use the natural side of the account and never mutate posted rows.
          </p>
        </div>
      )}
    </Panel>
  );
}
