import { NextRequest } from "next/server";

import {
  closeCashierSession,
  type CloseCashierSessionInput,
} from "@/server/commands/billing";

import { handleCashierCommand } from "../../_shared";

export async function POST(request: NextRequest) {
  return handleCashierCommand<CloseCashierSessionInput, unknown>(
    request,
    "Invalid session close",
    closeCashierSession,
  );
}
