import Link from "next/link";

import { Screen } from "@/components/shell/screen";
import { requireScreen } from "@/server/auth/guards";

export default async function ForbiddenPage() {
  await requireScreen([]);
  return (
    <Screen
      title="Access denied"
      description="Your role does not have permission to open this screen."
      testId="screen-forbidden"
    >
      <div className="border border-border bg-card p-8">
        <p className="text-sm text-muted-foreground">
          Choose a workspace from the navigation or contact an administrator if you need access.
        </p>
        <Link
          href="/"
          className="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Return to my workspace
        </Link>
      </div>
    </Screen>
  );
}
