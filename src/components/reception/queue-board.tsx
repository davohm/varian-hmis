"use client";

import { useState } from "react";

import { QueueTable } from "@/components/reception/queue-table";
import { cn } from "@/lib/utils";

const DEPARTMENTS = [
  { value: "Triage", label: "Triage" },
  { value: "Doctor", label: "Consultation" },
] as const;

export function QueueBoard() {
  const [department, setDepartment] = useState<(typeof DEPARTMENTS)[number]["value"]>("Triage");

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Queue department"
        className="inline-flex rounded-lg border border-border bg-card p-1"
      >
        {DEPARTMENTS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={department === item.value}
            onClick={() => setDepartment(item.value)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              department === item.value
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <QueueTable
        department={department}
        title={`${DEPARTMENTS.find((item) => item.value === department)?.label ?? department} queue`}
        testId="reception-queue-board"
      />
    </div>
  );
}
