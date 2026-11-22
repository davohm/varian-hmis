"use client";

import { useState } from "react";
import { toast } from "sonner";

import { postProcurementCommand } from "@/components/procurement/procurement-types";

/** Runs a scoped procurement command, toasts the outcome and refreshes data. */
export function useProcurementCommand(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(
    command: string,
    input: Record<string, unknown>,
    successMessage: string,
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await postProcurementCommand(command, { idempotencyKey: crypto.randomUUID(), ...input });
      toast.success(successMessage);
      await refresh();
      return true;
    } catch (commandError) {
      const message =
        commandError instanceof Error ? commandError.message : "The command could not be completed";
      setError(message);
      toast.error(message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, run, clearError: () => setError(null) };
}
