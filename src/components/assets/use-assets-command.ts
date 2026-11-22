"use client";

import { useState } from "react";
import { toast } from "sonner";

import { postAssetsCommand } from "@/components/assets/assets-types";

/** Runs a scoped asset command, toasts the outcome and refreshes data. */
export function useAssetsCommand(refresh: () => Promise<void>) {
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
      await postAssetsCommand(command, { idempotencyKey: crypto.randomUUID(), ...input });
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
