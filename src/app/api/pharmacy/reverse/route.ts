import { NextRequest } from "next/server";

import { reverseDispense, type ReverseDispenseInput } from "@/server/commands/pharmacy";

import { handlePharmacyCommand } from "../_shared";

export async function POST(request: NextRequest) {
  return handlePharmacyCommand<ReverseDispenseInput, unknown>(
    request,
    "Invalid dispense reversal",
    reverseDispense,
  );
}
