"use client";

import { Plus } from "lucide-react";
import { useState, type FormEvent } from "react";

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
} from "@/components/finance/finance-types";
import { useFinanceCommand } from "@/components/finance/use-finance-command";
import { Button } from "@/components/ui/button";

export function BankingPanel({ data, canWrite, refresh }: FinancePanelProps) {
  const { busy, error, run, clearError } = useFinanceCommand(refresh);
  const [form, setForm] = useState<"account" | "transaction" | "reconciliation" | null>(null);

  const [accountName, setAccountName] = useState("");
  const [accountKind, setAccountKind] = useState("bank");
  const [accountNumber, setAccountNumber] = useState("");
  const [currency, setCurrency] = useState("KES");
  const [ledgerAccountId, setLedgerAccountId] = useState("");
  const [openingBalance, setOpeningBalance] = useState("0.00");

  const [txnAccountId, setTxnAccountId] = useState("");
  const [txnDate, setTxnDate] = useState(todayIso());
  const [txnDescription, setTxnDescription] = useState("");
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");

  const [reconAccountId, setReconAccountId] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [statementBalance, setStatementBalance] = useState("");
  const [note, setNote] = useState("");

  const assetAccounts = data.accounts.filter((account) => account.type === "asset");
  const accountNameById = new Map(data.bankAccounts.map((account) => [account.id, account.name]));

  function openForm(next: typeof form) {
    setForm((current) => (current === next ? null : next));
    clearError();
  }

  async function submitAccount(event: FormEvent) {
    event.preventDefault();
    const ok = await run(
      "createBankAccount",
      {
        name: accountName,
        kind: accountKind,
        accountNumber: accountNumber.trim() || null,
        currency,
        ledgerAccountId,
        openingBalance: openingBalance || "0.00",
      },
      "Bank account created",
    );
    if (ok) {
      setForm(null);
      setAccountName("");
      setAccountNumber("");
      setOpeningBalance("0.00");
    }
  }

  async function submitTransaction(event: FormEvent) {
    event.preventDefault();
    const ok = await run(
      "recordBankTransaction",
      {
        bankAccountId: txnAccountId,
        txnDate,
        description: txnDescription,
        direction,
        amount,
        reference: reference.trim() || null,
      },
      "Bank transaction recorded",
    );
    if (ok) {
      setForm(null);
      setTxnDescription("");
      setAmount("");
      setReference("");
    }
  }

  async function submitReconciliation(event: FormEvent) {
    event.preventDefault();
    const ok = await run(
      "openBankReconciliation",
      { bankAccountId: reconAccountId, periodStart, periodEnd, statementBalance, note: note.trim() || null },
      "Reconciliation opened",
    );
    if (ok) {
      setForm(null);
      setPeriodStart("");
      setPeriodEnd("");
      setStatementBalance("");
      setNote("");
    }
  }

  return (
    <div className="space-y-4">
      <Panel
        testId="finance-bank-accounts-panel"
        title="Bank accounts"
        description="Bank and cash accounts linked to an asset ledger account."
        action={
          canWrite ? (
            <Button size="sm" onClick={() => openForm("account")}>
              <Plus /> New account
            </Button>
          ) : null
        }
      >
        {form === "account" && canWrite ? (
          <form
            onSubmit={(event) => void submitAccount(event)}
            className="mb-4 grid gap-3 rounded-lg border border-border bg-muted/40 p-3 md:grid-cols-3"
            data-testid="finance-bank-account-form"
          >
            <Field label="Account name">
              <input className={INPUT_CLASS} value={accountName} onChange={(event) => setAccountName(event.target.value)} required />
            </Field>
            <Field label="Kind">
              <select className={INPUT_CLASS} value={accountKind} onChange={(event) => setAccountKind(event.target.value)}>
                <option value="bank">Bank</option>
                <option value="mpesa">M-Pesa</option>
                <option value="cash">Cash</option>
                <option value="petty_cash">Petty cash</option>
              </select>
            </Field>
            <Field label="Account number">
              <input className={INPUT_CLASS} value={accountNumber} onChange={(event) => setAccountNumber(event.target.value)} placeholder="Optional" />
            </Field>
            <Field label="Currency">
              <input className={INPUT_CLASS} value={currency} onChange={(event) => setCurrency(event.target.value)} maxLength={8} />
            </Field>
            <Field label="Ledger account" hint="Must be an asset account">
              <select className={INPUT_CLASS} value={ledgerAccountId} onChange={(event) => setLedgerAccountId(event.target.value)} required>
                <option value="">Select account…</option>
                {assetAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {account.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Opening balance">
              <input className={INPUT_CLASS} inputMode="decimal" value={openingBalance} onChange={(event) => setOpeningBalance(event.target.value)} />
            </Field>
            {error ? <p role="alert" className="text-xs text-destructive md:col-span-3">{error}</p> : null}
            <div className="flex gap-2 md:col-span-3">
              <Button type="submit" size="sm" disabled={busy}>Create account</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setForm(null)}>Cancel</Button>
            </div>
          </form>
        ) : null}
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS} data-testid="finance-bank-accounts-table">
            <thead>
              <tr>
                <th className={TH_CLASS}>Account</th>
                <th className={TH_CLASS}>Kind</th>
                <th className={TH_CLASS}>Number</th>
                <th className={TH_CLASS}>Ledger</th>
                <th className={`${TH_CLASS} text-right`}>Opening</th>
                <th className={`${TH_CLASS} text-right`}>Ledger balance</th>
                <th className={TH_CLASS}>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.bankAccounts.length === 0 ? (
                <EmptyRow colSpan={7} message="No bank accounts linked yet." />
              ) : (
                data.bankAccounts.map((account) => (
                  <tr key={account.id}>
                    <td className={`${TD_CLASS} font-medium`}>{account.name}</td>
                    <td className={`${TD_CLASS} capitalize`}>{account.kind}</td>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{account.accountNumber ?? "—"}</td>
                    <td className={`${TD_CLASS} font-mono text-xs`}>{account.ledgerAccountCode}</td>
                    <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{formatMoney(account.openingBalance, account.currency)}</td>
                    <td className={`${TD_CLASS} ${NUMERIC_CLASS} font-medium`}>{formatMoney(account.ledgerBalance, account.currency)}</td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={account.active ? "success" : "neutral"}>
                        {account.active ? "Active" : "Inactive"}
                      </StatusPill>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        testId="finance-bank-transactions-panel"
        title="Bank transactions"
        description="Money in and out of the accounts above. Negative amounts are payments out."
        action={
          canWrite ? (
            <Button size="sm" variant="outline" onClick={() => openForm("transaction")}>
              <Plus /> Record transaction
            </Button>
          ) : null
        }
      >
        {form === "transaction" && canWrite ? (
          <form
            onSubmit={(event) => void submitTransaction(event)}
            className="mb-4 grid gap-3 rounded-lg border border-border bg-muted/40 p-3 md:grid-cols-3"
            data-testid="finance-bank-transaction-form"
          >
            <Field label="Bank account">
              <select className={INPUT_CLASS} value={txnAccountId} onChange={(event) => setTxnAccountId(event.target.value)} required>
                <option value="">Select account…</option>
                {data.bankAccounts.map((account) => (
                  <option key={account.id} value={account.id}>{account.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Date">
              <input type="date" className={INPUT_CLASS} value={txnDate} onChange={(event) => setTxnDate(event.target.value)} required />
            </Field>
            <Field label="Direction">
              <select className={INPUT_CLASS} value={direction} onChange={(event) => setDirection(event.target.value as "in" | "out")}>
                <option value="in">Money in</option>
                <option value="out">Money out</option>
              </select>
            </Field>
            <Field label="Description">
              <input className={INPUT_CLASS} value={txnDescription} onChange={(event) => setTxnDescription(event.target.value)} required />
            </Field>
            <Field label="Amount">
              <input className={INPUT_CLASS} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" required />
            </Field>
            <Field label="Reference">
              <input className={INPUT_CLASS} value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Optional" />
            </Field>
            {error ? <p role="alert" className="text-xs text-destructive md:col-span-3">{error}</p> : null}
            <div className="flex gap-2 md:col-span-3">
              <Button type="submit" size="sm" disabled={busy}>Record transaction</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setForm(null)}>Cancel</Button>
            </div>
          </form>
        ) : null}
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS} data-testid="finance-bank-transactions-table">
            <thead>
              <tr>
                <th className={TH_CLASS}>Date</th>
                <th className={TH_CLASS}>Account</th>
                <th className={TH_CLASS}>Description</th>
                <th className={TH_CLASS}>Reference</th>
                <th className={`${TH_CLASS} text-right`}>Amount</th>
                <th className={TH_CLASS}>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.bankTransactions.length === 0 ? (
                <EmptyRow colSpan={6} message="No bank transactions recorded." />
              ) : (
                data.bankTransactions.map((transaction) => {
                  const outgoing = Number(transaction.amount) < 0;
                  return (
                    <tr key={transaction.id}>
                      <td className={TD_CLASS}>{formatDate(transaction.txnDate)}</td>
                      <td className={TD_CLASS}>{accountNameById.get(transaction.bankAccountId) ?? "—"}</td>
                      <td className={TD_CLASS}>{transaction.description}</td>
                      <td className={`${TD_CLASS} font-mono text-xs`}>{transaction.reference ?? "—"}</td>
                      <td className={`${TD_CLASS} ${NUMERIC_CLASS} ${outgoing ? "text-[var(--status-critical)]" : ""}`}>
                        {outgoing ? "−" : ""}{formatMoney(Math.abs(Number(transaction.amount)).toFixed(2))}
                      </td>
                      <td className={TD_CLASS}>
                        <StatusPill tone={transaction.reconciled ? "success" : "warning"}>
                          {transaction.reconciled ? "Reconciled" : "Pending"}
                        </StatusPill>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        testId="finance-reconciliations-panel"
        title="Bank reconciliations"
        description="Compare the statement balance with the linked ledger balance and close the difference."
        action={
          canWrite ? (
            <Button size="sm" variant="outline" onClick={() => openForm("reconciliation")}>
              <Plus /> New reconciliation
            </Button>
          ) : null
        }
      >
        {form === "reconciliation" && canWrite ? (
          <form
            onSubmit={(event) => void submitReconciliation(event)}
            className="mb-4 grid gap-3 rounded-lg border border-border bg-muted/40 p-3 md:grid-cols-3"
            data-testid="finance-reconciliation-form"
          >
            <Field label="Bank account">
              <select className={INPUT_CLASS} value={reconAccountId} onChange={(event) => setReconAccountId(event.target.value)} required>
                <option value="">Select account…</option>
                {data.bankAccounts.map((account) => (
                  <option key={account.id} value={account.id}>{account.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Period start">
              <input type="date" className={INPUT_CLASS} value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} required />
            </Field>
            <Field label="Period end">
              <input type="date" className={INPUT_CLASS} value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} required />
            </Field>
            <Field label="Statement balance">
              <input className={INPUT_CLASS} inputMode="decimal" value={statementBalance} onChange={(event) => setStatementBalance(event.target.value)} placeholder="0.00" required />
            </Field>
            <Field label="Note" className="md:col-span-2">
              <input className={INPUT_CLASS} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional" />
            </Field>
            {error ? <p role="alert" className="text-xs text-destructive md:col-span-3">{error}</p> : null}
            <div className="flex gap-2 md:col-span-3">
              <Button type="submit" size="sm" disabled={busy}>Open reconciliation</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setForm(null)}>Cancel</Button>
            </div>
          </form>
        ) : null}
        <div className="overflow-x-auto">
          <table className={TABLE_CLASS} data-testid="finance-reconciliations-table">
            <thead>
              <tr>
                <th className={TH_CLASS}>Account</th>
                <th className={TH_CLASS}>Period</th>
                <th className={`${TH_CLASS} text-right`}>Statement</th>
                <th className={`${TH_CLASS} text-right`}>Ledger</th>
                <th className={`${TH_CLASS} text-right`}>Difference</th>
                <th className={TH_CLASS}>Status</th>
                {canWrite ? <th className={TH_CLASS}>Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.reconciliations.length === 0 ? (
                <EmptyRow colSpan={canWrite ? 7 : 6} message="No reconciliations opened yet." />
              ) : (
                data.reconciliations.map((reconciliation) => (
                  <tr key={reconciliation.id}>
                    <td className={TD_CLASS}>{reconciliation.bankAccountName}</td>
                    <td className={TD_CLASS}>
                      {formatDate(reconciliation.periodStart)} – {formatDate(reconciliation.periodEnd)}
                    </td>
                    <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{formatMoney(reconciliation.statementBalance)}</td>
                    <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{formatMoney(reconciliation.ledgerBalance)}</td>
                    <td className={`${TD_CLASS} ${NUMERIC_CLASS}`}>{formatMoney(reconciliation.difference)}</td>
                    <td className={TD_CLASS}>
                      <StatusPill tone={reconciliation.status === "completed" ? "success" : "warning"}>
                        {reconciliation.status}
                      </StatusPill>
                    </td>
                    {canWrite ? (
                      <td className={TD_CLASS}>
                        {reconciliation.status === "open" ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                "completeBankReconciliation",
                                { reconciliationId: reconciliation.id },
                                "Reconciliation completed",
                              )
                            }
                          >
                            Complete
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">Closed</span>
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
