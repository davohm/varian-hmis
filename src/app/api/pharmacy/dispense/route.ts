import { NextRequest } from "next/server";

import {
  dispensePrescription,
  type DispensePrescriptionInput,
} from "@/server/commands/pharmacy";

import { handlePharmacyCommand } from "../_shared";

export async function POST(request: NextRequest) {
  return handlePharmacyCommand<DispensePrescriptionInput, unknown>(
    request,
    "Invalid dispense",
    dispensePrescription,
  );
}
