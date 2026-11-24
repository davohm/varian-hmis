import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { QueueBoard } from "@/components/reception/queue-board";
import { Screen } from "@/components/shell/screen";
import { Button } from "@/components/ui/button";
import { requireScreen } from "@/server/auth/guards";

export default async function ReceptionQueuePage() {
  const staff = await requireScreen(["receptionist"]);
  return (
    <Screen
      title="Queue"
      description="Every patient currently waiting, ordered by clinical priority and arrival time."
      testId="screen-reception-queue"
      role={staff.role}
      eyebrow="Front desk · Live queue"
      actions={
        <Button variant="outline" nativeButton={false} render={<Link href="/reception" />}>
          <ArrowLeft aria-hidden="true" />
          Back to front desk
        </Button>
      }
    >
      <QueueBoard />
    </Screen>
  );
}
