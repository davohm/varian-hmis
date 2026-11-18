import { NextRequest } from "next/server";

import { enterLabResults, type EnterLabResultsInput } from "@/server/commands/lab";

import { handleLabCommand } from "../_shared";

export async function POST(request: NextRequest) {
  return handleLabCommand<EnterLabResultsInput, unknown>(
    request,
    "Invalid result entry request",
    enterLabResults,
  );
}
