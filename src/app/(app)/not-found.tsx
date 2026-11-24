import Link from "next/link";
import { FileQuestion } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function AppNotFound() {
  return (
    <div className="mx-auto w-full max-w-3xl py-8">
      <EmptyState
        headingLevel={1}
        icon={FileQuestion}
        title="Page not found"
        description="This workspace page is unavailable or the address is incorrect. Return to your role workspace to continue."
        action={
          <Link href="/" className={cn(buttonVariants())}>
            Return to workspace
          </Link>
        }
      />
    </div>
  );
}
