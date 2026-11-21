"use client";

import { Pencil, ShieldCheck } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import {
  Field,
  INPUT_CLASS,
  Panel,
  StatusPill,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
} from "@/components/finance/finance-primitives";
import {
  formatMoney,
  type FinanceApprovalLimitRow,
  type FinanceData,
} from "@/components/finance/finance-types";
import { useFinanceCommand } from "@/components/finance/use-finance-command";
import { Button } from "@/components/ui/button";
import {
  FINANCE_APPROVAL_ACTIONS,
  FINANCE_APPROVAL_ACTION_LABELS,
  FINANCE_APPROVAL_ROLES,
  FINANCE_APPROVAL_ROLE_LABELS,
  type FinanceApprovalAction,
  type FinanceApprovalRole,
} from "@/lib/finance";

interface ApprovalLimitsPanelProps {
  data: FinanceData;
  refresh: () => Promise<void>;
}

function limitKey(action: FinanceApprovalAction, role: FinanceApprovalRole): string {
  return `${action}:${role}`;
}

export function ApprovalLimitsPanel({ data, refresh }: ApprovalLimitsPanelProps) {
  const { busy, error, run, clearError } = useFinanceCommand(refresh);
  const [action, setAction] = useState<FinanceApprovalAction>("postManualJournal");
  const [role, setRole] = useState<FinanceApprovalRole>("accountant");
  const [maxAmount, setMaxAmount] = useState("");
  const [active, setActive] = useState(true);

  const limitsByKey = useMemo(
    () =>
      new Map(
        data.approvalLimits.map((limit) => [limitKey(limit.action, limit.role), limit] as const),
      ),
    [data.approvalLimits],
  );

  const actionStates = FINANCE_APPROVAL_ACTIONS.map((item) => {
    const limits = data.approvalLimits.filter((limit) => limit.action === item);
    const activeCount = limits.filter((limit) => limit.active).length;
    return { action: item, activeCount, enforced: activeCount > 0 };
  });

  function selectLimit(
    nextAction: FinanceApprovalAction,
    nextRole: FinanceApprovalRole,
    limit?: FinanceApprovalLimitRow,
  ) {
    setAction(nextAction);
    setRole(nextRole);
    setMaxAmount(limit?.maxAmount ?? "");
    setActive(limit?.active ?? true);
    clearError();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await run(
      "setFinanceApprovalLimit",
      { action, role, maxAmount: maxAmount.trim(), active },
      "Approval limit saved",
    );
    if (ok) setMaxAmount("");
  }

  return (
    <Panel
      testId="finance-approval-limits-panel"
      title="Approval limits"
      description="Facility ceilings for manual journal posting and reversal. An action stays unrestricted until an active ceiling exists; once enforced, roles without a limit are blocked."
      action={
        <div className="flex items-center gap-2">
          <StatusPill tone="info">Admin only</StatusPill>
          <span className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            {data.approvalLimits.length} configured
          </span>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {actionStates.map(({ action: item, activeCount, enforced }) => (
            <div
              key={item}
              data-testid={`finance-approval-state-${item}`}
              className="rounded-lg border border-border bg-background px-3 py-2.5"
            >
              <div className="flex items-start gap-3">
                <span
                  className={`grid size-8 shrink-0 place-items-center rounded-lg ${
                    enforced
                      ? "bg-[var(--status-normal-background)] text-[var(--status-normal-foreground)]"
                      : "bg-muted text-muted-foreground"
                  }`}
                  aria-hidden="true"
                >
                  <ShieldCheck className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-[0.65rem] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
                    {FINANCE_APPROVAL_ACTION_LABELS[item]}
                  </p>
                  <p className="mt-0.5 text-sm font-semibold text-foreground">
                    {enforced ? "Ceiling enforced" : "Unrestricted"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {enforced
                      ? `${activeCount} active role${activeCount === 1 ? "" : "s"} configured`
                      : "No active ceiling; the existing flow remains open"}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="overflow-x-auto">
          <table className={TABLE_CLASS} data-testid="finance-approval-limits-matrix">
            <thead>
              <tr>
                <th className={TH_CLASS}>Role</th>
                {FINANCE_APPROVAL_ACTIONS.map((item) => (
                  <th key={item} className={TH_CLASS}>
                    {FINANCE_APPROVAL_ACTION_LABELS[item]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FINANCE_APPROVAL_ROLES.map((itemRole) => (
                <tr key={itemRole} data-testid={`finance-approval-role-${itemRole}`}>
                  <td className={`${TD_CLASS} font-medium`}>
                    {FINANCE_APPROVAL_ROLE_LABELS[itemRole]}
                  </td>
                  {FINANCE_APPROVAL_ACTIONS.map((itemAction) => {
                    const limit = limitsByKey.get(limitKey(itemAction, itemRole));
                    const tone: "neutral" | "success" | "warning" = !limit
                      ? "neutral"
                      : limit.active
                        ? "success"
                        : "warning";
                    const stateLabel = !limit ? "Not set" : limit.active ? "Active" : "Inactive";
                    const actionLabel = FINANCE_APPROVAL_ACTION_LABELS[itemAction];
                    const roleLabel = FINANCE_APPROVAL_ROLE_LABELS[itemRole];

                    return (
                      <td key={itemAction} className={TD_CLASS}>
                        <div className="flex min-w-48 flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            {limit ? (
                              <p className="font-mono text-sm font-semibold tabular-nums text-foreground">
                                {formatMoney(limit.maxAmount)}
                              </p>
                            ) : (
                              <p className="text-sm text-muted-foreground">—</p>
                            )}
                            <div className="mt-1">
                              <StatusPill tone={tone}>{stateLabel}</StatusPill>
                            </div>
                          </div>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => selectLimit(itemAction, itemRole, limit)}
                            aria-label={`${limit ? "Edit" : "Set"} ${roleLabel} limit for ${actionLabel}`}
                          >
                            <Pencil />
                            {limit ? "Edit" : "Set"}
                          </Button>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-foreground">Configure a ceiling</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                No amount is prefilled. Enter the value approved for this facility.
              </p>
            </div>
            <StatusPill tone="neutral">
              {FINANCE_APPROVAL_ROLE_LABELS[role]} · {FINANCE_APPROVAL_ACTION_LABELS[action]}
            </StatusPill>
          </div>

          <form onSubmit={(event) => void submit(event)} className="mt-3 space-y-3" data-testid="finance-approval-limit-form">
            <Field label="Action" className="max-w-sm">
              <select
                className={INPUT_CLASS}
                value={action}
                onChange={(event) => setAction(event.target.value as FinanceApprovalAction)}
                data-testid="finance-approval-limit-action"
              >
                {FINANCE_APPROVAL_ACTIONS.map((item) => (
                  <option key={item} value={item}>
                    {FINANCE_APPROVAL_ACTION_LABELS[item]}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Role" className="max-w-sm">
              <select
                className={INPUT_CLASS}
                value={role}
                onChange={(event) => setRole(event.target.value as FinanceApprovalRole)}
                data-testid="finance-approval-limit-role"
              >
                {FINANCE_APPROVAL_ROLES.map((item) => (
                  <option key={item} value={item}>
                    {FINANCE_APPROVAL_ROLE_LABELS[item]}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Maximum amount"
              hint="Positive amount in KES. This value is saved only when you submit."
              className="max-w-56"
            >
              <input
                className={INPUT_CLASS}
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                value={maxAmount}
                onChange={(event) => setMaxAmount(event.target.value)}
                placeholder="Enter amount"
                required
                data-testid="finance-approval-limit-amount"
              />
            </Field>

            <div>
              <label className="flex w-fit items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(event) => setActive(event.target.checked)}
                  className="size-4 accent-[var(--brand-navy)]"
                  data-testid="finance-approval-limit-active"
                />
                <span>Active — enforce this ceiling</span>
              </label>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">
                Turn this off to keep the recorded ceiling without restricting postings.
              </p>
            </div>

            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" disabled={busy} data-testid="finance-approval-limit-save">
                Save limit
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => selectLimit(action, role)}
              >
                Clear amount
              </Button>
            </div>
          </form>
        </div>
      </div>
    </Panel>
  );
}
