"use client";

import { useState } from "react";
import { toast } from "sonner";

import { postBudgetCommand } from "@/components/finance/budgets-types";

export interface BudgetCommandOutcome {
  ok: boolean;
  result?: unknown;
}

/** Runs a scoped budget command, toasts the outcome and refreshes the workspace. */
export function useBudgetCommand(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(
    command: string,
    input: Record<string, unknown>,
    successMessage: string,
  ): Promise<BudgetCommandOutcome> {
    setBusy(true);
    setError(null);
    try {
      const result = await postBudgetCommand<unknown>(command, input);
      toast.success(successMessage);
      await refresh();
      return { ok: true, result };
    } catch (commandError) {
      const message =
        commandError instanceof Error ? commandError.message : "The command could not be completed";
      setError(message);
      toast.error(message);
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, run, clearError: () => setError(null) };
}
