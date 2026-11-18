import { NextRequest } from "next/server";

import {
  collectLabSample,
  type CollectLabSampleInput,
} from "@/server/commands/lab";

import { handleLabCommand } from "../_shared";

export async function POST(request: NextRequest) {
  return handleLabCommand<CollectLabSampleInput, unknown>(
    request,
    "Invalid sample collection request",
    collectLabSample,
  );
}
