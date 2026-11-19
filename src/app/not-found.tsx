import Link from "next/link";
import { FileQuestion } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <div className="w-full max-w-lg">
        <EmptyState
          headingLevel={1}
          icon={FileQuestion}
          title="Page not found"
          description="This page is not available for your facility. Check the address or return to your workspace."
          action={
            <Link
              href="/"
              className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Return to my workspace
            </Link>
          }
        />
      </div>
    </main>
  );
}
