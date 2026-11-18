import { NextRequest } from "next/server";

import {
  startLabProcessing,
  type StartLabProcessingInput,
} from "@/server/commands/lab";

import { handleLabCommand } from "../_shared";

export async function POST(request: NextRequest) {
  return handleLabCommand<StartLabProcessingInput, unknown>(
    request,
    "Invalid processing request",
    startLabProcessing,
  );
}
